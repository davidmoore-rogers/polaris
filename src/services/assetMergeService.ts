/**
 * src/services/assetMergeService.ts
 *
 * Operator-driven asset merge — the inverse of the Sources-tab "Split" action
 * (POST /assets/:id/sources/:sourceId/split). An operator who finds two Asset
 * rows that are really the same physical device (e.g. a FortiGate-discovered
 * endpoint and an AD computer that never cross-linked) picks one as the
 * survivor (canonical) and absorbs the other (ghost) into it.
 *
 * How this differs from the automatic merges:
 *   - `mergeDuplicateHostnameAssets` job / `acceptAssetConflict` cascade-DELETE
 *     the ghost's AssetSource rows (they assume the ghost's sources are
 *     redundant duplicates of the canonical's). Here the whole point is that
 *     the two assets carry DIFFERENT discovery sources, so we RE-BIND the
 *     ghost's AssetSource rows onto the canonical — the survivor ends up
 *     multi-source. The global unique constraint on (sourceKind, externalId)
 *     guarantees no collision: two distinct assets can never already hold the
 *     same source identity.
 *   - Those paths blank-fill only. Here the caller supplies per-field winners
 *     (operator chose, field by field, in the comparison UI).
 *
 * What is preserved vs. discarded (matches the confirmed product decision —
 * the comparison UI tells the operator to keep the asset with monitoring
 * history as the survivor):
 *   - Re-bound onto the survivor: AssetSource rows, AssetMacAddress,
 *     AssetAssociatedIp, AssetIpHistory, AssetFortigateSighting (all
 *     delete-on-conflict against the survivor's existing rows), and the
 *     ManagedAgent enrollment IFF the survivor has none.
 *   - Cascade-DELETED with the ghost (FK kept): LLDP neighbors, wireless
 *     stations, interface comment overrides, dependency edges, and pending
 *     Conflicts. The survivor keeps its own. Called out in the confirm dialog.
 *   - ORPHANED + aged out (no FK since migration 20260615000000): all
 *     monitoring/telemetry/interface/storage/temperature/IPsec/SD-WAN/custom-
 *     widget samples + every *Hourly/*Daily rollup. These are TimescaleDB
 *     hypertables; a cascade DELETE matching compressed-chunk rows would
 *     decompress them into un-truncatable bloat (prod incident 2026-06-08), so
 *     the ghost's sample rows are left orphaned (never queried) and removed by
 *     drop_chunks on the retention schedule. Net effect matches the old cascade
 *     (the ghost's history isn't carried onto the survivor), just bloat-free.
 *
 * Scale note: every transfer is bounded by ONE ghost asset's side-table rows
 * (tens, not thousands) inside a single transaction. Not a ticking job — a
 * one-shot operator action. Safe at 100 and 2000 monitored assets.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { clampAcquiredToLastSeen } from "../utils/assetInvariants.js";

// Scalar fields the comparison UI diffs and the operator can pick a winner
// for. Kept in sync with the COMPARE_FIELDS list in public/js/assets.js so the
// modal and the server agree on what's mergeable. Tags (union) and lastSeen
// (max) are handled separately below and are NOT in this list.
export const MERGEABLE_FIELDS = [
  "hostname",
  "dnsName",
  "ipAddress",
  "macAddress",
  "serialNumber",
  "manufacturer",
  "model",
  "assetType",
  "status",
  "location",
  "learnedLocation",
  "department",
  "assignedTo",
  "os",
  "osVersion",
  "snmpLocation",
  "learnedAddress",
  "purchaseOrder",
  "notes",
  "acquiredAt",
  "warrantyExpiry",
] as const;

export type MergeableField = (typeof MERGEABLE_FIELDS)[number];
export type FieldWinner = "canonical" | "ghost";

type AssetForMerge = {
  id: string;
  hostname: string | null;
  lastSeen: Date | null;
  acquiredAt: Date | null;
  tags: string[];
  managedAgent: { id: string } | null;
} & Record<string, unknown>;

export interface MergeAssetsResult {
  survivorId: string;
  absorbedId: string;
  movedSources: number;
  movedMacs: number;
  movedIps: number;
  movedIpHistory: number;
  movedSightings: number;
  movedManagedAgent: boolean;
  appliedFields: string[];
}

const ASSET_SELECT = {
  id: true,
  hostname: true,
  dnsName: true,
  ipAddress: true,
  macAddress: true,
  serialNumber: true,
  manufacturer: true,
  model: true,
  assetType: true,
  status: true,
  location: true,
  learnedLocation: true,
  department: true,
  assignedTo: true,
  os: true,
  osVersion: true,
  snmpLocation: true,
  learnedAddress: true,
  purchaseOrder: true,
  notes: true,
  acquiredAt: true,
  warrantyExpiry: true,
  lastSeen: true,
  lastSeenSource: true,
  tags: true,
  managedAgent: { select: { id: true } },
} as const;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

export interface SideTableTransferCounts {
  movedMacs: number;
  movedIps: number;
  movedIpHistory: number;
  movedSightings: number;
}

/**
 * Transfer the four per-asset side tables (AssetMacAddress /
 * AssetAssociatedIp / AssetIpHistory / AssetFortigateSighting) from one
 * asset to another inside the caller's transaction. Each is unique on
 * (assetId, <key>): non-colliding rows re-point to the target, colliding
 * rows are deleted (the target's row wins). Shared by the operator merge
 * below and the endpoint-ghost merge in assetGhostMergeService.
 */
export async function transferAssetSideTables(
  tx: any,
  fromAssetId: string,
  toAssetId: string,
): Promise<SideTableTransferCounts> {
  const moveUnique = async (delegate: any, keyField: string): Promise<number> => {
    const cur = await delegate.findMany({
      where: { assetId: toAssetId },
      select: { [keyField]: true },
    });
    const curSet = new Set(cur.map((r: any) => r[keyField]));
    const incoming = await delegate.findMany({
      where: { assetId: fromAssetId },
      select: { id: true, [keyField]: true },
    });
    let moved = 0;
    for (const r of incoming) {
      if (curSet.has(r[keyField])) {
        await delegate.delete({ where: { id: r.id } });
      } else {
        await delegate.update({ where: { id: r.id }, data: { assetId: toAssetId } });
        curSet.add(r[keyField]);
        moved++;
      }
    }
    return moved;
  };
  return {
    movedMacs: await moveUnique(tx.assetMacAddress, "mac"),
    movedIps: await moveUnique(tx.assetAssociatedIp, "ip"),
    movedIpHistory: await moveUnique(tx.assetIpHistory, "ip"),
    movedSightings: await moveUnique(tx.assetFortigateSighting, "fortigateDevice"),
  };
}

/**
 * Merge `ghostId` into `canonicalId`. The canonical survives; the ghost is
 * deleted. `fieldWinners` maps a MERGEABLE_FIELDS key to which side wins; any
 * field not present defaults to blank-fill (keep canonical, fill from ghost
 * only when the canonical's value is empty).
 */
export async function mergeAssets(opts: {
  canonicalId: string;
  ghostId: string;
  fieldWinners?: Partial<Record<MergeableField, FieldWinner>>;
}): Promise<MergeAssetsResult> {
  const { canonicalId, ghostId } = opts;
  const fieldWinners = opts.fieldWinners ?? {};

  if (canonicalId === ghostId) {
    throw new AppError(400, "Cannot merge an asset into itself");
  }

  const [canonical, ghost] = await Promise.all([
    prisma.asset.findUnique({ where: { id: canonicalId }, select: ASSET_SELECT }),
    prisma.asset.findUnique({ where: { id: ghostId }, select: ASSET_SELECT }),
  ]);
  if (!canonical) throw new AppError(404, "Survivor asset not found");
  if (!ghost) throw new AppError(404, "Absorbed asset not found");

  const c = canonical as unknown as AssetForMerge;
  const g = ghost as unknown as AssetForMerge;

  // Resolve the per-field update. Blank-fill default mirrors
  // mergeGhostIntoCanonical / acceptAssetConflict; an explicit "ghost" winner
  // overwrites (but never writes an empty value over a populated one).
  const update: Record<string, unknown> = {};
  const appliedFields: string[] = [];
  for (const field of MERGEABLE_FIELDS) {
    const cVal = c[field];
    const gVal = g[field];
    const winner: FieldWinner = fieldWinners[field] ?? (isEmpty(cVal) && !isEmpty(gVal) ? "ghost" : "canonical");
    if (winner === "ghost" && !isEmpty(gVal)) {
      update[field] = gVal;
      appliedFields.push(field);
    }
  }

  // lastSeen — always keep the more recent so the survivor reflects the
  // ghost's sightings (provenance label travels with it). tags — always
  // union, preserving the canonical order.
  if (g.lastSeen && (!c.lastSeen || g.lastSeen > c.lastSeen)) {
    update.lastSeen = g.lastSeen;
    if (g.lastSeenSource) update.lastSeenSource = g.lastSeenSource;
  }
  const cTags = new Set(c.tags);
  const mergedTags = [...c.tags];
  for (const t of g.tags) {
    if (!cTags.has(t)) {
      mergedTags.push(t);
      cTags.add(t);
    }
  }
  if (mergedTags.length > c.tags.length) update.tags = mergedTags;

  // acquiredAt ≤ lastSeen invariant (also enforced by the db.ts write
  // extension, but we resolve it here so the value is correct in-transaction).
  clampAcquiredToLastSeen(update, { acquiredAt: c.acquiredAt, lastSeen: c.lastSeen });

  let movedSources = 0;
  let movedMacs = 0;
  let movedIps = 0;
  let movedIpHistory = 0;
  let movedSightings = 0;
  let movedManagedAgent = false;

  await prisma.$transaction(async (tx) => {
    // AssetSource — re-bind ALL ghost sources onto the canonical. No collision
    // possible: (sourceKind, externalId) is globally unique, so two distinct
    // assets can't already share a source identity. This is what makes the
    // survivor multi-source (the whole reason to merge rather than delete).
    const srcRes = await tx.assetSource.updateMany({
      where: { assetId: g.id },
      data: { assetId: c.id },
    });
    movedSources = srcRes.count;

    // Side tables — unique per (assetId, key), delete-on-conflict. Shared
    // with the endpoint-ghost merge.
    const sideCounts = await transferAssetSideTables(tx, g.id, c.id);
    movedMacs = sideCounts.movedMacs;
    movedIps = sideCounts.movedIps;
    movedIpHistory = sideCounts.movedIpHistory;
    movedSightings = sideCounts.movedSightings;

    // ManagedAgent — 1:1, unique assetId, cascade-deletes with the ghost. If
    // the survivor has no agent but the ghost does, re-bind it so the
    // enrollment (and its cert pins) survive the merge. If both have one, the
    // ghost's cascade-deletes (operator keeps the survivor's).
    if (g.managedAgent && !c.managedAgent) {
      await tx.managedAgent.update({ where: { assetId: g.id }, data: { assetId: c.id } });
      movedManagedAgent = true;
    }

    if (Object.keys(update).length > 0) {
      await tx.asset.update({ where: { id: c.id }, data: update });
    }

    // Delete the ghost. Everything still pointing at it cascade-deletes (see
    // the file header for the full list). Sources / MACs / IPs / sightings /
    // managed agent have already been moved off, so only the discarded
    // streams remain to cascade.
    await tx.asset.delete({ where: { id: g.id } });
  });

  return {
    survivorId: c.id,
    absorbedId: g.id,
    movedSources,
    movedMacs,
    movedIps,
    movedIpHistory,
    movedSightings,
    movedManagedAgent,
    appliedFields,
  };
}
