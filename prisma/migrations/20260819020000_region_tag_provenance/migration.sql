-- Provenance for map-region tag propagation, so the reconcile can RE-EVALUATE
-- region membership instead of only ever adding to it.
--
-- mapRegionService was add-only: a device that MOVED out of a polygon kept its
-- `region:<name>` tag forever, and the only strips were the rename/delete
-- paths. It stayed add-only because a blind "strip every non-member" pass would
-- also delete a region tag an operator attached by hand to a device with no
-- coordinates -- the documented manual-attachment case.
--
-- This is the tag_auto_assignments answer to the same problem: record the pairs
-- the reconciler itself tagged, and strip only those. A target carrying the tag
-- with no provenance row is operator-owned and left alone.
--
-- Keyed by regionId (stable across a rename, which changes the tag string but
-- not membership) plus a target kind, because a region propagates to BOTH
-- assets and subnets -- which is why tag_auto_assignments, whose PK is
-- (tagId, assetId), can't be reused. No FKs: regions live in a Setting JSONB
-- blob rather than a table, and the asset/subnet side follows the same
-- no-cascade rationale as tag_auto_assignments.
--
-- No backfill. The first reconcile after this migration stamps provenance for
-- every current member (they already carry the tag, so nothing is written to
-- tags[]), which means tags that are ALREADY stale today have no provenance row
-- and are deliberately never stripped -- they are indistinguishable from a
-- hand-applied tag. Drift from this point on is caught.
CREATE TABLE "region_tag_assignments" (
    "regionId"   TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId"   TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "region_tag_assignments_pkey" PRIMARY KEY ("regionId", "targetType", "targetId")
);

CREATE INDEX "region_tag_assignments_regionId_idx" ON "region_tag_assignments"("regionId");
CREATE INDEX "region_tag_assignments_targetId_idx" ON "region_tag_assignments"("targetId");
