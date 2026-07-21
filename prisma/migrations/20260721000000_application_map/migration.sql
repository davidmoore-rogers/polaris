-- Application Map: process-connectivity topology.
--
-- 1. asset_process_connections — accumulate+age socket facts (listening ports,
--    outbound connections, inbound peers) for MAPPED processes. Upserted on
--    the business key (lastSeen bumped, firstSeen kept), pruned when lastSeen
--    exceeds the retention window. NOT a hypertable → real FK to assets.
-- 2. application_map_layouts — shared drag layout for the Application Map page
--    (TopologyLayout pattern without the per-site FK).
-- 3. assets.mappedProcesses — the Processes-tab "Map" toggle pin array;
--    assets.lastProcessesAt / lastProcessPinsAt — agentless (ssh/winrm)
--    processes-stream cadence anchors (inventory pass / 60s pinned+mapped pass).
-- 4. Seeds the new RBAC function key onto every existing role's matrix:
--      applicationMap — the Application Map page + graph API (read) and the
--                       shared-layout save/reset (write).
--                       Mirrors deviceMap: admin=fullwrite, other built-ins=read.
--    The gate (requirePermission) reads the stored matrix with no admin bypass,
--    so admin MUST be seeded explicitly. updatedAt is bumped so the in-memory
--    role-snapshot cache refetches.

-- ─── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE "asset_process_connections" (
  "id"          TEXT NOT NULL,
  "assetId"     TEXT NOT NULL,
  "processName" TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "proto"       TEXT NOT NULL,
  "localAddr"   TEXT NOT NULL DEFAULT '',
  "localPort"   INTEGER NOT NULL DEFAULT 0,
  "remoteIp"    TEXT NOT NULL DEFAULT '',
  "remotePort"  INTEGER NOT NULL DEFAULT 0,
  "firstSeen"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeen"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_process_connections_pkey" PRIMARY KEY ("id")
);
-- Business-key unique index — the ON CONFLICT target of the batch upsert.
CREATE UNIQUE INDEX "asset_process_connections_bizkey"
  ON "asset_process_connections"("assetId", "processName", "kind", "proto", "localAddr", "localPort", "remoteIp", "remotePort");
CREATE INDEX "asset_process_connections_assetId_processName_idx"
  ON "asset_process_connections"("assetId", "processName");
CREATE INDEX "asset_process_connections_remoteIp_idx"
  ON "asset_process_connections"("remoteIp");
-- Deliberately no index on lastSeen: keeps the per-minute bumps HOT updates;
-- the daily prune seq-scans a small table.

ALTER TABLE "asset_process_connections"
  ADD CONSTRAINT "asset_process_connections_assetId_fkey" FOREIGN KEY ("assetId")
  REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "application_map_layouts" (
  "id"         TEXT NOT NULL,
  "view"       TEXT NOT NULL DEFAULT 'global',
  "positions"  JSONB NOT NULL,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "application_map_layouts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "application_map_layouts_view_key" ON "application_map_layouts"("view");

-- ─── Asset columns ──────────────────────────────────────────────────────────

ALTER TABLE "assets" ADD COLUMN "mappedProcesses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "assets" ADD COLUMN "lastProcessesAt" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "lastProcessPinsAt" TIMESTAMP(3);

-- ─── RBAC function-key seed ─────────────────────────────────────────────────

-- applicationMap: default none for any role missing it, then raise built-ins
-- (mirrors deviceMap's seeded levels).
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{applicationMap}', '"none"', true),
      "updatedAt"   = NOW()
  WHERE NOT ("permissions" ? 'applicationMap');
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{applicationMap}', '"fullwrite"', true),
      "updatedAt"   = NOW()
  WHERE "name" = 'admin';
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{applicationMap}', '"read"', true),
      "updatedAt"   = NOW()
  WHERE "name" IN ('readonly', 'networkadmin', 'assetsadmin', 'user');
