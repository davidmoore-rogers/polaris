-- The FortiGate's layer-3 neighbour cache, one row per (IP, MAC, interface)
-- binding the gate currently holds. The L3 sibling of asset_mac_table_entries:
-- that table answers "what is plugged into port 7" from a switch's forwarding
-- database, this one answers "what is at 10.4.12.63" from the router's own
-- resolution of the address.
--
-- CURRENT-STATE, delete-replaced per discovery cycle by
-- `persistFortigateArpTables` -- the asset_mac_table_entries /
-- asset_lldp_neighbors pattern. A FortiOS ARP entry ages out of the cache in
-- ~1-5 minutes, so history here would answer a question the gate itself cannot.
--
-- The rows were ALREADY being read on every FMG / standalone-FortiGate discovery
-- cycle (they feed empty-ipAddress enrichment, Reservation.lastSeenArp presence
-- evidence and placeholder-MAC adoption) and were consumed in memory and thrown
-- away. This table is where they land so the operator can read them too.
--
-- Plain table with a real FK: the no-foreign-key rule applies to the TimescaleDB
-- hypertables only, and this is deliberately not one.

CREATE TABLE "asset_arp_entries" (
  "id"             TEXT NOT NULL,
  "assetId"        TEXT NOT NULL,
  "ipAddress"      TEXT NOT NULL,
  "macAddress"     TEXT NOT NULL,
  "ifName"         TEXT,
  "ageSec"         INTEGER,
  "matchedAssetId" TEXT,
  "firstSeen"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeen"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "asset_arp_entries_pkey" PRIMARY KEY ("id")
);

-- "ifName" is nullable, so Postgres treats two NULL-interface rows for the same
-- (asset, ip, mac) as distinct and this index will not catch them. The writer
-- dedupes on the same key with NULL folded to "" before it inserts, which is
-- what actually enforces uniqueness -- same caveat as
-- asset_mac_table_entries("vlanId").
CREATE UNIQUE INDEX "asset_arp_entries_assetId_ipAddress_macAddress_ifName_key"
  ON "asset_arp_entries" ("assetId", "ipAddress", "macAddress", "ifName");
CREATE INDEX "asset_arp_entries_assetId_idx"
  ON "asset_arp_entries" ("assetId");
CREATE INDEX "asset_arp_entries_assetId_ifName_idx"
  ON "asset_arp_entries" ("assetId", "ifName");
CREATE INDEX "asset_arp_entries_macAddress_idx"
  ON "asset_arp_entries" ("macAddress");
CREATE INDEX "asset_arp_entries_ipAddress_idx"
  ON "asset_arp_entries" ("ipAddress");
CREATE INDEX "asset_arp_entries_matchedAssetId_idx"
  ON "asset_arp_entries" ("matchedAssetId");

ALTER TABLE "asset_arp_entries"
  ADD CONSTRAINT "asset_arp_entries_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_arp_entries"
  ADD CONSTRAINT "asset_arp_entries_matchedAssetId_fkey"
  FOREIGN KEY ("matchedAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
