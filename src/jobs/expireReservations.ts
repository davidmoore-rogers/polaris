/**
 * src/jobs/expireReservations.ts
 *
 * Scheduled job: marks reservations past their `expiresAt` timestamp as expired.
 * Runs every 15 minutes. Import this module from src/index.ts to activate it.
 *
 * Usage in index.ts:
 *   import "./jobs/expireReservations.js";
 */

import { expireStaleReservations } from "../services/reservationService.js";
import { logger } from "../utils/logger.js";

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

async function runExpiry(): Promise<void> {
  try {
    const count = await expireStaleReservations();
    if (count > 0) {
      logger.info({ count }, "Expired stale reservations");
    }
  } catch (err) {
    logger.error(err, "Error running reservation expiry job");
  }
}

// Run once immediately on startup, then on a fixed interval
runExpiry();
setInterval(runExpiry, INTERVAL_MS);
