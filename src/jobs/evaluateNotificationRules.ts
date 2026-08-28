/**
 * src/jobs/evaluateNotificationRules.ts
 *
 * Drives the notification rule engine every 60s: threshold/state rules +
 * event-tail. Web/all role only (imported under runsSchedulers). Best-effort —
 * a failed tick logs and retries next interval. Modeled on capacityWatch.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { logger } from "../utils/logger.js";
import { evaluateAllNotificationRules } from "../services/notificationEngine.js";
import { clearSuppressedAlerts } from "../services/notificationService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 60 * 1000; // 1 minute

async function runEvaluateNotificationRules(): Promise<void> {
  try {
    await runInstrumentedJob("evaluateNotificationRules", async () => {
      // Before the rules run, not after: an asset that entered suppression
      // since the last tick must not carry a live alert through its
      // maintenance window (business rule 16). The scheduler clears the
      // assets it puts into a window itself, so this is the safety net —
      // and the only thing that catches dependency suppression, which has
      // no edge of its own. Best-effort; a failure here must not cost the
      // fleet a tick of evaluation.
      await clearSuppressedAlerts().catch((err: any) => {
        logger.warn({ err: err?.message }, "clearSuppressedAlerts sweep failed (non-fatal)");
      });
      await evaluateAllNotificationRules();
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "evaluateNotificationRules job failed (non-fatal)");
  }
}

// Boot delay so the DB + first host-metrics sample are ready.
setTimeout(runEvaluateNotificationRules, 30_000);
setInterval(runEvaluateNotificationRules, INTERVAL_MS);
