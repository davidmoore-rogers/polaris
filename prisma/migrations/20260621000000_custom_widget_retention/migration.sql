-- Make asset_custom_widget_samples eligible for TimescaleDB hypertable
-- conversion by moving its primary key to include the partition column
-- (timestamp). create_hypertable requires every UNIQUE/PK constraint to
-- contain the partitioning column.
--
-- Background: this table previously had a single-column PK on `id` and was the
-- one sample table with NO prune path and NO Timescale management — rows
-- accumulated until manually cleared (2026-06 review finding). After this
-- migration the boot-time migrateToHypertables() pass converts it (it's listed
-- in timescaleService.STANDALONE_SAMPLE_TABLES) and pruneSystemInfoSamples
-- ages it out on the system-info umbrella window via drop_chunks.
--
-- PK swap is metadata + a unique-index rebuild on `(id, timestamp)`; `id` is a
-- random UUID so `(id, timestamp)` is still unique. Run before the table grows
-- large in prod (it's typically small — only populated when operators define
-- custom MIB widgets).

ALTER TABLE "asset_custom_widget_samples" DROP CONSTRAINT IF EXISTS "asset_custom_widget_samples_pkey";
ALTER TABLE "asset_custom_widget_samples" ADD CONSTRAINT "asset_custom_widget_samples_pkey" PRIMARY KEY ("id", "timestamp");
