-- Asset monitoring + named credentials for monitoring probes.
-- See src/services/monitoringService.ts and src/services/credentialService.ts.

-- ─── New tables ────────────────────────────────────────────────────────────

-- Named credential store for SNMP / WinRM / SSH probes. ICMP needs no
-- credentials; FortiManager / FortiGate-discovered firewalls reuse the
-- discovering integration's API token, so neither uses this table.
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credentials_name_key" ON "credentials"("name");

-- CreateIndex
CREATE INDEX "credentials_type_idx" ON "credentials"("type");

-- Time-series of monitoring probe results. responseTimeMs is null on
-- failure (the "packet loss" signal); the monitor job writes one row per
-- probe and prunes rows older than monitor.sampleRetentionDays daily.
CREATE TABLE "asset_monitor_samples" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "responseTimeMs" INTEGER,
    "error" TEXT,

    CONSTRAINT "asset_monitor_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_monitor_samples_assetId_timestamp_idx" ON "asset_monitor_samples"("assetId", "timestamp");

-- ─── Asset columns ─────────────────────────────────────────────────────────

ALTER TABLE "assets"
    ADD COLUMN "discoveredByIntegrationId" TEXT,
    ADD COLUMN "monitored" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "monitorType" TEXT,
    ADD COLUMN "monitorCredentialId" TEXT,
    ADD COLUMN "monitorIntervalSec" INTEGER,
    ADD COLUMN "monitorStatus" TEXT,
    ADD COLUMN "lastMonitorAt" TIMESTAMP(3),
    ADD COLUMN "lastResponseTimeMs" INTEGER,
    ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "assets_discoveredByIntegrationId_idx" ON "assets"("discoveredByIntegrationId");

-- CreateIndex
CREATE INDEX "assets_monitored_idx" ON "assets"("monitored");

-- CreateIndex (covering index used by the monitor job to find due assets)
CREATE INDEX "assets_monitored_lastMonitorAt_idx" ON "assets"("monitored", "lastMonitorAt");

-- ─── Foreign keys ──────────────────────────────────────────────────────────

ALTER TABLE "asset_monitor_samples"
    ADD CONSTRAINT "asset_monitor_samples_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assets"
    ADD CONSTRAINT "assets_discoveredByIntegrationId_fkey"
    FOREIGN KEY ("discoveredByIntegrationId") REFERENCES "integrations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "assets"
    ADD CONSTRAINT "assets_monitorCredentialId_fkey"
    FOREIGN KEY ("monitorCredentialId") REFERENCES "credentials"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
