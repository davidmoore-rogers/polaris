/**
 * src/jobs/discoverySlowCheck.ts
 *
 * Scheduled job: every 30 seconds, compare each in-flight discovery's elapsed
 * time to its rolling baseline (from discoveryDurationService) and emit a
 * single `integration.discover.slow` event when a run (or a single FortiGate
 * inside an FMG run) is taking much longer than normal.
 *
 * The /integrations/discoveries poll endpoint also calls checkForSlowRuns()
 * inline so the UI flips to amber within one 4 s poll cycle — this background
 * tick is the safety net that ensures the event still fires even when no user
 * has the UI open.
 *
 * Import from app.ts to activate.
 */

import { checkForSlowRuns } from "../api/routes/integrations.js";
import { logger } from "../utils/logger.js";

const INTERVAL_MS = 30 * 1000;

async function tick(): Promise<void> {
  try {
    await checkForSlowRuns();
  } catch (err) {
    logger.error(err, "Discovery slow-check job failed");
  }
}

setInterval(tick, INTERVAL_MS);
