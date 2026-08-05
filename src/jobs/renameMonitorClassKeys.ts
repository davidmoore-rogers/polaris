/**
 * src/jobs/renameMonitorClassKeys.ts
 *
 * One-shot startup migration that renames the per-class JSON keys in the
 * legacy monitorSettings Setting row from `fortiswitch` / `fortiap` to
 * generic `switch` / `accessPoint`. Phase 0 of the tiered sample-retention
 * work — see the plan for full context.
 *
 * In practice the nested per-class blocks only ever lived inside the legacy
 * `monitorSettings` Setting row (manualMonitorSettings and
 * Integration.config.monitorSettings carry flat tier-3 shapes; per-class
 * overrides live in MonitorClassOverride rows keyed by assetType). The
 * later `migrateMonitorSettingsHierarchy` job deletes the legacy row
 * outright once it has consumed it, so by the time this rename runs on
 * any modern install there is usually nothing to rename. This job exists
 * as a defensive safety net covering fixture data, test setups, partially
 * migrated installs, and the unlikely case of an operator hand-recreating
 * the legacy row.
 *
 * Strategy: copy values forward (don't delete the old keys yet). The
 * backwards-compat reader in `getMonitorSettings()` still falls back to
 * `v.fortiswitch` / `v.fortiap` if the new keys are missing, so a copy is
 * sufficient for the rename to take effect. A follow-up release that
 * deletes the legacy keys can land once we've confirmed the rename worked
 * fleet-wide.
 *
 * Idempotent via the `monitorClassKeysRenamedAt` Setting marker.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { invalidateMonitorSettingsCache } from "../services/monitoringService.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";

const LEGACY_KEY   = "monitorSettings";
const MANUAL_KEY   = "manualMonitorSettings";
const MIGRATED_KEY = "monitorClassKeysRenamedAt";

/**
 * Rewrite a settings JSON blob in place: if `.fortiswitch` is present and
 * `.switch` is absent, copy it; same for `.fortiap` → `.accessPoint`.
 * Returns `{ value, changed }` so the caller knows whether to write back.
 *
 * The old keys are deliberately preserved — the reader still falls back to
 * them, so leaving them in place during the transition window is the safer
 * default. They'll be dropped in a follow-up release.
 */
function renameClassKeys(
  raw: Record<string, unknown> | null | undefined,
): { value: Record<string, unknown>; changed: boolean } {
  const value: Record<string, unknown> = { ...(raw ?? {}) };
  let changed = false;

  if (value.fortiswitch !== undefined && value.switch === undefined) {
    value.switch = value.fortiswitch;
    changed = true;
  }
  if (value.fortiap !== undefined && value.accessPoint === undefined) {
    value.accessPoint = value.fortiap;
    changed = true;
  }
  return { value, changed };
}

(async () => {
  try {
    await runInstrumentedJob("renameMonitorClassKeys", async () => {
      // Idempotency guard.
      if (await hasRunMarker(MIGRATED_KEY)) return;

      let legacyRenamed       = false;
      let manualRenamed       = false;
      let integrationsRenamed = 0;

      // Legacy global Setting (the only spot the per-class shape historically lived).
      const legacyRow = await prisma.setting.findUnique({ where: { key: LEGACY_KEY } });
      if (legacyRow) {
        const { value, changed } = renameClassKeys(legacyRow.value as Record<string, unknown> | null);
        if (changed) {
          await prisma.setting.update({ where: { key: LEGACY_KEY }, data: { value: value as any } });
          legacyRenamed = true;
        }
      }

      // Manual tier — flat in production, but cover the defensive case where
      // a fixture or operator hand-edit dropped nested per-class blocks here.
      const manualRow = await prisma.setting.findUnique({ where: { key: MANUAL_KEY } });
      if (manualRow) {
        const { value, changed } = renameClassKeys(manualRow.value as Record<string, unknown> | null);
        if (changed) {
          await prisma.setting.update({ where: { key: MANUAL_KEY }, data: { value: value as any } });
          manualRenamed = true;
        }
      }

      // Integration tier — same defensive sweep. The seeded shape is flat,
      // but anyone who copied a legacy block into Integration.config by hand
      // gets caught here.
      const integrations = await prisma.integration.findMany({
        select: { id: true, config: true },
      });
      for (const integ of integrations) {
        const cfg = (integ.config && typeof integ.config === "object" ? integ.config : null) as
          | Record<string, unknown>
          | null;
        if (!cfg || !cfg.monitorSettings || typeof cfg.monitorSettings !== "object") continue;
        const { value, changed } = renameClassKeys(cfg.monitorSettings as Record<string, unknown>);
        if (changed) {
          await prisma.integration.update({
            where: { id: integ.id },
            data:  { config: { ...cfg, monitorSettings: value } as any },
          });
          integrationsRenamed++;
        }
      }

      await stampRunMarker(MIGRATED_KEY, { legacyRenamed, manualRenamed, integrationsRenamed });

      // Resolver cache may have warmed up against the pre-rename JSON during
      // the brief startup window before this job ran.
      invalidateMonitorSettingsCache();

      if (legacyRenamed || manualRenamed || integrationsRenamed > 0) {
        logger.info(
          { legacyRenamed, manualRenamed, integrationsRenamed },
          "Monitor-class JSON keys renamed: fortiswitch → switch, fortiap → accessPoint",
        );
      }
    });
  } catch (err) {
    logger.error(
      { err },
      "Monitor-class JSON key rename failed — rerun cleanly by deleting the monitorClassKeysRenamedAt Setting row and restarting",
    );
  }
})();
