/**
 * src/jobs/reconcileTagAssignments.ts
 *
 * Periodic safety net for criteria-based tag auto-assignment.
 *
 * Tag CRUD reconciles inline on every create/edit, end-of-discovery calls
 * reconcileAllTags(), and asset writes reconcile the touched asset — this
 * 6-hour tick is the out-of-band catch for anything those paths missed (a
 * server restart mid-edit, an asset field changed by a path that didn't fire
 * the hook, etc.). Diff-based managed sync: adds the tag to newly matching
 * assets and removes it from drifted ones, but only ever touches engine-owned
 * (provenance-tracked) copies — hand-applied tags are never disturbed.
 *
 * Independent `running` guard. Failures are logged at debug and never thrown.
 *
 * Import this module from src/app.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import { reconcileAllTags } from "../services/tagAssignmentService.js";
import { logEvent } from "../services/eventLogService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 90 * 1000;

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runInstrumentedJob("reconcileTagAssignments", async () => {
      const summary = await reconcileAllTags();
      if (summary.added > 0 || summary.removed > 0) {
        logEvent({
          action: "tag.assignments_reconciled",
          resourceType: "tag",
          message: `Periodic tag reconcile: +${summary.added} / -${summary.removed}`,
          details: summary,
        });
      }
    });
  } catch (err: any) {
    logger.debug({ err: err?.message ?? String(err) }, "reconcileTagAssignments tick failed (non-fatal)");
  } finally {
    running = false;
  }
}

setTimeout(tick, STARTUP_DELAY_MS);
setInterval(tick, INTERVAL_MS);
