-- Per-discovery-source view of an asset (phase 1 of the multi-source asset
-- model). The unified `assets` row stays the stable FK target for everything
-- downstream (monitoring, ip-history, sightings, quarantine); `asset_sources`
-- rows hang off it and capture what each discovery integration independently
-- said about the device.
--
-- Phase-1 populates this from existing `assetTag` and tag conventions
-- ("entra:X", "ad:Y", "fortigate:Z", "sid:S-1-...", "ad-guid:G") via a
-- shadow-write Prisma extension and a one-shot backfill job. Phase 2 will
-- cut discovery over to write here as the source of truth.

CREATE TABLE "asset_sources" (
    "id"            TEXT         NOT NULL,
    "assetId"       TEXT         NOT NULL,
    "sourceKind"    TEXT         NOT NULL,
    "externalId"    TEXT         NOT NULL,
    "integrationId" TEXT,
    "observed"      JSONB        NOT NULL DEFAULT '{}',
    "inferred"      BOOLEAN      NOT NULL DEFAULT FALSE,
    "syncedAt"      TIMESTAMP(3),
    "firstSeen"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "asset_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_sources_sourceKind_externalId_key"
    ON "asset_sources" ("sourceKind", "externalId");
CREATE INDEX "asset_sources_assetId_idx"
    ON "asset_sources" ("assetId");
CREATE INDEX "asset_sources_sourceKind_idx"
    ON "asset_sources" ("sourceKind");
CREATE INDEX "asset_sources_integrationId_idx"
    ON "asset_sources" ("integrationId");

ALTER TABLE "asset_sources"
    ADD CONSTRAINT "asset_sources_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_sources"
    ADD CONSTRAINT "asset_sources_integrationId_fkey"
    FOREIGN KEY ("integrationId") REFERENCES "integrations" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
