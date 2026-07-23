-- Service dimension (Phase 2): per-unit journalctl log lines.
--
-- Created as a plain Postgres table in final shape (composite PK incl. the
-- partition column, NO FK to assets per the cascade-bloat rule).
-- timescaleService.migrateToHypertables() converts it to a TimescaleDB
-- hypertable at boot when the extension is present (registered in
-- STANDALONE_SAMPLE_TABLES); on plain Postgres it stays a regular table.
-- Index / constraint names match Prisma's generated names. Mirrors
-- asset_process_log_samples with `unit` in place of `name`.

CREATE TABLE "asset_service_log_samples" (
  "id"        TEXT NOT NULL,
  "assetId"   TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unit"      TEXT NOT NULL,
  "level"     TEXT,
  "message"   TEXT NOT NULL,
  "source"    TEXT,
  CONSTRAINT "asset_service_log_samples_pkey" PRIMARY KEY ("id", "timestamp")
);
CREATE INDEX "asset_service_log_samples_assetId_timestamp_idx" ON "asset_service_log_samples"("assetId", "timestamp");
CREATE INDEX "asset_service_log_samples_assetId_unit_timestamp_idx" ON "asset_service_log_samples"("assetId", "unit", "timestamp");
