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
 * Best-effort. The `pgTuningNeeded` input to the snapshot is passed in as
 * false here rather than re-running the full pg-settings query — the job's
 * value is in catching disk + autovacuum + disk-I/O-pressure transitions
 * out-of-band, not in re-running the tuning advice on a timer.
 * The route handler runs the full computation when an admin loads the
 * Maintenance tab, so the snapshot stays accurate on the surface that
 * actually displays the reasons.
 *
 * Import this module from src/app.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import { getCapacitySnapshot, recordCapacityTransition } from "../services/capacityService.js";
import { recomputeAdvisorFromSnapshot, type PgTuningExternal } from "../services/capacityAdvisorService.js";
import { setDbPoolGauges, setCapacityGauges } from "../metrics.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

async function runCapacityWatch(): Promise<void> {
  try {
    await runInstrumentedJob("capacityWatch", async () => {
      // The job doesn't probe pg_settings, so leave pgTuningNeeded false — the
      // full route still surfaces it for admins. Disk + autovacuum +
      // projected-size + disk-I/O-pressure transitions are still caught here
      // (db_io_pressure / track_io_timing_off read pg_stat_database inside the
      // snapshot, not pg_settings), and this 10-min tick is what warms the
      // pg_stat_database rate baseline so the first measured verdict lands.
      const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
      await recordCapacityTransition(snap);
      setDbPoolGauges(snap.database.connectionPool);
      setCapacityGauges({
        severity: snap.severity,
        volumes: snap.appHost.volumes.map(v => ({
          volume: v.paths[0] ?? "(unknown)",
          roles: v.roles.join(","),
          freeBytes: v.freeBytes,
          totalBytes: v.totalBytes,
        })),
        sampleTables: snap.database.sampleTables.map(t => ({
          table: t.name,
          deadTupRatio: t.deadTupRatio,
        })),
        databaseSizeBytes: snap.database.sizeBytes,
        steadyStateSizeBytes: snap.workload.steadyStateSizeBytes,
      });

      // Refresh the Capacity Advisor cache out-of-band so the Maintenance tab
      // doesn't have to wait for the recompute on first load. PG tuning inputs
      // are stubbed here — pg_settings is queried only on the route handler
      // path (where an admin is actively looking), not on every 10-min tick;
      // the advisor PG_* recommendations stay accurate enough between ticks
      // because PG settings don't drift between page loads.
      const stubPgTuning: PgTuningExternal = {
        sharedBuffers:      { current: null, recommended: "?", changeRequired: false },
        effectiveCacheSize: { current: null, recommended: "?", changeRequired: false },
        workMem:            { current: null, recommended: "?", changeRequired: false },
        randomPageCost:     { current: null, recommended: "?", changeRequired: false },
      };
      await recomputeAdvisorFromSnapshot(snap, stubPgTuning);
    });
  } catch (err: any) {
    logger.debug({ err: err?.message }, "capacityWatch job failed (non-fatal)");
  }
}

// Run once on startup after a short delay so the DB connection is ready, then
// every 10 minutes. The startup pass also establishes the baseline severity
// stored in the `capacity.lastSeverity` Setting on first boot.
setTimeout(runCapacityWatch, 60_000);
setInterval(runCapacityWatch, INTERVAL_MS);
