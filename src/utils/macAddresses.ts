/**
 * src/utils/macAddresses.ts
 *
 * Helpers for working with the AssetMacAddress side table that replaced
 * the legacy `Asset.macAddresses` JSONB column.
 *
 * Two surfaces:
 *
 *   - `shapeMacRows(rows)` — convert side-table rows to the JSON shape the
 *     API response and the discovery code's in-memory pipeline both expect.
 *     Sorted by lastSeen desc to mirror the prior code's sort, which
 *     several call sites (notably the device-inventory + DHCP merges and
 *     the asset details panel) rely on for "most-recent MAC first".
 *
 *   - `reconcileMacAddresses(client, assetId, macs)` — reconcile an in-
 *     memory MAC list back to the side table. Discovery code that builds a
 *     macList in-memory (loading the existing rows, modifying, writing
 *     back) calls this at end of asset write to sync the table. Implemented
 *     as a single `$transaction` of [deleteMany missing-from-list + per-mac
 *     upsert]; one network round-trip regardless of list size.
 */

import { prisma } from "../db.js";

export interface MacJsonEntry {
  mac: string;
  lastSeen: string;
  source?: string;
  device?: string;
  subnetCidr?: string;
  subnetName?: string;
}

export interface MacRow {
  mac: string;
  source: string;
  device: string | null;
  subnetCidr: string | null;
  subnetName: string | null;
  lastSeen: Date;
  firstSeen: Date;
}

export const MAC_ROW_SELECT = {
  mac: true, source: true, device: true, subnetCidr: true, subnetName: true,
  lastSeen: true, firstSeen: true,
} as const;

/**
 * Convert side-table rows to the JSON shape the legacy code expected.
 * Sorted by lastSeen desc so the first entry is always the most recently
 * seen MAC — mirrors `macList.sort((a,b) => new Date(b.lastSeen) - ...)`
 * pattern that was scattered across discovery code.
 */
export function shapeMacRows(rows: readonly MacRow[] | null | undefined): MacJsonEntry[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice()
    .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
    .map((r) => {
      const out: MacJsonEntry = {
        mac: r.mac,
        lastSeen: r.lastSeen.toISOString(),
        source: r.source,
      };
      if (r.device)     out.device     = r.device;
      if (r.subnetCidr) out.subnetCidr = r.subnetCidr;
      if (r.subnetName) out.subnetName = r.subnetName;
      return out;
    });
}

/**
 * Sync an in-memory MAC list (the legacy JSON shape) back to the side
 * table for one asset. Used at end of any flow that previously did
 * `data.macAddresses = macList` on an asset.update.
 *
 *   - Rows in the side table that are NOT in `macs` get deleted
 *   - Each entry in `macs` is upserted (insert if missing, update metadata
 *     if present) via a single bulk INSERT ... ON CONFLICT statement
 *
 * Two round-trips total per call (delete + bulk upsert). The original
 * implementation wrapped a deleteMany + N per-row upserts in a
 * `$transaction` — for an asset with 50 MACs that meant 51 sequential
 * statements inside one transaction, easily exceeding Prisma's 5-second
 * default timeout once batchSettled was running ~50 reconciles in
 * parallel and the connection pool started backing up. The bulk SQL form
 * collapses N upserts into one statement; no transaction overhead, no
 * pool contention.
 *
 * Trade-off: there's a brief window between the delete and the upsert
 * where a concurrent reader could see a partial set. Acceptable for
 * monitor-source MAC data — discovery doesn't read its own write mid-
 * pass, and external readers (asset details panel, quarantine push) are
 * not running during a discovery sync.
 */
export async function reconcileMacAddresses(
  assetId: string,
  macs: readonly MacJsonEntry[],
): Promise<void> {
  // Sort by mac asc so concurrent reconciles for different assets acquire
  // index-page locks in a deterministic order — significantly cuts the
  // deadlock rate Postgres reports on the secondary `mac` index pages
  // when batchSettled runs ~50 reconciles in parallel during a discovery
  // sync. Sort is in-place safe because we built the array from a copy.
  const newMacs = macs
    .filter((m) => !!m.mac)
    .slice()
    .sort((a, b) => (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0));

  // Empty list = wipe all MAC rows for this asset.
  if (newMacs.length === 0) {
    await retryOnDeadlock(() =>
      prisma.assetMacAddress.deleteMany({ where: { assetId } }),
    );
    return;
  }

  // Delete any existing rows whose mac isn't in the new set. One statement
  // regardless of row count.
  await retryOnDeadlock(() =>
    prisma.assetMacAddress.deleteMany({
      where: { assetId, mac: { notIn: newMacs.map((m) => m.mac) } },
    }),
  );

  // Bulk upsert via INSERT ... ON CONFLICT. Build a flat parameter list and
  // parallel VALUES tuples; the (assetId, mac) unique index drives the
  // upsert path. id uses gen_random_uuid() (Postgres 13+ built-in) so we
  // don't have to round-trip per row to generate UUIDs in JS.
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  for (const m of newMacs) {
    const lastSeen = m.lastSeen ? new Date(m.lastSeen).toISOString() : new Date().toISOString();
    tuples.push(
      `(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::timestamp, $${p++}::timestamp)`,
    );
    params.push(
      assetId,
      m.mac,
      m.source || "unknown",
      m.device ?? null,
      m.subnetCidr ?? null,
      m.subnetName ?? null,
      lastSeen,
      lastSeen,
    );
  }
  const sql =
    `INSERT INTO "asset_mac_addresses" ("id", "assetId", "mac", "source", "device", "subnetCidr", "subnetName", "lastSeen", "firstSeen") ` +
    `VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("assetId", "mac") DO UPDATE SET ` +
    `  "source" = EXCLUDED."source", ` +
    `  "device" = EXCLUDED."device", ` +
    `  "subnetCidr" = EXCLUDED."subnetCidr", ` +
    `  "subnetName" = EXCLUDED."subnetName", ` +
    `  "lastSeen" = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
}

/**
 * Wrap a single Prisma operation with retry-on-deadlock semantics. Postgres
 * reports SQLSTATE 40P01 when it breaks a deadlock cycle by aborting one
 * participant; the abort is intrinsic to the protocol, not a bug in our
 * code. Re-running the same statement after the contender finishes
 * almost always succeeds.
 *
 * Up to 3 retries with a small jittered backoff so simultaneous deadlock
 * losers don't all retry in lockstep. Surfaces the error untouched on the
 * 4th failure so callers (discovery sync's batchSettled) can record it
 * exactly as before.
 */
async function retryOnDeadlock<T>(op: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await op();
    } catch (err: unknown) {
      const code = extractPgCode(err);
      if (code !== "40P01") throw err;
      lastErr = err;
      const backoffMs = 25 + Math.floor(Math.random() * 75);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

function extractPgCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  // Prisma surfaces driver errors with the original SQLSTATE under a few
  // possible paths depending on the adapter version. Be defensive about
  // the shape so we don't accidentally swallow non-deadlock errors.
  const e = err as Record<string, unknown>;
  const direct = typeof e.code === "string" ? e.code : null;
  if (direct === "40P01") return "40P01";
  const meta = e.meta as Record<string, unknown> | undefined;
  if (meta) {
    const adapterErr = meta.driverAdapterError as Record<string, unknown> | undefined;
    const cause = adapterErr?.cause as Record<string, unknown> | undefined;
    const originalCode = cause?.originalCode as string | undefined;
    if (originalCode === "40P01") return "40P01";
    const causeCode = cause?.code as string | undefined;
    if (causeCode === "40P01") return "40P01";
  }
  // Last-resort fallback — error messages mention "deadlock detected" too.
  const msg = typeof e.message === "string" ? e.message : "";
  if (msg.includes("deadlock detected")) return "40P01";
  return null;
}

/**
 * Helper for the create-time path: convert a list of MAC entries into the
 * `macAddressRows.create` array Prisma expects on a nested create. Avoids
 * a separate post-create reconcile call when the asset is brand new.
 */
export function buildMacRowsForCreate(
  macs: readonly MacJsonEntry[],
): Array<{
  mac: string; source: string; device: string | null;
  subnetCidr: string | null; subnetName: string | null;
  lastSeen: Date; firstSeen: Date;
}> {
  return macs
    .filter((m) => !!m.mac)
    .map((m) => {
      const lastSeen = m.lastSeen ? new Date(m.lastSeen) : new Date();
      return {
        mac: m.mac,
        source: m.source || "unknown",
        device: m.device ?? null,
        subnetCidr: m.subnetCidr ?? null,
        subnetName: m.subnetName ?? null,
        lastSeen,
        firstSeen: lastSeen,
      };
    });
}
