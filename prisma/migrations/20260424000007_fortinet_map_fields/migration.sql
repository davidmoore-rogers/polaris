-- AlterTable: add Fortinet map coordinates + topology graph to Asset
ALTER TABLE "assets"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "fortinetTopology" JSONB;

-- Partial index so the map endpoint only scans FortiGates with coords
CREATE INDEX "assets_latitude_longitude_idx"
  ON "assets" ("latitude", "longitude")
  WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;
