-- AlterTable
ALTER TABLE "monitor_class_overrides" ADD COLUMN     "interfacesPolling" TEXT,
ADD COLUMN     "lldpPolling" TEXT,
ADD COLUMN     "responseTimePolling" TEXT,
ADD COLUMN     "telemetryPolling" TEXT;
