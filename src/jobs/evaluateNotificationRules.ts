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
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 60 * 1000; // 1 minute

async function runEvaluateNotificationRules(): Promise<void> {
  try {
    await runInstrumentedJob("evaluateNotificationRules", async () => {
      await evaluateAllNotificationRules();
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "evaluateNotificationRules job failed (non-fatal)");
  }
}

// Boot delay so the DB + first host-metrics sample are ready.
setTimeout(runEvaluateNotificationRules, 30_000);
setInterval(runEvaluateNotificationRules, INTERVAL_MS);
