/**
 * src/services/assetGhostMergeService.ts
 *
 * Merge a duplicate "fortigate-endpoint" ghost Asset into its canonical
 * infrastructure asset (managed FortiSwitch / FortiAP / firewall).
 *
 * The ghost pattern: a managed device's management interface pulls a DHCP
 * lease from its FortiGate, so the gate's DHCP / ARP / device-inventory
 * pathway learns the MAC independently and creates a separate endpoint
 * Asset (hostname = the device serial, sourceKind = "fortigate-endpoint").
 * Once the real infrastructure asset exists, discovery's serial match
 * resolves it FIRST every cycle, so the adoption fallbacks (MAC / hostname)
 * never run against the ghost — it is permanently shielded from the inline
 * dedup and just keeps getting freshened by the lease pathway.
 *
 * Callers: the inline ghost sweep in the FortiSwitch / FortiAP discovery
 * loops (`syncDhcpSubnets` in src/api/routes/integrations.ts) and the
 * one-shot `mergeFortiswitchEndpointGhosts` startup job.
 *
 * Distinct from `assetMergeService.mergeAssets` (the operator-driven merge)
 * on purpose: that path RE-BINDS the ghost's AssetSource rows onto the
 * survivor (its ghosts carry genuinely different discovery sources) and
 * unions tags. An endpoint ghost's sources are stale placeholders that must
 * be DELETED — re-binding would staple a fortigate-endpoint / orphaned
 * manual source onto the infrastructure asset — and its
 * "device-inventory" tags would mislabel a switch. The low-level side-table
 * transfer is shared (`transferAssetSideTables`).
 *
 * What merging does (single transaction):
 *   - transfers AssetMacAddress / AssetAssociatedIp / AssetIpHistory /
 *     AssetFortigateSighting rows ghost → canonical (delete-on-conflict
 *     for unique violations — the canonical's row wins)
 *   - deletes the ghost's AssetSource rows (placeholders by definition —
 *     eligibility requires no authoritative source; see below)
 *   - stamps the ghost's primary MAC onto the canonical when the canonical
 *     has none
 *   - carries `monitored = true` over when the ghost was monitored and the
 *     canonical isn't (endpoint ghosts are never auto-monitored, so a
 *     monitored ghost reflects an explicit operator choice); the caller's
 *     post-transaction `recomputeMonitorOverrideForAssets` run keeps the
 *     override bit faithful to that carried-over intent
 *   - deletes the ghost row. Sample hypertables carry no FK to Asset
 *     (migration 20260615000000) so the ghost's samples are left orphaned
 *     and age out via drop_chunks — never row-deleted (compressed-chunk
 *     bloat, prod incident 2026-06-08).
 */

import { prisma } from "../db.js";
import { transferAssetSideTables } from "./assetMergeService.js";
import { recomputeMonitorOverrideForAssets } from "./monitorOverrideService.js";

/**
 * Source kinds that mark an asset as having its own authoritative identity.
 * An asset carrying ANY of these is NOT a mergeable ghost — only pure
 * endpoint placeholders (fortigate-endpoint, plus at most the empty
 * "manual" row an operator edit stamps) qualify.
 */
const AUTHORITATIVE_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "entra",
  "intune",
  "ad",
  "polaris-agent",
  "fortigate-firewall",
  "fortiswitch",
  "fortiap",
]);

/**
 * Pure eligibility check over an asset's AssetSource kinds: mergeable when
 * the asset has fortigate-endpoint provenance and no authoritative source.
 */
export function isMergeableGhostSourceKinds(kinds: string[]): boolean {
  if (!kinds.includes("fortigate-endpoint")) return false;
  return !kinds.some((k) => AUTHORITATIVE_SOURCE_KINDS.has(k));
}

/** DB-backed eligibility check for a single asset id. */
export async function isMergeableEndpointGhost(assetId: string): Promise<boolean> {
  const rows = await prisma.assetSource.findMany({
    where: { assetId },
    select: { sourceKind: true },
  });
  return isMergeableGhostSourceKinds(rows.map((r) => r.sourceKind));
}

export interface GhostMergeResult {
  /** MAC stamped onto the canonical (null when it already had one / ghost had none). */
  adoptedMac: string | null;
  /** True when the ghost's monitored=true was carried onto the canonical. */
  transferredMonitored: boolean;
}

/**
 * Merge `ghostId` into `canonicalId` and delete the ghost. Caller is
 * responsible for eligibility (isMergeableEndpointGhost) — this function
 * assumes the ghost is a placeholder and its sources are disposable.
 */
export async function mergeEndpointGhostIntoAsset(
  canonicalId: string,
  ghostId: string,
): Promise<GhostMergeResult> {
  const result = await prisma.$transaction(async (tx) => {
    const canonical = await tx.asset.findUniqueOrThrow({
      where: { id: canonicalId },
      select: { macAddress: true, monitored: true },
    });
    const ghost = await tx.asset.findUniqueOrThrow({
      where: { id: ghostId },
      select: { macAddress: true, monitored: true },
    });

    // Side tables (AssetMacAddress / AssetAssociatedIp / AssetIpHistory /
    // AssetFortigateSighting) — unique per (assetId, key): re-point
    // non-conflicting rows, delete conflicting ones (the canonical wins).
    await transferAssetSideTables(tx, ghostId, canonicalId);

    // Source rows on the ghost are all placeholders superseded by the
    // canonical's authoritative sources — drop them. Cannot re-point:
    // AssetSource is uniquely keyed on (sourceKind, externalId), and any
    // conflict would mean the canonical already has a row for that source.
    await tx.assetSource.deleteMany({ where: { assetId: ghostId } });

    const canonicalUpdate: Record<string, unknown> = {};
    const adoptedMac = !canonical.macAddress && ghost.macAddress ? ghost.macAddress : null;
    if (adoptedMac) canonicalUpdate.macAddress = adoptedMac;
    const transferredMonitored = ghost.monitored === true && canonical.monitored !== true;
    if (transferredMonitored) canonicalUpdate.monitored = true;
    if (Object.keys(canonicalUpdate).length > 0) {
      await tx.asset.update({ where: { id: canonicalId }, data: canonicalUpdate });
    }

    // Delete the ghost. Relational side tables not transferred above
    // (AssetLldpNeighbor, dependency edges, conflicts, overrides) cascade;
    // sample hypertables have no FK and their orphaned rows age out via
    // drop_chunks (see header comment).
    await tx.asset.delete({ where: { id: ghostId } });

    return { adoptedMac, transferredMonitored };
  });

  // Keep monitorOverride faithful after carrying operator monitoring intent
  // over — same post-write hook the operator asset-write paths use.
  if (result.transferredMonitored) {
    try {
      await recomputeMonitorOverrideForAssets(prisma, [canonicalId]);
    } catch {
      // Best-effort — an override recompute failure must not undo the merge.
    }
  }

  return result;
}
