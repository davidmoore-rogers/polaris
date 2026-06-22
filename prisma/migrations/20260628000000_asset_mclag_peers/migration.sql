-- Current-state MCLAG (Multi-Chassis LAG) Inter-Chassis-Link peer table, one
-- row per local physical ICL port on a FortiSwitch. Replaced in full per
-- scrape by persistMclagPeers (same delete-replace pattern as
-- asset_lldp_neighbors / asset_sdwan_rules). NOT a TimescaleDB hypertable —
-- plain Postgres, so delete-replace-per-asset is safe (no compressed chunks).
--
-- Sourced from the parent FortiGate's switch-controller managed-switch CMDB:
-- a port with `mclag-icl-port` set names its MCLAG peer in `isl-peer-device-sn`
-- (the canonical pairing key). matchedAssetId resolves that serial to the peer
-- switch's asset row for clickable topology edges + definitive MCLAG-sibling
-- detection in the dependency tree.

CREATE TABLE "asset_mclag_peers" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "localPort" TEXT NOT NULL,
    "iclTrunk" TEXT,
    "peerSn" TEXT NOT NULL,
    "peerName" TEXT,
    "peerPort" TEXT,
    "matchedAssetId" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_mclag_peers_pkey" PRIMARY KEY ("id")
);

-- (assetId, localPort) is the natural identity of an ICL leg on a switch.
CREATE UNIQUE INDEX "asset_mclag_peers_assetId_localPort_key"
    ON "asset_mclag_peers"("assetId", "localPort");

CREATE INDEX "asset_mclag_peers_assetId_idx"
    ON "asset_mclag_peers"("assetId");
CREATE INDEX "asset_mclag_peers_peerSn_idx"
    ON "asset_mclag_peers"("peerSn");
CREATE INDEX "asset_mclag_peers_matchedAssetId_idx"
    ON "asset_mclag_peers"("matchedAssetId");

ALTER TABLE "asset_mclag_peers"
    ADD CONSTRAINT "asset_mclag_peers_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_mclag_peers"
    ADD CONSTRAINT "asset_mclag_peers_matchedAssetId_fkey"
    FOREIGN KEY ("matchedAssetId") REFERENCES "assets"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
