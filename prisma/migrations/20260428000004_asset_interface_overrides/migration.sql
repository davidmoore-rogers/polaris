-- Operator-typed "Interface Comments" override per (asset, ifName). Takes
-- priority over the discovered AssetInterfaceSample.description for display.
-- Cleared by deleting the row (or PUT'ing description = null).
CREATE TABLE "asset_interface_overrides" (
  "id"          TEXT NOT NULL,
  "assetId"     TEXT NOT NULL,
  "ifName"      TEXT NOT NULL,
  "description" VARCHAR(255),
  "updatedBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "asset_interface_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_interface_overrides_assetId_ifName_key"
  ON "asset_interface_overrides"("assetId", "ifName");

CREATE INDEX "asset_interface_overrides_assetId_idx"
  ON "asset_interface_overrides"("assetId");

ALTER TABLE "asset_interface_overrides"
  ADD CONSTRAINT "asset_interface_overrides_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
