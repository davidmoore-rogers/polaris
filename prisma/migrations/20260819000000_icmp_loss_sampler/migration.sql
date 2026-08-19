-- ICMP packet-loss sampler (src/utils/lossSampler.ts).
--
-- A second, cheap probe that runs ONLY while an asset's monitorStatus is
-- "warning" or "recovering", at 10s with a 5s timeout, purely to give
-- probeLossPct more than a handful of samples to divide (a 15-minute window on
-- a 60s-cadence asset holds ~15 samples, so loss could only read in ~7% steps;
-- at 300s it was 3 samples and 33% steps). It never calls recordProbeResult, so
-- it cannot move consecutiveFailures / consecutiveSuccesses or monitorStatus.
--
-- Two columns, both nullable so neither add rewrites a row:
--
-- 1. assets."lastLossSampleAt" — the sampler's own cadence anchor. Its own
--    column rather than a reuse of "lastMonitorAt", which the response-time
--    poll's due-check owns. NULL = never sampled.
--
-- 2. asset_monitor_samples."probeKind" — which probe wrote the row. NULL (and
--    the literal 'primary') is the response-time poll on the asset's configured
--    transport; 'icmp' is the sampler. Loss counts every kind; the
--    response-time readers (charts, the responseTimeMs automation metric, the
--    hourly/daily avgResponseTimeMs rollups, alert-email charts, the NOC
--    widgets) must filter to primary, because ICMP answers in ~1-5ms where SNMP
--    takes 20-200ms and mixing the two would dent every RTT figure Polaris
--    reports. Every pre-existing row is a primary probe, which is exactly what
--    NULL means here — so there is deliberately NO backfill.
--
-- asset_monitor_samples is a TimescaleDB hypertable. ADD COLUMN of a nullable
-- column with no default is a catalog-only change (no chunk rewrite, no
-- decompression) — the same shape as the "uptimeSec" add that preceded it.
ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "lastLossSampleAt" TIMESTAMP(3);

ALTER TABLE "asset_monitor_samples"
  ADD COLUMN IF NOT EXISTS "probeKind" TEXT;
