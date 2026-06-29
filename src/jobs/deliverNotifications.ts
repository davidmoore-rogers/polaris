/**
 * src/jobs/deliverNotifications.ts
 *
 * Drains pending NotificationDelivery rows every ~15s and dispatches them to
 * email / webhook / web-push. Web/all role only (imported under
 * runsSchedulers). Best-effort — a failed tick logs and retries next interval;
 * per-delivery failures are retried (≤3 attempts) by the drain itself.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { logger } from "../utils/logger.js";
import { drainPendingDeliveries } from "../services/notificationDeliveryService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 15 * 1000;

async function runDeliverNotifications(): Promise<void> {
  try {
    await runInstrumentedJob("deliverNotifications", async () => {
      await drainPendingDeliveries();
    });
  } catch (err: any) {
    logger.debug({ err: err?.message }, "deliverNotifications job failed (non-fatal)");
  }
}

// Boot delay so the engine has produced deliveries to drain.
setTimeout(runDeliverNotifications, 35_000);
setInterval(runDeliverNotifications, INTERVAL_MS);
