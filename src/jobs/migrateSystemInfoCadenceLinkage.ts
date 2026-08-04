/**
 * src/jobs/migrateSystemInfoCadenceLinkage.ts
 *
 * One-shot startup migration. For every integration whose stored
 * `Integration.config.monitorSettings.systemInfoIntervalSeconds` equals the
 * literal hardcoded default (600s), rewrite it to null so the
 * resolver's new tier-4 step derives the cadence from
 * `integration.pollInterval × 3600` instead.
 *
 * Background: the systemInfo cadence (interfaces + LLDP + storage + IPsec)
 * used to default to 600s across every monitored asset. On fleets with
 * dozens of switches and access points, the resulting per-interface sample
 * volume dominates DB size — observed 94 GB on production at Rogers Group.
 * Linking the cadence to each integration's discovery `pollInterval` (1–24h,
 * default 4h) cuts that volume by 24× at the default while keeping a
 * single, intuitive operator knob.
 *
 * Operators who explicitly typed any value other than 600 are NOT touched —
 * a deliberate operator choice survives. The rewrite only catches the
 * unconfigured-default population, which is the storage-cost majority.
 *
 * Writes one `monitor_settings.systemInfo_cadence_linked` Event per
 * affected integration with `{ previousValue: 600, newDerivedCadenceSec }`
 * for the audit trail. Invalidates the resolver cache at the end so the
 * next monitor pass picks up the new value without a process restart.
 *
 * Idempotent via the `systemInfoCadenceLinkageMigratedAt` Setting marker.
 * Recovery: delete the marker and restart.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { logEvent } from "../services/eventLogService.js";
import { invalidateMonitorSettingsCache } from "../services/monitoringService.js";
import { runInstrumentedJob } from "./_metrics.js";

const MIGRATED_KEY = "systemInfoCadenceLinkageMigratedAt";
const HARDCODED_FLOOR_SYSINFO_SEC = 600;

(async () => {
  try {
    await runInstrumentedJob("migrateSystemInfoCadenceLinkage", async () => {
      const migratedRow = await prisma.setting.findUnique({ where: { key: MIGRATED_KEY } });
      if (migratedRow) return;

      const integrations = await prisma.integration.findMany({
        select: { id: true, name: true, pollInterval: true, config: true },
      });

      const affected: Array<{ id: string; name: string; derivedSec: number }> = [];

      for (const integration of integrations) {
        const cfg = (integration.config as Record<string, unknown> | null) ?? null;
        if (!cfg) continue;
        const ms = cfg.monitorSettings as Record<string, unknown> | undefined;
        if (!ms) continue;
        const v = ms.systemInfoIntervalSeconds;
        if (typeof v !== "number" || v !== HARDCODED_FLOOR_SYSINFO_SEC) continue;

        // Rewrite to null so the resolver derives from pollInterval.
        const newMs = { ...ms, systemInfoIntervalSeconds: null };
        const newCfg = { ...cfg, monitorSettings: newMs };
        await prisma.integration.update({
          where: { id: integration.id },
          data:  { config: newCfg as any },
        });

        const pollHours = integration.pollInterval ?? null;
        const derivedSec = pollHours != null && pollHours > 0
          ? Math.max(60, Math.min(86400, pollHours * 3600))
          : HARDCODED_FLOOR_SYSINFO_SEC;

        affected.push({ id: integration.id, name: integration.name, derivedSec });

        await logEvent({
          action:       "monitor_settings.systemInfo_cadence_linked",
          resourceType: "integration",
          resourceId:   integration.id,
          resourceName: integration.name,
          actor:        "system:migrateSystemInfoCadenceLinkage",
          message:      `systemInfo cadence linked to discovery pollInterval for "${integration.name}" (was 600s, now ${derivedSec}s)`,
          details: {
            previousValue: HARDCODED_FLOOR_SYSINFO_SEC,
            pollIntervalHours: pollHours,
            newDerivedCadenceSec: derivedSec,
          },
        });
      }

      if (affected.length > 0) {
        invalidateMonitorSettingsCache();
      }

      await prisma.setting.create({
        data: {
          key: MIGRATED_KEY,
          value: {
            migratedAt: new Date().toISOString(),
            affectedCount: affected.length,
            affected,
          } as any,
        },
      });

      if (affected.length > 0) {
        logger.info(
          { count: affected.length, affected },
          "systemInfo cadence linked to discovery pollInterval for integrations using the 600s default",
        );
      }
    });
  } catch (err) {
    logger.error(
      { err },
      "systemInfo cadence linkage migration failed — rerun by deleting the systemInfoCadenceLinkageMigratedAt Setting row and restarting",
    );
  }
})();
