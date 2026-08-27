/**
 * src/jobs/clampMonitoredForStatus.ts
 *
 * One-shot startup job: enforces "an unmonitorable status cannot be monitored"
 * (business rule 10) on existing Asset rows — decommissioned / disabled /
 * storage / quarantined with `monitored = true` is turned off.
 *
 * Write-time enforcement lives in the Prisma extension (clampMonitoredForStatus
 * + enforceMonitorableStatus in src/db.ts) and covers every ORM write path.
 * This is the sweep for what those can't reach: rows that predate the widened
 * status set (the `20260827000000_monitorable_status_clamp` migration does that
 * pass once, this one keeps it true across upgrades), rows written by raw SQL,
 * and any row the best-effort update/upsert guard skipped because its status
 * read failed.
 *
 * Deliberately NOT marker-guarded — it is one indexed UPDATE against
 * `(monitored)`, and re-running it is the point.
 *
 * Import this module from src/app.ts to activate it:
 *   import "./jobs/clampMonitoredForStatus.js";
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";

async function clampMonitoredOnUnmonitorableStatuses(): Promise<void> {
  try {
    await runInstrumentedJob("clampMonitoredForStatus", async () => {
      // Raw SQL so the sweep is one statement rather than a read + N updates,
      // and because the Prisma extension's own guard is what we're backstopping.
      // The model is `Asset`; the table is `assets` (@@map in schema.prisma).
      const count = await prisma.$executeRaw`
        UPDATE assets
        SET "monitored" = FALSE,
            "consecutiveFailures" = 0
        WHERE "monitored" = TRUE
          AND "status" IN ('decommissioned', 'disabled', 'storage', 'quarantined')
      `;
      if (count > 0) {
        logger.warn(
          { count },
          "Disabled monitoring on assets whose status cannot be monitored (decommissioned/disabled/storage/quarantined)",
        );
      }
    });
  } catch (err) {
    logger.error(err, "Failed to clamp monitored for unmonitorable asset statuses");
  }
}

clampMonitoredOnUnmonitorableStatuses();
