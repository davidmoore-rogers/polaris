-- AlterTable: track when the last PTR lookup ran and the record's TTL
ALTER TABLE "assets" ADD COLUMN "dnsNameFetchedAt" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "dnsNameTtl" INTEGER;
