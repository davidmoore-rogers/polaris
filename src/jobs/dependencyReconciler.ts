/**
 * src/jobs/dependencyReconciler.ts
 *
 * 60-second reconciler — source of truth for `Asset.dependencySuppressed`.
 *
 * Loads every monitored asset, evaluates desired suppression state under
 * the all-down multi-parent semantics, writes only diffs, emits
 * `monitor.dependency_suppressed` / `monitor.dependency_resumed` Events
 * for transitions. The event-driven hook
 * `propagateAfterStatusChange` (called from recordProbeResult) is a
 * latency optimization on top of this — the periodic tick catches anything
 * the hook missed (server restart mid-transition, race with concurrent
 * probes, etc.).
 *
 * Independent `running` guard so a slow tick can't double-fire if the
 * fleet ever grows large enough that one pass exceeds 60s. Best-effort —
 * failures are logged at debug and never thrown.
 *
 * Import this module from src/app.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import { reconcileDependencySuppression } from "../services/dependencyTreeService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 60 * 1000;

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runInstrumentedJob("dependencyReconciler", async () => {
      await reconcileDependencySuppression();
    });
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err) }, "dependencyReconciler tick failed (non-fatal)");
  } finally {
    running = false;
  }
}

// Skip the very first 60s after boot so monitorAssets.ts has had a chance
// to record at least one probe per asset and get monitorStatus out of the
// "unknown" floor. Without that, every fleet-wide reconciler tick on a
// fresh boot would see "no monitored ancestor is up" and incorrectly
// suppress everything.
setTimeout(tick, 60_000);
setInterval(tick, INTERVAL_MS);
