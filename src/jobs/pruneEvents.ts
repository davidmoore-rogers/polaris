/**
 * src/jobs/pruneEvents.ts
 *
 * Scheduled job: archives then deletes event log entries older than 7 days.
 * Archives are only generated when SFTP/SCP export is configured and enabled.
 * Runs every hour. Import this module from src/index.ts to activate it.
 *
 * Usage in index.ts:
 *   import "./jobs/pruneEvents.js";
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { archiveAndExport } from "../services/eventArchiveService.js";

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RETENTION_DAYS = 7;

async function pruneOldEvents(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // Archive events before pruning (only if export is configured)
    try {
      const archived = await archiveAndExport(cutoff);
      if (archived > 0) {
        logger.info({ archived }, "Archived events before pruning");
      }
    } catch (err) {
      logger.error(err, "Event archive export failed — pruning will still proceed");
    }

    const { count } = await prisma.event.deleteMany({
      where: { timestamp: { lt: cutoff } },
    });
    if (count > 0) {
      logger.info({ count }, "Pruned old events (>7 days)");
    }
  } catch (err) {
    logger.error(err, "Error running event prune job");
  }
}

// Run once on startup, then every hour
pruneOldEvents();
setInterval(pruneOldEvents, INTERVAL_MS);
