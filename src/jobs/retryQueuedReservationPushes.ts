/**
 * src/jobs/retryQueuedReservationPushes.ts
 *
 * 60-second reconciler — retries DHCP reservation pushes that landed in the
 * "pending" state because the FortiGate (or FortiManager) was unreachable at
 * create time. The event-driven hook `triggerRetryAfterStatusChange`, fired
 * from monitoringService when a firewall asset transitions to up, is a
 * latency optimization on top of this — the periodic tick catches anything
 * the hook missed (server restart while queued, unmonitored gates, race with
 * concurrent discovery).
 *
 * Independent `running` guard so a slow tick can't double-fire if the queue
 * ever grows large enough that one pass exceeds 60s. Best-effort — failures
 * are logged at debug and never thrown.
 *
 * Import this module from src/app.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import { retryPendingReservations } from "../services/reservationService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 60 * 1000;

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runInstrumentedJob("retryQueuedReservationPushes", async () => {
      const counts = await retryPendingReservations();
      if (counts.attempted > 0) {
        logger.debug(
          counts,
          "retryQueuedReservationPushes tick completed",
        );
      }
    });
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err) }, "retryQueuedReservationPushes tick failed (non-fatal)");
  } finally {
    running = false;
  }
}

// Delay the first tick 60s after boot so the rest of the app is up and
// monitoring has had a chance to populate Asset.monitorStatus for the
// readiness gate.
setTimeout(tick, 60_000);
setInterval(tick, INTERVAL_MS);
