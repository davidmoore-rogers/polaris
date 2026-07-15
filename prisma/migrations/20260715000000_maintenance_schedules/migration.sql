-- Maintenance schedules: operator-defined windows during which matched
-- monitored assets are flipped to status='maintenance' (prior status parked
-- in assets."maintenanceReturnStatus"), all server-driven polling stops,
-- children dependency-suppress, and notifications are silenced.
--
-- Also seeds the new RBAC function key onto every existing role's permission
-- matrix:
--   maintenanceManagement — Maintenance modal + schedule CRUD + the pill
--                           "enter maintenance mode" action.
--                           admin+assetsadmin=fullwrite, everyone else=none.
-- The gate (requirePermission) reads the stored matrix with no admin bypass,
-- so admin MUST be seeded explicitly. updatedAt is bumped so the in-memory
-- role-snapshot cache refetches.

-- ─── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE "maintenance_schedules" (
  "id"        TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "criteria"  JSONB,
  "assetIds"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "schedule"  JSONB NOT NULL,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "maintenance_schedules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "maintenance_schedules_enabled_idx" ON "maintenance_schedules"("enabled");

CREATE TABLE "asset_maintenance_windows" (
  "id"           TEXT NOT NULL,
  "assetId"      TEXT NOT NULL,
  "scheduleId"   TEXT,
  "scheduleName" TEXT NOT NULL,
  "startedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"      TIMESTAMP(3),
  "endReason"    TEXT,
  CONSTRAINT "asset_maintenance_windows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "asset_maintenance_windows_assetId_startedAt_idx" ON "asset_maintenance_windows"("assetId", "startedAt");
CREATE INDEX "asset_maintenance_windows_endedAt_idx" ON "asset_maintenance_windows"("endedAt");

ALTER TABLE "asset_maintenance_windows"
  ADD CONSTRAINT "asset_maintenance_windows_assetId_fkey" FOREIGN KEY ("assetId")
  REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_maintenance_windows"
  ADD CONSTRAINT "asset_maintenance_windows_scheduleId_fkey" FOREIGN KEY ("scheduleId")
  REFERENCES "maintenance_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Asset column ───────────────────────────────────────────────────────────

ALTER TABLE "assets" ADD COLUMN "maintenanceReturnStatus" "AssetStatus";

-- ─── RBAC function-key seed ─────────────────────────────────────────────────

-- maintenanceManagement: default none for any role missing it, then raise built-ins.
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{maintenanceManagement}', '"none"', true),
      "updatedAt"   = NOW()
  WHERE NOT ("permissions" ? 'maintenanceManagement');
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{maintenanceManagement}', '"fullwrite"', true),
      "updatedAt"   = NOW()
  WHERE "name" IN ('admin', 'assetsadmin');
