-- Snapshot of the existing (collision-target) asset captured when an asset
-- conflict is raised, so the resolved Conflict Review card reflects what the
-- asset looked like at conflict time instead of the post-merge live row.
-- Null for conflicts predating this column — the UI falls back to the live
-- asset relation for those.
ALTER TABLE "conflicts" ADD COLUMN "existingAssetSnapshot" JSONB;
