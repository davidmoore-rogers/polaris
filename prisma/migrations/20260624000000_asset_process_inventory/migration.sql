-- Process inventory (Feature B).
--
-- Adds the two operator pin columns to `assets` (monitored = telemetry+logs,
-- alertWatched = future alerting) and the current-state `asset_processes` table
-- (one row per program name per asset, delete-replaced per scrape like
-- asset_sdwan_rules). Plain Postgres tables — no hypertable / compressed-chunk
-- considerations. Pins default to empty arrays so existing rows need no backfill.

ALTER TABLE "assets" ADD COLUMN "monitoredProcesses"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "assets" ADD COLUMN "alertWatchedProcesses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "asset_processes" (
  "id"            TEXT NOT NULL,
  "assetId"       TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "instanceCount" INTEGER NOT NULL DEFAULT 1,
  "cpuPct"        DOUBLE PRECISION,
  "memRssBytes"   BIGINT,
  "exePath"       TEXT,
  "username"      TEXT,
  "startedAt"     TIMESTAMP(3),
  "serviceUnit"   TEXT,
  "controllable"  BOOLEAN NOT NULL DEFAULT false,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "asset_processes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_processes_assetId_name_key" ON "asset_processes"("assetId", "name");
CREATE INDEX "asset_processes_assetId_idx" ON "asset_processes"("assetId");
