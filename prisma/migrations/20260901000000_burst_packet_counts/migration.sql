-- Burst-sweep packet accounting.
--
-- Packet loss has always been failed/total over AssetMonitorSample ROWS, which
-- makes it a ratio of poll OUTCOMES rather than of packets. Two problems follow
-- from that and neither is fixable in the arithmetic: the ratio can only
-- resolve to 1/N over the window's N polls (6.7% steps at 15 min / 60s), and it
-- reads the same stream down detection reads, so an outage and a lossy link are
-- literally the same evidence.
--
-- These columns let one row carry a BURST -- N echoes sent, M received -- so
-- the ratio sums packets instead of counting rows. The ICMP burst sweep
-- (utils/burstPing.ts) writes them; `success` stays M > 0, so every existing
-- reader that only understands success/failure keeps working untouched.
--
-- All six columns are NULLABLE with no default, so the add is metadata-only on
-- the TimescaleDB hypertable -- no chunk rewrite, no decompression -- the same
-- shape as the uptimeSec and dependencyDown adds before it. Rows written before
-- this migration, and the response-time poll's own rows, carry NULL; every
-- reader must treat NULL as the single-probe equivalent (sent 1, received 1 on
-- success / 0 on failure), NEVER as zero. Reading NULL as zero would erase
-- those rows from the denominator and report a clean fleet.
--
-- The rollup columns are summed rather than averaged, so loss over a long range
-- stays a true packets-lost/packets-sent ratio instead of a mean of per-bucket
-- percentages -- which would weight a bucket holding one sweep the same as one
-- holding sixty.

ALTER TABLE "asset_monitor_samples"        ADD COLUMN "packetsSent"     INTEGER;
ALTER TABLE "asset_monitor_samples"        ADD COLUMN "packetsReceived" INTEGER;
ALTER TABLE "asset_monitor_samples_hourly" ADD COLUMN "packetsSent"     INTEGER;
ALTER TABLE "asset_monitor_samples_hourly" ADD COLUMN "packetsReceived" INTEGER;
ALTER TABLE "asset_monitor_samples_daily"  ADD COLUMN "packetsSent"     INTEGER;
ALTER TABLE "asset_monitor_samples_daily"  ADD COLUMN "packetsReceived" INTEGER;
