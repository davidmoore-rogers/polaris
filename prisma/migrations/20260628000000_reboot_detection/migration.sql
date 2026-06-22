-- Reboot detection (NOC dashboard "Recent Reboots" widget).
-- Captures device sysUpTime from SNMP response-time probes so a decrease
-- between consecutive readings can be detected as a reboot.

-- Per-probe uptime snapshot. Nullable add on the TimescaleDB hypertable —
-- ALTER TABLE ... ADD COLUMN with no default does not rewrite existing rows
-- and is safe against compressed chunks.
ALTER TABLE "asset_monitor_samples" ADD COLUMN "uptimeSec" INTEGER;

-- Asset-level last-known uptime + last detected reboot timestamp.
ALTER TABLE "assets" ADD COLUMN "lastUptimeSec" INTEGER;
ALTER TABLE "assets" ADD COLUMN "lastRebootAt" TIMESTAMP(3);
