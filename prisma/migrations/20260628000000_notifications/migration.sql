-- Notifications: flexible alert rules + triggered notifications + per-rule
-- firing state + Polaris host-metrics time-series.
--
-- Also seeds two new RBAC function keys onto every existing role's permission
-- matrix:
--   notifications        — read=view, write=acknowledge, fullwrite=clear.
--                          admin+assetsadmin=fullwrite, networkadmin+user=write,
--                          readonly=read.
--   notificationManagement — Manage tab + rule CRUD. admin+assetsadmin=fullwrite,
--                          everyone else=none.
-- The gate (requirePermission) reads the stored matrix with no admin bypass, so
-- admin MUST be seeded explicitly. updatedAt is bumped so the in-memory
-- role-snapshot cache refetches.

-- ─── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE "notification_rules" (
  "id"              TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT,
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "severity"        TEXT NOT NULL DEFAULT 'warning',
  "trigger"         JSONB NOT NULL,
  "scope"           JSONB NOT NULL DEFAULT '{}',
  "clearBehavior"   TEXT NOT NULL DEFAULT 'manual',
  "clearAfterSec"   INTEGER,
  "cooldownSec"     INTEGER,
  "messageTemplate" TEXT,
  "channels"        TEXT[] NOT NULL DEFAULT ARRAY['in_app']::TEXT[],
  "createdBy"       TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_rules_enabled_idx" ON "notification_rules"("enabled");

CREATE TABLE "notifications" (
  "id"              TEXT NOT NULL,
  "ruleId"          TEXT,
  "assetId"         TEXT,
  "assetHostname"   TEXT,
  "severity"        TEXT NOT NULL DEFAULT 'warning',
  "message"         TEXT NOT NULL,
  "regionTags"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "triggeredAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged"    BOOLEAN NOT NULL DEFAULT false,
  "acknowledgedBy"  TEXT,
  "acknowledgedAt"  TIMESTAMP(3),
  "acknowledgeNote" TEXT,
  "cleared"         BOOLEAN NOT NULL DEFAULT false,
  "clearedBy"       TEXT,
  "clearedAt"       TIMESTAMP(3),
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notifications_assetId_idx" ON "notifications"("assetId");
CREATE INDEX "notifications_cleared_acknowledged_idx" ON "notifications"("cleared", "acknowledged");
CREATE INDEX "notifications_triggeredAt_idx" ON "notifications"("triggeredAt");

CREATE TABLE "notification_rule_states" (
  "id"                TEXT NOT NULL,
  "ruleId"            TEXT NOT NULL,
  "assetId"           TEXT NOT NULL DEFAULT '',
  "dimensionKey"      TEXT NOT NULL DEFAULT '',
  "state"             TEXT NOT NULL DEFAULT 'clear',
  "conditionMetSince" TIMESTAMP(3),
  "firedAt"           TIMESTAMP(3),
  "lastValue"         DOUBLE PRECISION,
  "notificationId"    TEXT,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_rule_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_rule_states_ruleId_assetId_dimensionKey_key" ON "notification_rule_states"("ruleId", "assetId", "dimensionKey");
CREATE INDEX "notification_rule_states_ruleId_idx" ON "notification_rule_states"("ruleId");

CREATE TABLE "host_metrics_samples" (
  "id"            TEXT NOT NULL,
  "timestamp"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cpuPct"        DOUBLE PRECISION NOT NULL,
  "memUsedPct"    DOUBLE PRECISION NOT NULL,
  "memUsedBytes"  BIGINT NOT NULL,
  "memTotalBytes" BIGINT NOT NULL,
  "loadAvg1"      DOUBLE PRECISION NOT NULL,
  "loadAvg5"      DOUBLE PRECISION NOT NULL,
  "loadAvg15"     DOUBLE PRECISION NOT NULL,
  "procRssBytes"  BIGINT NOT NULL,
  CONSTRAINT "host_metrics_samples_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "host_metrics_samples_timestamp_idx" ON "host_metrics_samples"("timestamp");

-- ─── Foreign keys ─────────────────────────────────────────────────────────────

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_ruleId_fkey" FOREIGN KEY ("ruleId")
  REFERENCES "notification_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notification_rule_states"
  ADD CONSTRAINT "notification_rule_states_ruleId_fkey" FOREIGN KEY ("ruleId")
  REFERENCES "notification_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── RBAC function-key seed ─────────────────────────────────────────────────────

-- notifications: default read for any role missing it, then raise built-ins.
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{notifications}', '"read"', true),
      "updatedAt"   = NOW()
  WHERE NOT ("permissions" ? 'notifications');
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{notifications}', '"fullwrite"', true),
      "updatedAt"   = NOW()
  WHERE "name" IN ('admin', 'assetsadmin');
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{notifications}', '"write"', true),
      "updatedAt"   = NOW()
  WHERE "name" IN ('networkadmin', 'user');
-- readonly keeps the default 'read'.

-- notificationManagement: default none for any role missing it, then raise built-ins.
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{notificationManagement}', '"none"', true),
      "updatedAt"   = NOW()
  WHERE NOT ("permissions" ? 'notificationManagement');
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{notificationManagement}', '"fullwrite"', true),
      "updatedAt"   = NOW()
  WHERE "name" IN ('admin', 'assetsadmin');
