-- Description sync (FMG / standalone FortiGate `syncDescriptions` toggle,
-- Polaris-primary). Device-level: Asset gains an operator-owned `description`
-- (seeded from the device when empty, written back once set) plus a
-- `descriptionSync` state blob { status, at, error? }. Interface-level:
-- AssetInterfaceOverride gains per-row sync state (all-NULL = Polaris-local /
-- never synced — every existing row stays legacy local-only behavior).
ALTER TABLE "assets" ADD COLUMN "description" VARCHAR(255);
ALTER TABLE "assets" ADD COLUMN "descriptionSync" JSONB;

ALTER TABLE "asset_interface_overrides" ADD COLUMN "syncStatus" TEXT;
ALTER TABLE "asset_interface_overrides" ADD COLUMN "lastSyncAt" TIMESTAMP(3);
ALTER TABLE "asset_interface_overrides" ADD COLUMN "syncError" TEXT;
