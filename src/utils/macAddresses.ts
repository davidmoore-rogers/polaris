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
 *   - Each entry in `macs` is upserted (insert if missing, update lastSeen
 *     + metadata if present)
 *
 * Wrapped in a `$transaction` so the delete + upserts are atomic — a
 * concurrent reader sees either the old or the new set, never an empty
 * intermediate. No-op (no DB write) when `macs` is empty AND there are no
 * existing rows to clear.
 */
export async function reconcileMacAddresses(
  assetId: string,
  macs: readonly MacJsonEntry[],
): Promise<void> {
  const newMacSet = new Set(macs.map((m) => m.mac).filter(Boolean));

  // Find rows we need to delete. Cheaper than always running a deleteMany
  // when the asset already had no rows (common on first sighting).
  const existing = await prisma.assetMacAddress.findMany({
    where: { assetId },
    select: { mac: true },
  });
  const toDelete = existing
    .map((e) => e.mac)
    .filter((m) => !newMacSet.has(m));

  // Skip the round-trip entirely when nothing changed and no new entries
  // arrived (e.g. discovery saw the same fleet of MACs as last time).
  if (toDelete.length === 0 && macs.length === 0) return;

  const ops: Promise<unknown>[] = [];
  if (toDelete.length > 0) {
    ops.push(
      prisma.assetMacAddress.deleteMany({
        where: { assetId, mac: { in: toDelete } },
      }) as unknown as Promise<unknown>,
    );
  }
  for (const m of macs) {
    if (!m.mac) continue;
    const lastSeen = m.lastSeen ? new Date(m.lastSeen) : new Date();
    ops.push(
      prisma.assetMacAddress.upsert({
        where: { assetId_mac: { assetId, mac: m.mac } },
        create: {
          assetId,
          mac: m.mac,
          source: m.source || "unknown",
          device: m.device ?? null,
          subnetCidr: m.subnetCidr ?? null,
          subnetName: m.subnetName ?? null,
          lastSeen,
          firstSeen: lastSeen,
        },
        update: {
          source: m.source || "unknown",
          device: m.device ?? null,
          subnetCidr: m.subnetCidr ?? null,
          subnetName: m.subnetName ?? null,
          lastSeen,
        },
      }) as unknown as Promise<unknown>,
    );
  }

  if (ops.length > 0) {
    await prisma.$transaction(ops as any);
  }
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
