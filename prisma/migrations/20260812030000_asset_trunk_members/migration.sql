-- FortiSwitch trunk -> local physical port, from the vendor OctetString at
-- 1.3.6.1.4.1.12356.106.3.1.1.0. Current-state, delete-replaced per scrape
-- (the AssetLldpNeighbor / AssetMclagPeer pattern). Plain table with real FKs:
-- the no-foreign-key rule applies to the TimescaleDB hypertables only.

CREATE TABLE "asset_trunk_members" (
  "id"             TEXT NOT NULL,
  "assetId"        TEXT NOT NULL,
  "trunkName"      TEXT NOT NULL,
  "localPort"      TEXT NOT NULL,
  "peerSerialTail" TEXT NOT NULL,
  "matchedAssetId" TEXT,
  "firstSeen"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeen"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "asset_trunk_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_trunk_members_assetId_trunkName_localPort_key"
  ON "asset_trunk_members" ("assetId", "trunkName", "localPort");
CREATE INDEX "asset_trunk_members_assetId_idx"        ON "asset_trunk_members" ("assetId");
CREATE INDEX "asset_trunk_members_assetId_localPort_idx" ON "asset_trunk_members" ("assetId", "localPort");
CREATE INDEX "asset_trunk_members_matchedAssetId_idx" ON "asset_trunk_members" ("matchedAssetId");

ALTER TABLE "asset_trunk_members"
  ADD CONSTRAINT "asset_trunk_members_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_trunk_members"
  ADD CONSTRAINT "asset_trunk_members_matchedAssetId_fkey"
  FOREIGN KEY ("matchedAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
