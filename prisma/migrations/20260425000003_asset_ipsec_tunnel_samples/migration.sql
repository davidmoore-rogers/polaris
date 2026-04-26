-- Per-tunnel IPsec snapshot for the System tab. FortiOS only — populated by
-- monitoringService.collectIpsecTunnelsFortinet on the system-info cadence.
-- One row per phase-1 tunnel; status rolls phase-2 selectors up to up/down/partial.

CREATE TABLE "asset_ipsec_tunnel_samples" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tunnelName" TEXT NOT NULL,
    "remoteGateway" TEXT,
    "status" TEXT NOT NULL,
    "incomingBytes" BIGINT,
    "outgoingBytes" BIGINT,
    "proxyIdCount" INTEGER,

    CONSTRAINT "asset_ipsec_tunnel_samples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_ipsec_tunnel_samples_assetId_timestamp_idx"
    ON "asset_ipsec_tunnel_samples"("assetId", "timestamp");
CREATE INDEX "asset_ipsec_tunnel_samples_assetId_tunnelName_timestamp_idx"
    ON "asset_ipsec_tunnel_samples"("assetId", "tunnelName", "timestamp");

ALTER TABLE "asset_ipsec_tunnel_samples"
    ADD CONSTRAINT "asset_ipsec_tunnel_samples_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
