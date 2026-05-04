/**
 * src/jobs/capacityWatch.ts
 *
 * Scheduled job: builds a capacity snapshot every 10 minutes and fires a
 * `capacity.severity_changed` Event whenever severity transitions
 * (ok ↔ watch ↔ amber ↔ red, in either direction).
 *
 * The route handler in `serverSettings.ts` also records transitions on
 * every `/pg-tuning` fetch, but that's only when an admin is actively
 * viewing the Maintenance tab. This job carries the transition signal
 * on a fixed cadence so the alert flows out through the syslog/SFTP
 * archival pipeline even when nobody is logged in — i.e. the case
 * where the DB is on the verge of dying and the UI is moments from
 * becoming unreachable.
 *
 * Best-effort. The legacy `pgTuningNeeded` / `ramInsufficient` signals
 * are computed from a slim probe rather than the full pg-settings query
 * the route does — the job's value is in catching disk + autovacuum
 * transitions, not in re-running the tuning advice on a timer.
 *
 * Import this module from src/app.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import { getCapacitySnapshot, recordCapacityTransition } from "../services/capacityService.js";

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

async function runCapacityWatch(): Promise<void> {
  try {
    // The job doesn't probe pg_settings, so leave both legacy signals false.
    // Disk + autovacuum + projected-size transitions are still caught — and
    // those are the ones operators actually need to hear about between
    // page loads. The full route still surfaces pgTuningNeeded for admins.
    const snap = await getCapacitySnapshot({ ramInsufficient: false, pgTuningNeeded: false });
    await recordCapacityTransition(snap);
  } catch (err: any) {
    logger.debug({ err: err?.message }, "capacityWatch job failed (non-fatal)");
  }
}

// Run once on startup after a short delay so the DB connection is ready, then
// every 10 minutes. The startup pass also establishes the baseline severity
// stored in the `capacity.lastSeverity` Setting on first boot.
setTimeout(runCapacityWatch, 60_000);
setInterval(runCapacityWatch, INTERVAL_MS);
