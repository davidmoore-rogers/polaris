-- Current-state interface inventory: one row per (asset, ifName), delete-replaced
-- per full system-info scrape by `persistInterfaces` -- the AssetPhysicalEntity /
-- AssetMacTableEntry pattern.
--
-- Why: every all-interface consumer wants CURRENT STATE, not history. The System
-- tab renders exactly one timestamp; topology, auto-monitor's pin candidate list
-- and the FortiAP lan1/eth0 name normalization all want "latest row per
-- (assetId, ifName)". Against the hypertable that is a DISTINCT ON which had to be
-- time-bounded after it was measured at 13.5 minutes / 90M rows / 9 GB of I/O on
-- prod. Against this table each one is an indexed lookup over ~one row per
-- interface.
--
-- This is what lets asset_interface_samples carry ONLY operator-pinned interfaces.
-- The unpinned rows existed solely to answer the current-state question above, and
-- they were the worst-value rows in the database: never compressed (deleted at 24h,
-- while the selection-aware compression floor is 2 days), never rolled up, and
-- removed by a row-level DELETE -- the operation behind the 2026-06-08 and
-- 2026-06-17 compressed-chunk bloat incidents.
--
-- Plain table with a real FK: the no-foreign-key rule applies to the TimescaleDB
-- hypertables only, and this is deliberately not one.

CREATE TABLE "asset_interfaces" (
  "id"             TEXT NOT NULL,
  "assetId"        TEXT NOT NULL,
  "ifName"         TEXT NOT NULL,
  "adminStatus"    TEXT,
  "operStatus"     TEXT,
  "speedBps"       BIGINT,
  "ipAddress"      TEXT,
  "macAddress"     TEXT,
  "inOctets"       BIGINT,
  "outOctets"      BIGINT,
  "inErrors"       BIGINT,
  "outErrors"      BIGINT,
  "ifType"         TEXT,
  "ifParent"       TEXT,
  "vlanId"         INTEGER,
  "nativeVlan"     INTEGER,
  "taggedVlans"    INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "trunksAllVlans" BOOLEAN NOT NULL DEFAULT false,
  "alias"          TEXT,
  "description"    TEXT,
  "addressingMode" TEXT,
  "poeStatus"      TEXT,
  "poeClass"       TEXT,
  "firstSeen"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeen"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "asset_interfaces_pkey" PRIMARY KEY ("id")
);

-- Both columns are NOT NULL, so no Postgres NULLs-are-distinct caveat applies here.
CREATE UNIQUE INDEX "asset_interfaces_assetId_ifName_key"
  ON "asset_interfaces" ("assetId", "ifName");
CREATE INDEX "asset_interfaces_assetId_idx"
  ON "asset_interfaces" ("assetId");

ALTER TABLE "asset_interfaces"
  ADD CONSTRAINT "asset_interfaces_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
