-- State probes: 0/1 automation triggers from operator-defined MIB objects.
--
-- Polaris could already alert on any NUMERIC value an operator pointed a
-- Manufacturer Profile custom widget at, but not on the status-shaped objects
-- that are arguably more useful — an alarm bit, a PSU present/failed flag, a
-- fan-tray OK register. Threshold-alerting those ("alarm >= 1") happens to work
-- for a 0/1 INTEGER and is wrong for everything else: SNMPv2 TruthValue is
-- true(1)/false(2), plenty of enums use 2 for the bad state, and some agents
-- answer strings. So a probe now DECLARES its mapping, and the collector stores
-- an already-normalized boolean.
--
-- Two parts:
--   1. `manufacturer_custom_widgets` gains the state-probe definition columns
--      (`stateMap` + `labelSymbol`). Nullable — every existing gauge/line/table
--      widget is untouched and keeps working.
--   2. `asset_state_samples` is the new 0/1 time-series, one row per
--      (asset, probe, table row) per scrape.
--
-- `asset_state_samples` is created as a PLAIN table here; ensureSampleHypertables
-- (timescaleService.ts) converts it to a hypertable and attaches the compression
-- policy at boot, once the name is registered in STANDALONE_SAMPLE_TABLES. No FK
-- to `assets`: a cascade DELETE matching a compressed chunk decompresses it into
-- un-truncatable bloat (the migration 20260615000000 invariant), so orphaned rows
-- age out via drop_chunks instead. Composite PK (id, timestamp) because
-- create_hypertable requires the partition column in the PK.
--
-- Detail-only — no hourly/daily rollup companions. Averaging a boolean produces a
-- duty cycle, not a state, and the rollup writer has no meaningful aggregate to
-- compute; retention runs on the system-info umbrella window via
-- pruneSystemInfoSamples.

-- AlterTable
ALTER TABLE "manufacturer_custom_widgets" ADD COLUMN "stateMap" JSONB;
ALTER TABLE "manufacturer_custom_widgets" ADD COLUMN "labelSymbol" TEXT;

-- CreateTable
CREATE TABLE "asset_state_samples" (
    "id"        TEXT         NOT NULL,
    "assetId"   TEXT         NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "probeId"   TEXT         NOT NULL,
    "rowKey"    TEXT         NOT NULL,
    "rowLabel"  TEXT         NOT NULL,
    "value"     INTEGER      NOT NULL,
    "rawValue"  TEXT,

    CONSTRAINT "asset_state_samples_pkey" PRIMARY KEY ("id","timestamp")
);

-- CreateIndex
CREATE INDEX "asset_state_samples_assetId_timestamp_idx" ON "asset_state_samples" ("assetId", "timestamp");
CREATE INDEX "asset_state_samples_assetId_probeId_timestamp_idx" ON "asset_state_samples" ("assetId", "probeId", "timestamp");
CREATE INDEX "asset_state_samples_probeId_idx" ON "asset_state_samples" ("probeId");
