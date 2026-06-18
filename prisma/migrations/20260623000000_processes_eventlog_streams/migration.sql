-- Cross-transport "processes" + "eventLog" monitoring streams.
--
-- Adds the polling-method-model columns for two new first-class streams to the
-- per-asset tier (`assets`) and the class/integration override tier
-- (`monitor_class_overrides`), exactly mirroring the existing interfaces /
-- storage / customWidget stream columns. All columns are NULLABLE with no
-- default: null = "inherit from the tier below" in resolveMonitorSettings, so
-- existing rows need no backfill and keep current behaviour (these streams
-- resolve to the hardcoded floor, which defaults them to "disabled").
--
-- Per-stream method sets (enforced in code by utils/pollingCompatibility
-- STREAM_METHODS + the monitorSettings route validation):
--   processes — agent / snmp (hrSWRunTable) / ssh / winrm   (no rest, no icmp)
--   eventLog  — agent / ssh / winrm / rest_api (FortiOS log) (no snmp, no icmp)
--
-- Both target tables are plain Postgres tables (NOT TimescaleDB hypertables),
-- so straight ADD COLUMN is safe — no compressed-chunk considerations.

-- ─── assets (per-asset tier) ────────────────────────────────────────────────
ALTER TABLE "assets" ADD COLUMN "processesPolling"      TEXT;
ALTER TABLE "assets" ADD COLUMN "eventLogPolling"       TEXT;
ALTER TABLE "assets" ADD COLUMN "processesMibId"        TEXT;
ALTER TABLE "assets" ADD COLUMN "processesIntervalSec"  INTEGER;
ALTER TABLE "assets" ADD COLUMN "eventLogIntervalSec"   INTEGER;
ALTER TABLE "assets" ADD COLUMN "processesTimeoutMs"    INTEGER;
ALTER TABLE "assets" ADD COLUMN "eventLogTimeoutMs"     INTEGER;
ALTER TABLE "assets" ADD COLUMN "processesCredentialId" TEXT;
ALTER TABLE "assets" ADD COLUMN "eventLogCredentialId"  TEXT;

ALTER TABLE "assets" ADD CONSTRAINT "assets_processesCredentialId_fkey"
  FOREIGN KEY ("processesCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "assets_processesCredentialId_idx" ON "assets"("processesCredentialId");

ALTER TABLE "assets" ADD CONSTRAINT "assets_eventLogCredentialId_fkey"
  FOREIGN KEY ("eventLogCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "assets_eventLogCredentialId_idx" ON "assets"("eventLogCredentialId");

-- ─── monitor_class_overrides (class / integration tier) ─────────────────────
ALTER TABLE "monitor_class_overrides" ADD COLUMN "processesPolling"          TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "eventLogPolling"           TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "processesMibId"            TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "processesIntervalSeconds"  INTEGER;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "eventLogIntervalSeconds"   INTEGER;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "processesTimeoutMs"        INTEGER;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "eventLogTimeoutMs"         INTEGER;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "processesCredentialId"     TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "eventLogCredentialId"      TEXT;

ALTER TABLE "monitor_class_overrides" ADD CONSTRAINT "monitor_class_overrides_processesCredentialId_fkey"
  FOREIGN KEY ("processesCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "monitor_class_overrides_processesCredentialId_idx" ON "monitor_class_overrides"("processesCredentialId");

ALTER TABLE "monitor_class_overrides" ADD CONSTRAINT "monitor_class_overrides_eventLogCredentialId_fkey"
  FOREIGN KEY ("eventLogCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "monitor_class_overrides_eventLogCredentialId_idx" ON "monitor_class_overrides"("eventLogCredentialId");
