/**
 * src/utils/assetSourceTags.ts — asset-tag identity prefixes.
 *
 * Cross-file protocol values: the discovery sync (integrations.ts) WRITES
 * these tag prefixes onto assets, and conflict resolution (conflicts.ts)
 * PARSES them back to resolve a conflict's discovery source. They were
 * declared as duplicate const sets in both files — drift would silently
 * break conflict-source resolution, so they live here now.
 */

export const ENTRA_ASSET_TAG_PREFIX = "entra:";
export const AD_ASSET_TAG_PREFIX = "ad:";
export const AD_GUID_TAG_PREFIX = "ad-guid:";
export const SID_TAG_PREFIX = "sid:";
