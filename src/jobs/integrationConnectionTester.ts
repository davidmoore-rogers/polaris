/**
 * src/jobs/integrationConnectionTester.ts
 *
 * Scheduled job: every 10 minutes, run the credential preflight test against
 * every enabled integration and refresh lastTestAt / lastTestOk. Emits an
 * `integration.test.recovered` or `integration.test.failed` Event when the
 * ok-state transitions, so on-call sees the change in the audit log.
 *
 * Why this exists: the discovery scheduler filters on `lastTestOk: true`, so a
 * one-off credential failure used to wedge an integration off the schedule
 * until an operator manually clicked Test. This job keeps lastTestOk fresh, so
 * a transient outage self-heals on the next 10-min tick.
 *
 * Sequential, not parallel — at Rogers Group, FortiManager drops parallel
 * connections above ~1-2, so we test integrations one at a time. For the same
 * reason, any integration currently in an active discovery run is skipped —
 * a fresh login session during a long-running FMG discovery would collide
 * with the worker's open session and stamp a false-positive failure.
 *
 * Import from app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { runPreflightTest, isDiscoveryRunning } from "../api/routes/integrations.js";
import { logEvent } from "../api/routes/events.js";
import { recordIntegrationTest } from "../metrics.js";
import { runInstrumentedJob } from "./_metrics.js";
import { logout as fmgLogout, type FortiManagerConfig } from "../services/fortimanagerService.js";

const INTERVAL_MS = 10 * 60 * 1000;

// FMG enforces a ~24h hard session lifetime that the 10-min keepalive cannot
// reset. Proactively logout each FMG session every hour so the next call
// re-establishes a fresh one well before the ceiling fires.
const FMG_SESSION_RESET_MS = 60 * 60 * 1000;
const fmgLastReset = new Map<string, number>();

async function testAllIntegrations(): Promise<void> {
  await runInstrumentedJob("integrationConnectionTester", async () => {
    const integrations = await prisma.integration.findMany({
      where: { enabled: true },
      select: { id: true, name: true, type: true, config: true, lastTestOk: true },
    });

    for (const intg of integrations) {
      // Skip integrations with an active discovery run. The FMG at Rogers Group
      // drops parallel connections above ~1-2, so a fresh login session while
      // discovery is mid-proxy gets rejected and stamps a false-positive
      // `lastTestOk=false`. A test result during a run also adds no signal —
      // discovery itself is the live proof. Preserve the prior lastTestAt/Ok.
      if (await isDiscoveryRunning(intg.id).catch(() => false)) {
        recordIntegrationTest(intg.type, "skipped");
        logger.info({ integrationId: intg.id, name: intg.name, type: intg.type, reason: "discovery-running" }, "integrationConnectionTester: skipped");
        continue;
      }

      if (intg.type === "fortimanager") {
        const now = Date.now();
        const last = fmgLastReset.get(intg.id) ?? 0;
        if (now - last >= FMG_SESSION_RESET_MS) {
          const r = await fmgLogout(intg.config as FortiManagerConfig, intg.id).catch((err) => ({ ok: false, message: err?.message ?? "logout threw" }));
          fmgLastReset.set(intg.id, now);
          logger.info({ integrationId: intg.id, name: intg.name, ok: r.ok, message: r.message }, "integrationConnectionTester: FMG session reset");
        }
      }

      let result: { ok: boolean; message: string };
      try {
        result = await runPreflightTest(intg);
      } catch (err: any) {
        result = { ok: false, message: err?.message ?? "Test threw unexpectedly" };
      }

      await prisma.integration.update({
        where: { id: intg.id },
        data: { lastTestAt: new Date(), lastTestOk: result.ok },
      }).catch((err) => {
        logger.error({ err, integrationId: intg.id }, "Integration tester: failed to persist test result");
      });

      recordIntegrationTest(intg.type, result.ok ? "success" : "failure");
      logger.info(
        { integrationId: intg.id, name: intg.name, type: intg.type, ok: result.ok, message: result.message },
        result.ok ? "integrationConnectionTester: success" : "integrationConnectionTester: failure",
      );

      const previouslyOk = intg.lastTestOk === true;
      if (result.ok && !previouslyOk) {
        logEvent({
          action: "integration.test.recovered",
          resourceType: "integration",
          resourceId: intg.id,
          resourceName: intg.name,
          actor: "system:integration-tester",
          message: `Connection test for "${intg.name}" recovered — auto-discovery will resume on the next scheduler tick`,
        });
      } else if (!result.ok && previouslyOk) {
        logEvent({
          action: "integration.test.failed",
          level: "warning",
          resourceType: "integration",
          resourceId: intg.id,
          resourceName: intg.name,
          actor: "system:integration-tester",
          message: `Connection test for "${intg.name}" failed: ${result.message}`,
        });
      }
    }
  });
}

async function tick(): Promise<void> {
  try {
    await testAllIntegrations();
  } catch (err) {
    logger.error(err, "Integration connection tester job failed");
  }
}

setInterval(tick, INTERVAL_MS);
// Fire once shortly after boot so a freshly-restarted process doesn't wait
// 10 min before the first test (e.g. after an in-app update).
setTimeout(tick, 30 * 1000);
