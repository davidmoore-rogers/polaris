/**
 * src/jobs/migrateMonitorStatusRename.ts
 *
 * One-shot startup migration: renames the recovery state on
 * `Asset.monitorStatus` from the legacy value "pending" to "recovering".
 *
 * Background: the five-state monitor machine had two transitional states
 * ("warning" for was-up-now-failing and "pending" for was-down-now-
 * succeeding). Operators read "Pending" as "we don't know yet" rather
 * than the directional "recovering from down", so the user-facing label
 * was renamed. Internal state value followed for consistency.
 *
 * After this job runs, no Asset rows carry the legacy "pending" value.
 * The state machine in monitoringService writes "recovering" exclusively;
 * the never-probed status remains "unknown" / null and is rendered as
 * "Pending" in the UI for clarity.
 *
 * Idempotency: marker key "monitorStatusRenamePendingMigratedAt" in the
 * Setting table. Subsequent boots no-op.
 *
 * Recovery: delete the marker (`DELETE FROM "settings" WHERE key =
 * 'monitorStatusRenamePendingMigratedAt'`) and restart.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";

const MIGRATED_KEY = "monitorStatusRenamePendingMigratedAt";

(async () => {
  try {
    await runInstrumentedJob("migrateMonitorStatusRename", async () => {
      if (await hasRunMarker(MIGRATED_KEY)) return;

      const result = await prisma.asset.updateMany({
        where: { monitorStatus: "pending" },
        data:  { monitorStatus: "recovering" },
      });

      await stampRunMarker(MIGRATED_KEY, { rowsUpdated: result.count });

      if (result.count > 0) {
        logger.info({ rowsUpdated: result.count }, "Renamed Asset.monitorStatus from 'pending' to 'recovering'");
      }
    });
  } catch (err) {
    logger.error(
      { err },
      "monitorStatus rename startup migration failed — recovery: delete the monitorStatusRenamePendingMigratedAt Setting and restart",
    );
  }
})();
