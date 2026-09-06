/**
 * src/services/discoveredHostnameService.ts
 *
 * "What hostname would this asset have if the operator pin were cleared?"
 *
 * `Asset.hostnameOverride` makes the pinned value THE hostname: the assets PUT
 * handler writes both columns and the Prisma extension in src/db.ts re-asserts
 * the pin over every later projection write (see polaris-domain-model -> assets-core.md
 * "three operator pins"). So the discovered name is not stored anywhere on the
 * Asset row — it only exists inside the `AssetSource.observed` blobs, which is
 * where the pin-clear path in assets.ts already goes to recover it
 * (`loadProjection().projected.hostname`).
 *
 * This service is that same read, batched, so a list page can render the
 * discovered name UNDER the pinned one. Computing it rather than stashing a
 * column at write time keeps it LIVE (it tracks what discovery says today, not
 * what it said the moment the operator typed the pin) and retroactive (assets
 * pinned before this existed render immediately, with no migration and no
 * backfill job).
 *
 * Cost: callers pass only the ids that actually carry a pin, so the extra query
 * disappears on a page with no overrides — one indexed `assetId IN (...)` scan
 * of `asset_sources` otherwise. Deliberately uncapped: the id set is bounded by
 * how many hostnames an operator has hand-pinned, which is a per-device manual
 * act, and truncating it would silently blank the sub-line on some rows.
 */

import { prisma } from "../db.js";
import {
  projectAssetFromSources,
  type AssetSourceForProjection,
} from "../utils/assetProjection.js";

/** One AssetSource row, as read for this projection. */
export interface HostnameSourceRow extends AssetSourceForProjection {
  assetId: string;
}

/**
 * Pure core: group source rows by asset and run the hostname projection over
 * each group. An asset whose sources have no hostname opinion (a manually
 * created asset, or one whose only sources are `inferred` phase-1 skeletons)
 * maps to null — there IS no original to show, which the caller renders as
 * nothing rather than as an empty line.
 */
export function projectHostnamesFromSourceRows(
  rows: HostnameSourceRow[],
): Map<string, string | null> {
  const byAsset = new Map<string, AssetSourceForProjection[]>();
  for (const r of rows) {
    const list = byAsset.get(r.assetId);
    const entry: AssetSourceForProjection = {
      sourceKind: r.sourceKind,
      inferred: r.inferred,
      observed: r.observed,
      lastSeen: r.lastSeen,
    };
    if (list) list.push(entry);
    else byAsset.set(r.assetId, [entry]);
  }
  const out = new Map<string, string | null>();
  for (const [assetId, sources] of byAsset) {
    out.set(assetId, projectAssetFromSources(sources).projected.hostname);
  }
  return out;
}

/**
 * The discovery-projected hostname for each of `assetIds`. Ids with no sources
 * are simply absent from the map (same meaning as a null value: nothing to
 * show).
 */
export async function getDiscoveredHostnames(
  assetIds: string[],
): Promise<Map<string, string | null>> {
  if (assetIds.length === 0) return new Map();
  const rows = await prisma.assetSource.findMany({
    where: { assetId: { in: assetIds } },
    select: { assetId: true, sourceKind: true, inferred: true, observed: true, lastSeen: true },
  });
  return projectHostnamesFromSourceRows(
    rows.map((r) => ({
      assetId: r.assetId,
      sourceKind: r.sourceKind,
      inferred: r.inferred,
      observed: r.observed as Record<string, unknown> | null,
      lastSeen: r.lastSeen,
    })),
  );
}

/** Single-asset convenience for the asset-details GET. */
export async function getDiscoveredHostname(assetId: string): Promise<string | null> {
  return (await getDiscoveredHostnames([assetId])).get(assetId) ?? null;
}
