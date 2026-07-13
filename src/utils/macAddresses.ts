/**
 * src/utils/macAddresses.ts
 *
 * Helpers for working with the AssetMacAddress side table that replaced
 * the legacy `Asset.macAddresses` JSONB column.
 *
 * Three surfaces:
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
 *     upsert]; one network round-trip regardless of list size. Never touches
 *     interface-fold rows (source="monitor-interface") — those are owned by:
 *
 *   - `reconcileInterfaceMacs(assetId, macs)` — the interface-scrape fold:
 *     every scraped interface MAC (monitored or not), coalesced into
 *     contiguous `[mac, macEnd]` RANGE rows via `foldMacsToRanges` so a
 *     48-port switch stores one row, source-scoped full-replace. Range rows
 *     are searchable per-MAC via lexicographic containment (see
 *     searchService) and expandable via `expandMacRange` for in-memory
 *     MAC→asset indexes (LLDP match, quarantine push).
 */

import { prisma } from "../db.js";
import { retryOnDeadlock } from "./dbRetry.js";

export interface MacJsonEntry {
  mac: string;
  lastSeen: string;
  source?: string;
  device?: string;
  subnetCidr?: string;
  subnetName?: string;
  /** Inclusive range end — set only on interface-fold range rows. */
  macEnd?: string;
}

export interface MacRow {
  mac: string;
  macEnd: string | null;
  source: string;
  device: string | null;
  subnetCidr: string | null;
  subnetName: string | null;
  lastSeen: Date;
  firstSeen: Date;
}

export const MAC_ROW_SELECT = {
  mac: true, macEnd: true, source: true, device: true, subnetCidr: true, subnetName: true,
  lastSeen: true, firstSeen: true,
} as const;

/**
 * The source value stamped on rows written by the interface-scrape fold
 * (`reconcileInterfaceMacs`). Rows with this source — the only rows that can
 * carry a `macEnd` range — are OWNED by the fold: `reconcileMacAddresses`
 * (the discovery full-replace) never deletes or re-inserts them.
 */
export const INTERFACE_MAC_SOURCE = "monitor-interface";

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
      if (r.macEnd)     out.macEnd     = r.macEnd;
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
  // Interface-fold rows (source="monitor-interface", the only rows that can
  // carry a macEnd range) are owned by `reconcileInterfaceMacs` — drop them
  // from the input (discovery hydrates them into its in-memory list) and
  // scope every delete below away from them, so a discovery reconcile can
  // neither churn a range row through its single-MAC upsert nor delete one.
  //
  // Sort by mac asc so concurrent reconciles for different assets acquire
  // index-page locks in a deterministic order — significantly cuts the
  // deadlock rate Postgres reports on the secondary `mac` index pages
  // when batchSettled runs ~50 reconciles in parallel during a discovery
  // sync. Sort is in-place safe because we built the array from a copy.
  const newMacs = macs
    .filter((m) => !!m.mac && m.source !== INTERFACE_MAC_SOURCE)
    .slice()
    .sort((a, b) => (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0));

  // Empty list = wipe all non-interface-fold MAC rows for this asset.
  if (newMacs.length === 0) {
    await retryOnDeadlock(() =>
      prisma.assetMacAddress.deleteMany({
        where: { assetId, source: { not: INTERFACE_MAC_SOURCE } },
      }),
    );
    return;
  }

  // Delete any existing rows whose mac isn't in the new set. One statement
  // regardless of row count.
  await retryOnDeadlock(() =>
    prisma.assetMacAddress.deleteMany({
      where: {
        assetId,
        source: { not: INTERFACE_MAC_SOURCE },
        mac: { notIn: newMacs.map((m) => m.mac) },
      },
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
  // On conflict, "macEnd" = NULL: discovery rows are always single-MAC. The
  // only way this fires against a range row is a discovery sighting of the
  // range's start MAC — the range coherently collapses to that single MAC
  // under the discovery source, and the next interface scrape re-adds the
  // remainder of the range starting one past it (see reconcileInterfaceMacs'
  // occupied-key adjustment).
  const sql =
    `INSERT INTO "asset_mac_addresses" ("id", "assetId", "mac", "source", "device", "subnetCidr", "subnetName", "lastSeen", "firstSeen") ` +
    `VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("assetId", "mac") DO UPDATE SET ` +
    `  "macEnd" = NULL, ` +
    `  "source" = EXCLUDED."source", ` +
    `  "device" = EXCLUDED."device", ` +
    `  "subnetCidr" = EXCLUDED."subnetCidr", ` +
    `  "subnetName" = EXCLUDED."subnetName", ` +
    `  "lastSeen" = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
}

/**
 * Normalize a MAC to canonical upper-colon form ("AA:BB:CC:DD:EE:FF"), the
 * shape every row in this side table is stored as. Returns null for anything
 * that isn't exactly 12 hex digits. Kept dependency-free (no import of the
 * service-layer normalizers) so this util stays a leaf module.
 */
function macColonUpper(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = String(mac).replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(":");
}

// 48-bit MAC ↔ integer. 2^48 < 2^53, so plain JS numbers are exact.
function macToInt(mac: string): number {
  return parseInt(mac.replace(/:/g, ""), 16);
}
function intToMac(n: number): string {
  return n.toString(16).padStart(12, "0").toUpperCase().match(/.{2}/g)!.join(":");
}

/** One folded entry: a single MAC (macEnd null) or an inclusive range. */
export interface MacRangeEntry {
  mac: string;
  macEnd: string | null;
}

/**
 * Normalize + dedupe a MAC list and coalesce numerically-contiguous runs into
 * inclusive ranges. Switch/AP/firewall ports typically carry sequentially-
 * allocated MACs off one base, so a 48-port switch folds to a single
 * `{mac, macEnd}` entry; isolated MACs stay single entries (macEnd null).
 * Invalid entries are skipped. Output is sorted ascending.
 */
export function foldMacsToRanges(
  macs: ReadonlyArray<string | null | undefined>,
): MacRangeEntry[] {
  const ints = Array.from(
    new Set(
      macs
        .map((m) => macColonUpper(m))
        .filter((m): m is string => m !== null)
        .map(macToInt),
    ),
  ).sort((a, b) => a - b);
  const out: MacRangeEntry[] = [];
  let i = 0;
  while (i < ints.length) {
    let j = i;
    while (j + 1 < ints.length && ints[j + 1] === ints[j] + 1) j++;
    out.push({
      mac: intToMac(ints[i]),
      macEnd: j > i ? intToMac(ints[j]) : null,
    });
    i = j + 1;
  }
  return out;
}

/**
 * Expand a range row back into individual MACs, capped so a pathological
 * range can't blow up an in-memory index. Single rows (macEnd null/absent)
 * return just [mac]. Invalid bounds return [].
 */
export function expandMacRange(
  mac: string,
  macEnd: string | null | undefined,
  cap = 256,
): string[] {
  const start = macColonUpper(mac);
  if (!start) return [];
  const end = macEnd ? macColonUpper(macEnd) : null;
  if (!end || end === start) return [start];
  const s = macToInt(start);
  const e = macToInt(end);
  if (e < s) return [start];
  const n = Math.min(e - s + 1, cap);
  const out: string[] = new Array(n);
  for (let k = 0; k < n; k++) out[k] = intToMac(s + k);
  return out;
}

/**
 * Reconcile the asset's interface-derived MAC rows (source =
 * "monitor-interface") to the given scraped interface MAC list, folding
 * contiguous MACs into range rows. Full-replace scoped to that source only —
 * rows owned by discovery / agent / manual writers are never touched, and
 * `reconcileMacAddresses` symmetrically never touches ours.
 *
 * Cross-source overlap policy: when another source already holds a row at a
 * would-be range's start key (common — a DHCP-discovered primary MAC is
 * usually the first interface MAC), the range is written starting one past
 * the occupied key instead of fighting over the row. The occupied row keeps
 * its richer discovery metadata and still represents that MAC; search finds
 * it either way. Interior/end overlaps don't collide (the unique key is the
 * range START) and are left as harmless duplicates.
 *
 * Callers pass the FULL interface MAC list each scrape (both collection
 * paths — the system-info scrape and the agent interfaces push — report the
 * complete table), so interfaces that disappear age out via the scoped
 * delete. Three statements per call (read + delete + bulk upsert); no-op
 * write when the scrape has no valid MACs and no stale rows exist.
 */
export async function reconcileInterfaceMacs(
  assetId: string,
  macs: ReadonlyArray<string | null | undefined>,
  now: Date = new Date(),
): Promise<void> {
  const folded = foldMacsToRanges(macs);

  if (folded.length === 0) {
    await retryOnDeadlock(() =>
      prisma.assetMacAddress.deleteMany({
        where: { assetId, source: INTERFACE_MAC_SOURCE },
      }),
    );
    return;
  }

  const existing = await prisma.assetMacAddress.findMany({
    where: { assetId },
    select: { mac: true, source: true },
  });
  const occupied = new Set(
    existing.filter((r) => r.source !== INTERFACE_MAC_SOURCE).map((r) => r.mac),
  );

  // Slide each entry's start past keys held by other sources (see overlap
  // policy above). An entry fully covered by other-source rows is dropped.
  const desired: MacRangeEntry[] = [];
  for (const entry of folded) {
    let s = macToInt(entry.mac);
    const e = entry.macEnd ? macToInt(entry.macEnd) : s;
    while (s <= e && occupied.has(intToMac(s))) s++;
    if (s > e) continue;
    desired.push({ mac: intToMac(s), macEnd: s === e ? null : intToMac(e) });
  }

  if (desired.length === 0) {
    await retryOnDeadlock(() =>
      prisma.assetMacAddress.deleteMany({
        where: { assetId, source: INTERFACE_MAC_SOURCE },
      }),
    );
    return;
  }

  await retryOnDeadlock(() =>
    prisma.assetMacAddress.deleteMany({
      where: {
        assetId,
        source: INTERFACE_MAC_SOURCE,
        mac: { notIn: desired.map((d) => d.mac) },
      },
    }),
  );

  const nowIso = now.toISOString();
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  for (const d of desired) {
    tuples.push(
      `(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::timestamp, $${p++}::timestamp)`,
    );
    params.push(assetId, d.mac, d.macEnd, INTERFACE_MAC_SOURCE, nowIso, nowIso);
  }
  // Conflicts only hit our own rows (other-source keys were slid past above,
  // modulo a benign race with a concurrent discovery insert); firstSeen is
  // not in the SET list so it survives across scrapes.
  const sql =
    `INSERT INTO "asset_mac_addresses" ("id", "assetId", "mac", "macEnd", "source", "lastSeen", "firstSeen") ` +
    `VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("assetId", "mac") DO UPDATE SET ` +
    `  "macEnd" = EXCLUDED."macEnd", ` +
    `  "source" = EXCLUDED."source", ` +
    `  "lastSeen" = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
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
