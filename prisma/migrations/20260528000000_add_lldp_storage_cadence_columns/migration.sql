-- Phase 2 carve-out: LLDP + Storage each gain their own pg-boss queue
-- (polaris-monitor-lldp / polaris-monitor-storage), their own resolved
-- cadence, and their own per-asset last-touched stamp.
--
-- The per-asset interval columns mirror the existing cpuMemoryIntervalSec /
-- temperatureIntervalSec / systemInfoIntervalSec pattern (null = inherit
-- from the resolved tier).
--
-- The last*At columns let the publisher in src/jobs/monitorAssets.ts decide
-- when an asset is due for the next LLDP / Storage job — same shape as
-- lastTelemetryAt / lastSystemInfoAt.
ALTER TABLE "assets" ADD COLUMN "lldpIntervalSec"    INTEGER;
ALTER TABLE "assets" ADD COLUMN "storageIntervalSec" INTEGER;
ALTER TABLE "assets" ADD COLUMN "lastLldpAt"         TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "lastStorageAt"      TIMESTAMP(3);
