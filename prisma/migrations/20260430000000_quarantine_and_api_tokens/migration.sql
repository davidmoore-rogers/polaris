-- Quarantine + asset-sighting log + API tokens.
--
-- 1) Adds "quarantined" to the AssetStatus enum.
-- 2) Adds five quarantine columns to the assets table.
-- 3) Creates asset_fortigate_sightings — every (asset, FortiGate) pair where
--    discovery has seen the asset (DHCP lease, DHCP reservation, interface IP,
--    or VIP). Drives the quarantine fan-out: pushing a quarantine writes the
--    asset's MACs to every FortiGate in this list whose lastSeen falls within
--    the configured `quarantine.sightingMaxAgeDays` setting.
-- 4) Creates api_tokens — bearer-token auth for external callers (SIEM etc).

-- 1) AssetStatus enum: add the new "quarantined" variant.
ALTER TYPE "AssetStatus" ADD VALUE IF NOT EXISTS 'quarantined';

-- 2) Quarantine state on Asset.
ALTER TABLE "assets"
    ADD COLUMN "statusBeforeQuarantine" "AssetStatus",
    ADD COLUMN "quarantineReason"       TEXT,
    ADD COLUMN "quarantinedAt"          TIMESTAMP(3),
    ADD COLUMN "quarantinedBy"          TEXT,
    ADD COLUMN "quarantineTargets"      JSONB NOT NULL DEFAULT '[]';

-- 3) Asset → FortiGate sighting log.
CREATE TABLE "asset_fortigate_sightings" (
    "id"              TEXT         NOT NULL,
    "assetId"         TEXT         NOT NULL,
    "integrationId"   TEXT,
    "fortigateDevice" TEXT         NOT NULL,
    "source"          TEXT         NOT NULL,
    "firstSeen"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_fortigate_sightings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_fortigate_sightings_assetId_fortigateDevice_key"
    ON "asset_fortigate_sightings" ("assetId", "fortigateDevice");
CREATE INDEX "asset_fortigate_sightings_assetId_idx"
    ON "asset_fortigate_sightings" ("assetId");
CREATE INDEX "asset_fortigate_sightings_assetId_lastSeen_idx"
    ON "asset_fortigate_sightings" ("assetId", "lastSeen");
CREATE INDEX "asset_fortigate_sightings_integrationId_idx"
    ON "asset_fortigate_sightings" ("integrationId");
CREATE INDEX "asset_fortigate_sightings_fortigateDevice_idx"
    ON "asset_fortigate_sightings" ("fortigateDevice");

ALTER TABLE "asset_fortigate_sightings"
    ADD CONSTRAINT "asset_fortigate_sightings_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_fortigate_sightings"
    ADD CONSTRAINT "asset_fortigate_sightings_integrationId_fkey"
    FOREIGN KEY ("integrationId") REFERENCES "integrations" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) API tokens.
CREATE TABLE "api_tokens" (
    "id"          TEXT         NOT NULL,
    "name"        TEXT         NOT NULL,
    "tokenHash"   TEXT         NOT NULL,
    "tokenPrefix" TEXT         NOT NULL,
    "scopes"      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdBy"   TEXT         NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"   TIMESTAMP(3),
    "lastUsedAt"  TIMESTAMP(3),
    "lastUsedIp"  TEXT,
    "revokedAt"   TIMESTAMP(3),
    "revokedBy"   TEXT,
    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_tokens_name_key"  ON "api_tokens" ("name");
CREATE INDEX "api_tokens_revokedAt_idx"   ON "api_tokens" ("revokedAt");
CREATE INDEX "api_tokens_expiresAt_idx"   ON "api_tokens" ("expiresAt");
