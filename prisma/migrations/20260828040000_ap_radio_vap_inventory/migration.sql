-- FortiAP radio + broadcast-SSID inventory.
--
-- The Stations tab has always shown the leaves of the wireless tree — the
-- connected clients — with nothing above them: which radio a station is on,
-- what channel and width that radio is running, at what power, and which of
-- the AP's SSIDs the client actually joined. These two tables are the two
-- missing levels, so the tab can render radio → SSID → station.
--
-- Both are current-state, delete-replaced per scrape, plain tables with real
-- FKs and NOT hypertables — the AssetInterface / AssetLldpNeighbor shape.
-- Nobody wants a timeline of what channel a radio was on; they want the one
-- it is on, and the channel that CHANGED is an Event's job, not a sample's.
--
-- Two writers, carrying complementary columns: the controller's
-- /api/v2/monitor/wifi/managed_ap `radio[]` array (source 'fortios', reaching
-- every managed AP whether or not SNMP is enabled on it) and the AP's own
-- FORTINET-FORTIAP-MIB fapRadioTable (source 'snmp', which is the only source
-- for the tx-power floor and ceiling). The upsert merges per column so a
-- source that doesn't collect a column never erases what the other one
-- established. See the model comments in prisma/schema.prisma.

-- ─── asset_ap_radios ────────────────────────────────────────────────────────

CREATE TABLE "asset_ap_radios" (
    "id"            TEXT NOT NULL,
    "assetId"       TEXT NOT NULL,
    -- fapRadioIndex / the controller's radio-id. The key the AP's VAPs and its
    -- stations (asset_wireless_stations."radioId") both hang off.
    "radioIndex"    INTEGER NOT NULL,
    "radioType"     TEXT,
    "band"          TEXT,
    "mode"          TEXT,
    -- What the radio is ACTUALLY on, which on a DFS-capable radio is not what
    -- was configured.
    "channel"       INTEGER,
    "bandwidthMhz"  INTEGER,
    -- FortiOS reports power as a percentage of the radio's ceiling; the MIB
    -- reports dBm and is the only source for the floor/ceiling. Kept apart
    -- rather than normalized — converting needs a per-model maximum Polaris
    -- does not have.
    "txPowerPct"    INTEGER,
    "txPowerDbm"    INTEGER,
    "txPowerMinDbm" INTEGER,
    "txPowerMaxDbm" INTEGER,
    "txPowerMode"   TEXT,
    "baseBssid"     TEXT,
    "clientCount"   INTEGER,
    "countryCode"   TEXT,
    "source"        TEXT NOT NULL,
    "firstSeen"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_ap_radios_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_ap_radios_assetId_radioIndex_key" ON "asset_ap_radios"("assetId", "radioIndex");
CREATE INDEX "asset_ap_radios_assetId_idx" ON "asset_ap_radios"("assetId");

ALTER TABLE "asset_ap_radios" ADD CONSTRAINT "asset_ap_radios_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── asset_ap_vaps ──────────────────────────────────────────────────────────

CREATE TABLE "asset_ap_vaps" (
    "id"          TEXT NOT NULL,
    "assetId"     TEXT NOT NULL,
    "radioIndex"  INTEGER NOT NULL,
    -- Identity is the VAP object name, NOT the SSID (several VAPs commonly
    -- broadcast one SSID) and NOT the BSSID (absent on sources that don't
    -- publish it).
    "vapName"     TEXT NOT NULL,
    "ssid"        TEXT,
    -- The join key down to asset_wireless_stations."bssid" — how Polaris says
    -- which SSID a station is actually on.
    "bssid"       TEXT,
    "vlanId"      INTEGER,
    "clientCount" INTEGER,
    "source"      TEXT NOT NULL,
    "firstSeen"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_ap_vaps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_ap_vaps_assetId_radioIndex_vapName_key" ON "asset_ap_vaps"("assetId", "radioIndex", "vapName");
CREATE INDEX "asset_ap_vaps_assetId_idx" ON "asset_ap_vaps"("assetId");
CREATE INDEX "asset_ap_vaps_assetId_radioIndex_idx" ON "asset_ap_vaps"("assetId", "radioIndex");
-- The "Broadcast SSID" device-filter option list is one GROUP BY over this
-- column across the monitored fleet.
CREATE INDEX "asset_ap_vaps_ssid_idx" ON "asset_ap_vaps"("ssid");

ALTER TABLE "asset_ap_vaps" ADD CONSTRAINT "asset_ap_vaps_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
