-- Field-replaceable hardware inventory from ENTITY-MIB entPhysicalTable
-- (transceivers, PSUs, fan trays). Current-state, delete-replaced per scrape --
-- the AssetLldpNeighbor / AssetMclagPeer pattern.
--
-- Plain table with a real FK: the no-foreign-key rule applies to the TimescaleDB
-- hypertables only, and this is deliberately not one. Inventory is not a time
-- series; it changes on a maintenance window, and 90 days of identical rows
-- would answer no question the audit Event does not answer better.

CREATE TABLE "asset_physical_entities" (
  "id"          TEXT NOT NULL,
  "assetId"     TEXT NOT NULL,
  "entIndex"    INTEGER NOT NULL,
  "entClass"    TEXT NOT NULL,
  "descr"       TEXT,
  "name"        TEXT,
  "hardwareRev" TEXT,
  "firmwareRev" TEXT,
  "serialNum"   TEXT,
  "mfgName"     TEXT,
  "modelName"   TEXT,
  "isFru"       BOOLEAN NOT NULL DEFAULT false,
  "ifName"      TEXT,
  "firstSeen"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeen"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "asset_physical_entities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_physical_entities_assetId_entIndex_key"
  ON "asset_physical_entities" ("assetId", "entIndex");
CREATE INDEX "asset_physical_entities_assetId_idx"
  ON "asset_physical_entities" ("assetId");
CREATE INDEX "asset_physical_entities_assetId_entClass_idx"
  ON "asset_physical_entities" ("assetId", "entClass");

ALTER TABLE "asset_physical_entities"
  ADD CONSTRAINT "asset_physical_entities_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
