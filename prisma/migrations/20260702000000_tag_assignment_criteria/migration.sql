-- Criteria-based tag auto-assignment.
--
-- Tag.criteria (nullable JSONB): NULL = ordinary manual tag (unchanged legacy
-- behavior). When set, tagAssignmentService auto-applies / removes the tag on
-- assets matching the criteria (managed sync). Additive + nullable, no backfill.
ALTER TABLE "tags" ADD COLUMN "criteria" JSONB;

-- Provenance for the managed-sync engine: one row per (tag, asset) pair the
-- engine itself applied. Strip an auto-applied tag only where a provenance row
-- exists, so a hand-applied copy of the same tag name on a non-matching asset
-- is never destroyed. No FK to tags/assets (denormalized tags-by-name design,
-- same no-cascade rationale as the sample tables); the engine cleans rows on
-- tag delete / criteria clear / asset drift.
CREATE TABLE "tag_auto_assignments" (
    "tagId"     TEXT NOT NULL,
    "assetId"   TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_auto_assignments_pkey" PRIMARY KEY ("tagId", "assetId")
);

CREATE INDEX "tag_auto_assignments_assetId_idx" ON "tag_auto_assignments"("assetId");
CREATE INDEX "tag_auto_assignments_tagId_idx"   ON "tag_auto_assignments"("tagId");
