-- FortiGate active-session count time-series.
--
-- sessionCount on the telemetry sample table + its hourly/daily rollups —
-- read from the same /api/v2/monitor/system/resource/usage `session` resource
-- the CPU/mem collector already fetches. Null for every non-FortiGate source.
-- Surfaced as the System-tab "Active Sessions" chart.
--
-- (Device uptime is handled separately by the reboot_detection migration's
-- Asset.lastUptimeSec / lastRebootAt columns — this branch extends that
-- capture to FortiOS + agent and adds the System-tab Uptime row.)

ALTER TABLE "asset_telemetry_samples"
  ADD COLUMN "sessionCount" DOUBLE PRECISION;

ALTER TABLE "asset_telemetry_samples_hourly"
  ADD COLUMN "avgSessionCount" DOUBLE PRECISION,
  ADD COLUMN "minSessionCount" DOUBLE PRECISION,
  ADD COLUMN "maxSessionCount" DOUBLE PRECISION;

ALTER TABLE "asset_telemetry_samples_daily"
  ADD COLUMN "avgSessionCount" DOUBLE PRECISION,
  ADD COLUMN "minSessionCount" DOUBLE PRECISION,
  ADD COLUMN "maxSessionCount" DOUBLE PRECISION;
