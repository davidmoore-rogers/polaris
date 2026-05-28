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
 * connections above ~1-2, so we test integrations one at a time.
 *
 * Import from app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { runPreflightTest } from "../api/routes/integrations.js";
import { logEvent } from "../api/routes/events.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 10 * 60 * 1000;

async function testAllIntegrations(): Promise<void> {
  await runInstrumentedJob("integrationConnectionTester", async () => {
    const integrations = await prisma.integration.findMany({
      where: { enabled: true },
      select: { id: true, name: true, type: true, config: true, lastTestOk: true },
    });

    for (const intg of integrations) {
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
