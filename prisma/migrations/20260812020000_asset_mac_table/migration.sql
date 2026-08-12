-- Layer-2 MAC forwarding database per switch, from Q-BRIDGE-MIB dot1qTpFdbTable
-- with a BRIDGE-MIB dot1dTpFdbTable fallback. Current-state, delete-replaced per
-- scrape (the AssetLldpNeighbor pattern) -- an FDB entry ages out in minutes and
-- history would answer a question the switch itself cannot answer.
--
-- Plain table with real FKs: the no-foreign-key rule applies to the TimescaleDB
-- hypertables only, and this is deliberately not one.

CREATE TABLE "asset_mac_table_entries" (
  "id"             TEXT NOT NULL,
  "assetId"        TEXT NOT NULL,
  "macAddress"     TEXT NOT NULL,
  "vlanId"         INTEGER,
  "basePort"       INTEGER,
  "ifName"         TEXT,
  "status"         TEXT NOT NULL,
  "matchedAssetId" TEXT,
  "firstSeen"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeen"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "asset_mac_table_entries_pkey" PRIMARY KEY ("id")
);

-- vlanId is nullable and part of the key: the BRIDGE-MIB fallback has no VLAN
-- dimension, so those rows key on (asset, mac, NULL). Postgres treats NULLs as
-- distinct in a UNIQUE index, which is acceptable here because the collector
-- de-duplicates per scrape before writing and the table is fully replaced.
CREATE UNIQUE INDEX "asset_mac_table_entries_assetId_macAddress_vlanId_key"
  ON "asset_mac_table_entries" ("assetId", "macAddress", "vlanId");
CREATE INDEX "asset_mac_table_entries_assetId_idx"
  ON "asset_mac_table_entries" ("assetId");
CREATE INDEX "asset_mac_table_entries_assetId_ifName_idx"
  ON "asset_mac_table_entries" ("assetId", "ifName");
CREATE INDEX "asset_mac_table_entries_macAddress_idx"
  ON "asset_mac_table_entries" ("macAddress");
CREATE INDEX "asset_mac_table_entries_matchedAssetId_idx"
  ON "asset_mac_table_entries" ("matchedAssetId");

ALTER TABLE "asset_mac_table_entries"
  ADD CONSTRAINT "asset_mac_table_entries_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_mac_table_entries"
  ADD CONSTRAINT "asset_mac_table_entries_matchedAssetId_fkey"
  FOREIGN KEY ("matchedAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
