/**
 * src/jobs/migrateAutomationRuleShape.ts
 *
 * One-shot startup migration: persist the rule-shape-v2 view (`reset` +
 * `actions` Json columns) onto every NotificationRule row still carrying
 * NULLs there — i.e. rules created before the Automations v2 cutover.
 *
 * The conversion is the SAME pure function every reader already normalizes
 * through (normalizeRuleToV2 in notificationTypes.ts):
 *   clearBehavior/clearAfterSec → reset { mode, afterSec? }
 *   targets (+ rule-level emailComposition copied per-action) → notify actions
 * so behavior is identical before and after this job runs — persisting just
 * makes the v2 shape visible to API consumers and future writers.
 *
 * Legacy columns are deliberately NOT nulled: they stay as the lossless
 * mirror (kept up to date by rule CRUD via legacyMirrorOfV2) so pre-wizard
 * UIs and restored pre-upgrade backups stay coherent, and rollback to a
 * pre-v2 build loses nothing.
 *
 * Idempotency: marker key "automationRuleShapeV2MigratedAt" in Setting,
 * plus the WHERE reset IS NULL filter (safe to re-run after restores).
 * Recovery: delete the marker Setting and restart.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { runInstrumentedJob } from "./_metrics.js";
import { normalizeRuleToV2 } from "../services/notificationTypes.js";

const MIGRATED_KEY = "automationRuleShapeV2MigratedAt";

(async () => {
  try {
    await runInstrumentedJob("migrateAutomationRuleShape", async () => {
      const migratedRow = await prisma.setting.findUnique({ where: { key: MIGRATED_KEY } });
      if (migratedRow) return;

      const rows = await prisma.notificationRule.findMany({
        where: { reset: { equals: Prisma.AnyNull } as never },
        select: {
          id: true,
          clearBehavior: true,
          clearAfterSec: true,
          targets: true,
          emailComposition: true,
          escalation: true,
          reset: true,
          actions: true,
        },
      });

      let updated = 0;
      for (const row of rows) {
        const v2 = normalizeRuleToV2(row);
        await prisma.notificationRule.update({
          where: { id: row.id },
          data: { reset: v2.reset as never, actions: v2.actions as never },
        });
        updated++;
      }

      await prisma.setting.create({
        data: {
          key: MIGRATED_KEY,
          value: { migratedAt: new Date().toISOString(), rowsUpdated: updated } as never,
        },
      });

      if (updated > 0) {
        logger.info({ rowsUpdated: updated }, "Persisted rule-shape v2 (reset/actions) onto pre-v2 notification rules");
      }
    });
  } catch (err) {
    logger.error(
      { err },
      "automation rule-shape v2 startup migration failed — recovery: delete the automationRuleShapeV2MigratedAt Setting and restart",
    );
  }
})();
