-- Dependency-down probe marking.
--
-- A dependency-suppressed asset keeps being probed (half cadence — it may
-- answer over a redundant path), and those probes fail. Until now that failure
-- was indistinguishable from a real outage, so every chart drew the red dive
-- that means "this device stopped answering and we don't know why" across a
-- gap Polaris could perfectly well explain: its upstream was dark.
--
-- All three columns are NULLABLE with no default, so the add is metadata-only
-- on the TimescaleDB hypertable (no chunk rewrite, no decompression) — the
-- same shape as the uptimeSec add. Rows written before this migration carry
-- NULL, which every reader treats as "not a dependency failure".

ALTER TABLE "asset_monitor_samples"        ADD COLUMN "dependencyDown" BOOLEAN;
ALTER TABLE "asset_monitor_samples_hourly" ADD COLUMN "dependencyFailureCount" INTEGER;
ALTER TABLE "asset_monitor_samples_daily"  ADD COLUMN "dependencyFailureCount" INTEGER;
