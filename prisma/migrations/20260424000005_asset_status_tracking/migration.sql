-- AlterTable: track who last changed an asset's status and when
ALTER TABLE "assets" ADD COLUMN "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "statusChangedBy" TEXT;
