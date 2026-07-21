/**
 * src/jobs/runAutomationScripts.ts
 *
 * Executes pending server-side AutomationScriptRun rows every ~5s (claim →
 * execFile with timeout/output caps → record + audit Event) and sweeps
 * stuck/aged rows. Web/all role only (imported under runsSchedulers) — the
 * same singleton posture as deliverNotifications, and the reason script
 * actions never execute inline in the engine or the delivery drain.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { logger } from "../utils/logger.js";
import { runPendingServerScripts } from "../services/automationScriptRunner.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 5 * 1000;
let running = false;

async function runAutomationScripts(): Promise<void> {
  if (running) return; // a long script must not stack ticks
  running = true;
  try {
    await runInstrumentedJob("runAutomationScripts", async () => {
      await runPendingServerScripts();
    });
  } catch (err: any) {
    logger.debug({ err: err?.message }, "runAutomationScripts job failed (non-fatal)");
  } finally {
    running = false;
  }
}

// Boot delay so the engine has had a chance to enqueue runs.
setTimeout(runAutomationScripts, 40_000);
setInterval(runAutomationScripts, INTERVAL_MS);
