-- Feature C data layer: pinned-process CPU/RAM time-series (+ rollups),
-- per-process log lines, and per-process log config.
--
-- The three time-series tables are created as plain Postgres tables here in
-- their final shape (composite PKs incl. the partition column, NO FK to assets
-- per the cascade-bloat rule). timescaleService.createHypertables() converts
-- them to TimescaleDB hypertables at boot when the extension is present
-- (asset_process_samples + its rollups are registered in SAMPLE_TABLES /
-- ROLLUP_TABLES; asset_process_log_samples in STANDALONE_SAMPLE_TABLES) — on
-- plain Postgres they stay regular tables. asset_process_configs is an ordinary
-- table. Index / constraint names match Prisma's generated names.

-- ── AssetProcessSample (detail time-series) ───────────────────────────────
CREATE TABLE "asset_process_samples" (
  "id"            TEXT NOT NULL,
  "assetId"       TEXT NOT NULL,
  "timestamp"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name"          TEXT NOT NULL,
  "cpuPct"        DOUBLE PRECISION,
  "memRssBytes"   BIGINT,
  "instanceCount" INTEGER,
  "cadence"       TEXT,
  CONSTRAINT "asset_process_samples_pkey" PRIMARY KEY ("id", "timestamp")
);
CREATE INDEX "asset_process_samples_assetId_timestamp_idx" ON "asset_process_samples"("assetId", "timestamp");
CREATE INDEX "asset_process_samples_assetId_name_timestamp_idx" ON "asset_process_samples"("assetId", "name", "timestamp");

-- ── AssetProcessSampleHourly / Daily (rollups) ────────────────────────────
CREATE TABLE "asset_process_samples_hourly" (
  "id"             TEXT NOT NULL,
  "assetId"        TEXT NOT NULL,
  "bucketStart"    TIMESTAMP(3) NOT NULL,
  "name"           TEXT NOT NULL,
  "sampleCount"    INTEGER NOT NULL,
  "avgCpuPct"      DOUBLE PRECISION,
  "minCpuPct"      DOUBLE PRECISION,
  "maxCpuPct"      DOUBLE PRECISION,
  "avgMemRssBytes" BIGINT,
  "minMemRssBytes" BIGINT,
  "maxMemRssBytes" BIGINT,
  CONSTRAINT "asset_process_samples_hourly_pkey" PRIMARY KEY ("id", "bucketStart")
);
CREATE UNIQUE INDEX "asset_process_samples_hourly_bucketStart_assetId_name_key" ON "asset_process_samples_hourly"("bucketStart", "assetId", "name");
CREATE INDEX "asset_process_samples_hourly_assetId_bucketStart_idx" ON "asset_process_samples_hourly"("assetId", "bucketStart");
CREATE INDEX "asset_process_samples_hourly_assetId_name_bucketStart_idx" ON "asset_process_samples_hourly"("assetId", "name", "bucketStart");

CREATE TABLE "asset_process_samples_daily" (
  "id"             TEXT NOT NULL,
  "assetId"        TEXT NOT NULL,
  "bucketStart"    TIMESTAMP(3) NOT NULL,
  "name"           TEXT NOT NULL,
  "sampleCount"    INTEGER NOT NULL,
  "avgCpuPct"      DOUBLE PRECISION,
  "minCpuPct"      DOUBLE PRECISION,
  "maxCpuPct"      DOUBLE PRECISION,
  "avgMemRssBytes" BIGINT,
  "minMemRssBytes" BIGINT,
  "maxMemRssBytes" BIGINT,
  CONSTRAINT "asset_process_samples_daily_pkey" PRIMARY KEY ("id", "bucketStart")
);
CREATE UNIQUE INDEX "asset_process_samples_daily_bucketStart_assetId_name_key" ON "asset_process_samples_daily"("bucketStart", "assetId", "name");
CREATE INDEX "asset_process_samples_daily_assetId_bucketStart_idx" ON "asset_process_samples_daily"("assetId", "bucketStart");
CREATE INDEX "asset_process_samples_daily_assetId_name_bucketStart_idx" ON "asset_process_samples_daily"("assetId", "name", "bucketStart");

-- ── AssetProcessLogSample (standalone detail-only) ────────────────────────
CREATE TABLE "asset_process_log_samples" (
  "id"        TEXT NOT NULL,
  "assetId"   TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name"      TEXT NOT NULL,
  "level"     TEXT,
  "message"   TEXT NOT NULL,
  "source"    TEXT,
  CONSTRAINT "asset_process_log_samples_pkey" PRIMARY KEY ("id", "timestamp")
);
CREATE INDEX "asset_process_log_samples_assetId_timestamp_idx" ON "asset_process_log_samples"("assetId", "timestamp");
CREATE INDEX "asset_process_log_samples_assetId_name_timestamp_idx" ON "asset_process_log_samples"("assetId", "name", "timestamp");

-- ── AssetProcessConfig (per-pinned-process log config) ────────────────────
CREATE TABLE "asset_process_configs" (
  "id"           TEXT NOT NULL,
  "assetId"      TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "logSource"    TEXT,
  "logPathGlob"  TEXT,
  "detectedUnit" TEXT,
  "notes"        VARCHAR(255),
  "updatedBy"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "asset_process_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "asset_process_configs_assetId_name_key" ON "asset_process_configs"("assetId", "name");
CREATE INDEX "asset_process_configs_assetId_idx" ON "asset_process_configs"("assetId");
