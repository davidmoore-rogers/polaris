/**
 * src/jobs/backfillMonitorOverride.ts
 *
 * One-shot startup job (45s after boot): re-syncs `Asset.monitorOverride`
 * against the current per-class `addAsMonitored` flag on every integration.
 * Resilience companion to the SQL migration (20260529000000_monitor_override_cutover)
 * which already does the same backfill at upgrade time — this job catches the
 * gap when an operator's choice or an integration's config diverges between
 * restarts (test environments, manual JSON edits, partial restores).
 *
 * Idempotent — the underlying SQL UPDATE is no-op when monitorOverride
 * already matches the (monitored XOR addAsMonitored) invariant. Cheap when
 * nothing's drifted; bounded by integration × asset count when something has.
 *
 * Import from src/app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { recomputeMonitorOverrideForIntegration } from "../services/monitorOverrideService.js";

async function backfillMonitorOverride(): Promise<void> {
  const start = Date.now();
  try {
    await runInstrumentedJob("backfillMonitorOverride", async () => {
      // Only sweep integrations whose type carries a per-class addAsMonitored
      // block. Other integration types (none today, but future ones might
      // not opt in) are skipped — the SQL helper's WHERE clause would no-op
      // on them anyway, but skipping spares one round-trip per row.
      const integrations = await prisma.integration.findMany({
        where: {
          type: {
            in: ["fortimanager", "fortigate", "activedirectory", "entraid", "windowsserver"],
          },
        },
        select: { id: true },
      });
      for (const i of integrations) {
        await recomputeMonitorOverrideForIntegration(prisma, i.id);
      }
      logger.info(
        { integrations: integrations.length, elapsedMs: Date.now() - start },
        "Backfilled monitorOverride across integrations",
      );
    });
  } catch (err: any) {
    logger.error(
      { err: err?.message ?? String(err) },
      "monitorOverride backfill failed (next operator/integration write will repopulate)",
    );
  }
}

setTimeout(backfillMonitorOverride, 45_000);
