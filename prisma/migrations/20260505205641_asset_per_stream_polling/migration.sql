-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "interfacesPolling" TEXT,
ADD COLUMN     "lldpPolling" TEXT,
ADD COLUMN     "responseTimePolling" TEXT,
ADD COLUMN     "telemetryPolling" TEXT;
