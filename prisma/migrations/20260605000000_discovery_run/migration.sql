-- DiscoveryRun — cross-process live state for a discovery run.
--
-- Replaces the former in-memory `activeDiscovery` Map in integrations.ts so the
-- web process can render progress + signal cancel while a separate discovery
-- process executes the run. One row per integration (`integrationId` UNIQUE) is
-- the DB-level "one active run per integration" invariant, paired with the
-- pg-boss discovery queue's singletonKey. Additive — no backfill; existing rows
-- are unaffected because the table is new.

CREATE TABLE "discovery_runs" (
    "id"                  TEXT NOT NULL,
    "integrationId"       TEXT NOT NULL,
    "integrationName"     TEXT NOT NULL,
    "type"                TEXT NOT NULL,
    "status"              TEXT NOT NULL DEFAULT 'queued',
    "actor"               TEXT NOT NULL,
    "startedAt"           TIMESTAMP(3),
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    "finishedAt"          TIMESTAMP(3),
    "totalDevices"        INTEGER,
    "completedCount"      INTEGER NOT NULL DEFAULT 0,
    "skippedOfflineCount" INTEGER NOT NULL DEFAULT 0,
    "skippedErrorCount"   INTEGER NOT NULL DEFAULT 0,
    "activeDevices"       JSONB NOT NULL DEFAULT '[]',
    "slowAlerted"         BOOLEAN NOT NULL DEFAULT false,
    "slowAlertedDevices"  JSONB NOT NULL DEFAULT '[]',
    "cancelRequested"     BOOLEAN NOT NULL DEFAULT false,
    "workerHeartbeatAt"   TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discovery_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "discovery_runs_integrationId_key" ON "discovery_runs"("integrationId");

CREATE INDEX "discovery_runs_status_idx" ON "discovery_runs"("status");
