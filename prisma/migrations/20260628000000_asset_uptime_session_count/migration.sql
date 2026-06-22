-- Device uptime + FortiGate active-session count.
--
-- (1) Asset.lastUptimeSeconds / lastUptimeAt — last observed device uptime
--     (seconds) and when it was observed, stamped on the probe path
--     (SNMP sysUpTime / FortiOS system status / Polaris Agent host.Uptime).
--     The live value is computed at render time as
--     lastUptimeSeconds + (now - lastUptimeAt).
-- (2) sessionCount on the telemetry sample table + its hourly/daily rollups —
--     FortiGate active-session count, read from the same resource/usage
--     response the CPU/mem collector already fetches.

ALTER TABLE "assets"
  ADD COLUMN "lastUptimeSeconds" INTEGER,
  ADD COLUMN "lastUptimeAt"      TIMESTAMP(3);

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
