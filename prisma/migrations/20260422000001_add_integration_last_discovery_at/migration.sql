-- AlterTable: track the timestamp of the most recent auto-discovery run per integration
ALTER TABLE "integrations" ADD COLUMN "lastDiscoveryAt" TIMESTAMP(3);
