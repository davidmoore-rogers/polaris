/**
 * src/jobs/escalateNotifications.ts
 *
 * Drives the notification escalation sweep every 60s: unhandled notifications
 * of rules with escalation tiers get their due tier emails queued as
 * NotificationDelivery rows (drained by deliverNotifications). Web/all role
 * only (imported under runsSchedulers). Best-effort — a failed tick logs and
 * retries next interval. Modeled on evaluateNotificationRules.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { logger } from "../utils/logger.js";
import { runEscalationSweep } from "../services/notificationEscalationService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 60 * 1000; // 1 minute

async function runEscalateNotifications(): Promise<void> {
  try {
    await runInstrumentedJob("escalateNotifications", async () => {
      await runEscalationSweep();
    });
  } catch (err: any) {
    logger.debug({ err: err?.message }, "escalateNotifications job failed (non-fatal)");
  }
}

// Boot delay so the DB is ready; offset from the evaluate tick.
setTimeout(runEscalateNotifications, 45_000);
setInterval(runEscalateNotifications, INTERVAL_MS);
