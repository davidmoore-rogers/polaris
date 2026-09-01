/**
 * src/jobs/clampFailureBucket.ts
 *
 * Startup sweep: bring `Asset.consecutiveFailures` back inside the ceiling the
 * missed-poll bucket has carried since 2026-09-01, and retire the dormant
 * `awaitingRecoveryConfirm` bit.
 *
 * WHY THIS EXISTS. The bucket used to be unbounded: a miss added one, a success
 * took one back, and nothing capped the climb. A device dark overnight at a 60 s
 * cadence therefore reached `consecutiveFailures` ≈ 480, and — because a success
 * only ever takes ONE back — owed 480 answered probes before it could read `up`
 * again. Its down alert holds through `down`/`recovering`/`warning`
 * (DOWN_ALERT_HOLDING_STATES), so the alert kept repeating and escalating for
 * eight hours after the device came back. `nextFailureBucket` now locks the
 * level at max(missedPolls, recoveryPolls), but rows written before that change
 * still carry the old debt.
 *
 * WHAT IT DOES NOT NEED TO DO. It does not resolve each asset's own cap.
 * `nextFailureBucket` takes `Math.min(cap, cf)` before it moves the level in
 * EITHER direction, so the very next probe of either outcome pulls an over-cap
 * row down to that asset's exact number. This sweep exists for the surfaces
 * that read the column BEFORE that probe lands — the intermittency strip's
 * tooltip, `runsHeavyCadences`, and `consecutiveFailures` as an automatable
 * `asset_state` field — so one fleet-wide clamp to the absolute ceiling is both
 * sufficient and honest. Resolving 2000 per-asset caps at boot to save one poll
 * of convergence would be the wrong trade.
 *
 * Deliberately NOT marker-guarded, for the same reason clampMonitoredForStatus
 * is not: both statements are idempotent single UPDATEs that match zero rows in
 * the steady state, and re-running across upgrades is the point.
 *
 * Import this module from src/app.ts to activate it:
 *   import "./jobs/clampFailureBucket.js";
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { MAX_MISSED_POLL_BUCKET } from "../utils/monitorStatus.js";
import { runInstrumentedJob } from "./_metrics.js";

async function clampFailureBucket(): Promise<void> {
  try {
    await runInstrumentedJob("clampFailureBucket", async () => {
      // The model is `Asset`; the table is `assets` (@@map in schema.prisma).
      const clamped = await prisma.$executeRaw`
        UPDATE assets
        SET "consecutiveFailures" = ${MAX_MISSED_POLL_BUCKET}
        WHERE "consecutiveFailures" > ${MAX_MISSED_POLL_BUCKET}
      `;
      if (clamped > 0) {
        logger.warn(
          { count: clamped, ceiling: MAX_MISSED_POLL_BUCKET },
          "Clamped missed-poll buckets that predate the bucket ceiling — each asset converges on its own cap at its next probe",
        );
      }

      // The confirmation-run bit is dormant: the bucket cap serves the covering
      // automation's reset count on its own, so nothing reads this any more.
      // Zeroed rather than left set so a stale `true` can never be mistaken for
      // live state by a later reader (the `cooldownSec` retirement precedent).
      const disarmed = await prisma.$executeRaw`
        UPDATE assets
        SET "awaitingRecoveryConfirm" = FALSE
        WHERE "awaitingRecoveryConfirm" = TRUE
      `;
      if (disarmed > 0) {
        logger.info({ count: disarmed }, "Retired dormant awaitingRecoveryConfirm flags");
      }
    });
  } catch (err) {
    logger.error(err, "Failed to clamp missed-poll failure buckets");
  }
}

clampFailureBucket();
