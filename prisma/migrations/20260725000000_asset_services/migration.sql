-- Service dimension (Phase 1): current-state systemd unit / Windows service
-- inventory + the two Asset pin arrays that drive per-unit log tailing and
-- connection attribution.
--
-- asset_services is an ordinary Postgres table (NOT a hypertable) — replaced in
-- full per scrape by persistAssetServices (delete-replace), keyed by
-- (assetId, unit), NO FK to assets (matches the AssetProcess / AssetSdwanRule
-- convention). Index / constraint names match Prisma's generated names.

-- ── AssetService (current-state unit/service inventory) ───────────────────
CREATE TABLE "asset_services" (
  "id"           TEXT NOT NULL,
  "assetId"      TEXT NOT NULL,
  "unit"         TEXT NOT NULL,
  "platform"     TEXT NOT NULL,
  "displayName"  TEXT,
  "loadState"    TEXT,
  "activeState"  TEXT,
  "subState"     TEXT,
  "enabledState" TEXT,
  "mainPid"      INTEGER,
  "mainProcess"  TEXT,
  "memBytes"     BIGINT,
  "controllable" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "asset_services_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "asset_services_assetId_unit_key" ON "asset_services"("assetId", "unit");
CREATE INDEX "asset_services_assetId_idx" ON "asset_services"("assetId");

-- ── Asset pin arrays (Services-tab siblings of monitored/mappedProcesses) ──
ALTER TABLE "assets" ADD COLUMN "monitoredServices" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "assets" ADD COLUMN "mappedServices"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
