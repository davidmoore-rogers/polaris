-- Hardware-sensor sample stream — supersedes the temperature-only stream.
--
-- The old `asset_temperature_samples*` tables stored one class (temperature,
-- as a bare `celsius` float). FortiGates (and most vendors) actually publish a
-- whole mixed hardware-sensor table — fan RPM, voltage rails, PSU presence,
-- disk/chip temps — plus a per-row alarm column. We replace the temperature
-- stream with a unified `asset_hardware_sensor_samples*` stream carrying
-- `sensorClass` + `value` + `unit` + `alarmStatus`, one row per sensor per
-- scrape. Temperature becomes `sensorClass = 'temperature'`.
--
-- Migration strategy: CREATE-new + DROP-old, NO backfill. Deliberate, for two
-- reasons that both bite at fleet scale (thousands of monitored assets):
--   1. A backfill `INSERT ... SELECT` off the 7-day detail hypertable would be
--      tens of millions of rows in a single statement — long lock + WAL/disk
--      blowup. Out of scope for a schema migration.
--   2. The source is a (possibly compressed) TimescaleDB hypertable. Any
--      row-level rewrite there risks the compressed-chunk bloat that hit prod
--      (see migration 20260615000000). DROP TABLE on a hypertable is clean.
-- Consequence: pre-cutover temperature history (detail/hourly/daily) is reset
-- at upgrade; the new stream records all sensor classes going forward.
--
-- These are plain tables here; `ensureSampleHypertables` (timescaleService.ts)
-- converts them to hypertables + attaches the compression policy at boot, once
-- the new table names are registered in SAMPLE_TABLES / ROLLUP_TABLES. No FK to
-- `assets` — a cascade DELETE matching a compressed chunk decompresses it into
-- un-truncatable bloat (the 20260615000000 invariant). Orphaned rows age out
-- via drop_chunks.

-- CreateTable
CREATE TABLE "asset_hardware_sensor_samples" (
    "id"          TEXT         NOT NULL,
    "assetId"     TEXT         NOT NULL,
    "timestamp"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sensorName"  TEXT         NOT NULL,
    "sensorClass" TEXT         NOT NULL,
    "value"       DOUBLE PRECISION,
    "unit"        TEXT,
    "alarmStatus" TEXT,

    CONSTRAINT "asset_hardware_sensor_samples_pkey" PRIMARY KEY ("id","timestamp")
);

-- CreateTable
CREATE TABLE "asset_hardware_sensor_samples_hourly" (
    "id"          TEXT         NOT NULL,
    "assetId"     TEXT         NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sensorName"  TEXT         NOT NULL,
    "sensorClass" TEXT         NOT NULL,
    "unit"        TEXT,
    "sampleCount" INTEGER      NOT NULL,
    "avgValue"    DOUBLE PRECISION,
    "minValue"    DOUBLE PRECISION,
    "maxValue"    DOUBLE PRECISION,

    CONSTRAINT "asset_hardware_sensor_samples_hourly_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_hardware_sensor_samples_daily" (
    "id"          TEXT         NOT NULL,
    "assetId"     TEXT         NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sensorName"  TEXT         NOT NULL,
    "sensorClass" TEXT         NOT NULL,
    "unit"        TEXT,
    "sampleCount" INTEGER      NOT NULL,
    "avgValue"    DOUBLE PRECISION,
    "minValue"    DOUBLE PRECISION,
    "maxValue"    DOUBLE PRECISION,

    CONSTRAINT "asset_hardware_sensor_samples_daily_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateIndex (detail)
CREATE INDEX "asset_hardware_sensor_samples_assetId_timestamp_idx" ON "asset_hardware_sensor_samples" ("assetId", "timestamp");
CREATE INDEX "asset_hardware_sensor_samples_assetId_sensorName_timestamp_idx" ON "asset_hardware_sensor_samples" ("assetId", "sensorName", "timestamp");
CREATE INDEX "asset_hardware_sensor_samples_assetId_sensorClass_timestamp_idx" ON "asset_hardware_sensor_samples" ("assetId", "sensorClass", "timestamp");

-- CreateIndex (hourly)
CREATE INDEX "asset_hardware_sensor_samples_hourly_assetId_bucketStart_idx" ON "asset_hardware_sensor_samples_hourly" ("assetId", "bucketStart");
CREATE INDEX "asset_hardware_sensor_samples_hourly_assetId_sensorName_buc_idx" ON "asset_hardware_sensor_samples_hourly" ("assetId", "sensorName", "bucketStart");
CREATE UNIQUE INDEX "asset_hardware_sensor_samples_hourly_bucketStart_assetId_se_key" ON "asset_hardware_sensor_samples_hourly" ("bucketStart", "assetId", "sensorName");

-- CreateIndex (daily)
CREATE INDEX "asset_hardware_sensor_samples_daily_assetId_bucketStart_idx" ON "asset_hardware_sensor_samples_daily" ("assetId", "bucketStart");
CREATE INDEX "asset_hardware_sensor_samples_daily_assetId_sensorName_buck_idx" ON "asset_hardware_sensor_samples_daily" ("assetId", "sensorName", "bucketStart");
CREATE UNIQUE INDEX "asset_hardware_sensor_samples_daily_bucketStart_assetId_sen_key" ON "asset_hardware_sensor_samples_daily" ("bucketStart", "assetId", "sensorName");

-- DropTable (old temperature stream; DROP on a hypertable cleanly drops its chunks)
DROP TABLE "asset_temperature_samples_hourly";
DROP TABLE "asset_temperature_samples_daily";
DROP TABLE "asset_temperature_samples";
