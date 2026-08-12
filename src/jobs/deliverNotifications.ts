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
import { pruneAckTokens } from "../services/notificationAckService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 15 * 1000;
const ACK_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// Spent and expired acknowledge links are swept from this tick rather than a
// job of their own: this is the job that already owns the delivery lifecycle
// that minted them, and it runs on the same role. Hourly, on a timestamp guard
// — the sweep is one indexed deleteMany, but not one worth doing every 15s.
let lastAckPruneAt = 0;

async function runDeliverNotifications(): Promise<void> {
  try {
    await runInstrumentedJob("deliverNotifications", async () => {
      await drainPendingDeliveries();
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "deliverNotifications job failed (non-fatal)");
  }
  const now = Date.now();
  if (now - lastAckPruneAt >= ACK_PRUNE_INTERVAL_MS) {
    lastAckPruneAt = now;
    try {
      const removed = await pruneAckTokens();
      if (removed > 0) logger.debug({ removed }, "pruned expired/spent acknowledge links");
    } catch (err: any) {
      logger.warn({ err: err?.message }, "acknowledge-link prune failed (non-fatal)");
    }
  }
}

// Boot delay so the engine has produced deliveries to drain.
setTimeout(runDeliverNotifications, 35_000);
setInterval(runDeliverNotifications, INTERVAL_MS);
