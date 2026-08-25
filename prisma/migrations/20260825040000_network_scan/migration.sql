-- Network Discovery (active scan): a saved, re-runnable sweep of
-- operator-supplied IP ranges. Operator-facing name: a **Discovery**.
--
-- 1. network_scans      — the saved configuration (targets / methods /
--                         auto-monitor selection).
-- 2. network_scan_runs  — one row per execution, with DiscoveryRun's
--                         operational columns (cancelRequested,
--                         workerHeartbeatAt) but no one-row-per-parent
--                         uniqueness: run history is wanted, and it is what
--                         lets the wizard reattach to a scan still in flight.
-- 3. Seeds the new RBAC function key onto every existing role's matrix:
--      networkScan — authoring and running a Discovery. Deliberately its own
--                    key rather than part of `assetsProbe` (probe-now / SNMP
--                    walk on ONE existing asset): an active sweep of
--                    operator-supplied ranges is IDS-visible and is exactly
--                    the capability an admin may want to withhold from
--                    someone who may still edit inventory. Adopting the
--                    results is chained on `assets:write` at the route, so
--                    "may scan" and "may create assets" stay separable.
--    The gate (requirePermission) reads the stored matrix with no admin
--    bypass, so admin MUST be seeded explicitly. updatedAt is bumped so the
--    in-memory role-snapshot cache refetches.

-- ─── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE "network_scans" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "targets"     JSONB NOT NULL DEFAULT '[]',
  "methods"     JSONB NOT NULL DEFAULT '[]',
  "autoMonitor" JSONB,
  "createdBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "lastRunAt"   TIMESTAMP(3),
  CONSTRAINT "network_scans_pkey" PRIMARY KEY ("id")
);

-- The name is the operator's handle for a Discovery and round-trips through the
-- .discovery.json filename, so it has to be unique.
CREATE UNIQUE INDEX "network_scans_name_key" ON "network_scans"("name");

CREATE TABLE "network_scan_runs" (
  "id"                 TEXT NOT NULL,
  "scanId"             TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'queued',
  "actor"              TEXT NOT NULL,
  "error"              TEXT,
  "totalTargets"       INTEGER NOT NULL DEFAULT 0,
  "droppedTargetCount" INTEGER NOT NULL DEFAULT 0,
  "scannedCount"       INTEGER NOT NULL DEFAULT 0,
  "hitCount"           INTEGER NOT NULL DEFAULT 0,
  "skippedKnownCount"  INTEGER NOT NULL DEFAULT 0,
  "hits"               JSONB NOT NULL DEFAULT '[]',
  "cancelRequested"    BOOLEAN NOT NULL DEFAULT false,
  "workerHeartbeatAt"  TIMESTAMP(3),
  "startedAt"          TIMESTAMP(3),
  "finishedAt"         TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "network_scan_runs_pkey" PRIMARY KEY ("id")
);

-- Neither table is a hypertable, so the no-FK rule (which is TimescaleDB-only)
-- does not apply: deleting a Discovery should take its run history with it.
ALTER TABLE "network_scan_runs"
  ADD CONSTRAINT "network_scan_runs_scanId_fkey"
  FOREIGN KEY ("scanId") REFERENCES "network_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- "the latest run for this Discovery" (the list's Last run column + reattach).
CREATE INDEX "network_scan_runs_scanId_createdAt_idx" ON "network_scan_runs"("scanId", "createdAt");
-- The stale-run reaper and the is-anything-running check both scan by status.
CREATE INDEX "network_scan_runs_status_idx" ON "network_scan_runs"("status");

-- ─── RBAC function-key seed ─────────────────────────────────────────────────

-- networkScan: default none for any role missing it, then raise the built-ins.
-- networkadmin and assetsadmin get write (they already hold integration
-- discovery / asset write). `user` stays none: that role exists for IP-space
-- self-service and has no business sweeping ranges.
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{networkScan}', '"none"', true),
      "updatedAt"   = NOW()
  WHERE NOT ("permissions" ? 'networkScan');
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{networkScan}', '"fullwrite"', true),
      "updatedAt"   = NOW()
  WHERE "name" = 'admin';
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{networkScan}', '"read"', true),
      "updatedAt"   = NOW()
  WHERE "name" = 'readonly';
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{networkScan}', '"write"', true),
      "updatedAt"   = NOW()
  WHERE "name" IN ('networkadmin', 'assetsadmin');
