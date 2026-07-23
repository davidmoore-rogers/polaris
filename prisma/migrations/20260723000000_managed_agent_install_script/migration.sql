-- Curated install-method variant chosen at agent deploy time.
-- Catalog id from src/services/agentInstallScripts.ts (e.g. "linux-systemd").
-- NULL = the per-OS default (pre-picker installs + discovery auto-deploy),
-- so existing rows keep working with no backfill needed.
ALTER TABLE "managed_agents" ADD COLUMN "installScriptId" TEXT;
