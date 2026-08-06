/**
 * src/jobs/reconcileMapRegions.ts
 *
 * Periodic safety net for the map-region tag reconciler.
 *
 * The CRUD endpoints reconcile inline on every region edit, and end-of-FMG/
 * FortiGate discovery calls the reconciler too — this 6-hour tick is the
 * out-of-band catch for anything those paths missed (server restart mid-edit,
 * a firewall whose coords were updated outside discovery, etc.). Add-only:
 * never strips a tag — renames and deletes are handled by the dedicated
 * service paths so by the time this runs there's nothing stale to clean up.
 *
 * Independent `running` guard. Failures are logged at debug and never thrown.
 *
 * Import this module from src/app.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import { reconcileMapRegions } from "../services/mapRegionService.js";
import { logEvent } from "../services/eventLogService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runInstrumentedJob("reconcileMapRegions", async () => {
      const summary = await reconcileMapRegions();
      if (summary.assetsTouched > 0) {
        logEvent({
          action: "region.tags_reconciled",
          resourceType: "map-region",
          message: `Periodic region reconcile: +${summary.added} on ${summary.assetsTouched} asset${summary.assetsTouched === 1 ? "" : "s"}`,
          details: summary,
        });
      }
    });
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err) }, "reconcileMapRegions tick failed (non-fatal)");
  } finally {
    running = false;
  }
}

setTimeout(tick, STARTUP_DELAY_MS);
setInterval(tick, INTERVAL_MS);
