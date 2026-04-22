/**
 * src/jobs/discoveryScheduler.ts
 *
 * Scheduled job: runs DHCP discovery for integrations that have autoDiscover
 * enabled, respecting each integration's configured pollInterval (hours).
 * Checks every 15 minutes. Import from app.ts to activate.
 *
 * Gate state is persisted on Integration.lastDiscoveryAt so the interval is
 * honoured across application restarts.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { triggerDiscovery, isDiscoveryRunning } from "../api/routes/integrations.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

async function runScheduledDiscoveries(): Promise<void> {
  let integrations: { id: string; name: string; pollInterval: number; lastDiscoveryAt: Date | null }[];
  try {
    integrations = await prisma.integration.findMany({
      where: { enabled: true, autoDiscover: true, lastTestOk: true },
      select: { id: true, name: true, pollInterval: true, lastDiscoveryAt: true },
    });
  } catch (err) {
    logger.error(err, "Discovery scheduler: failed to query integrations");
    return;
  }

  const now = Date.now();

  for (const intg of integrations) {
    if (isDiscoveryRunning(intg.id)) continue;

    const intervalMs = (intg.pollInterval ?? 12) * 60 * 60 * 1000;
    const lastRun = intg.lastDiscoveryAt?.getTime();
    if (lastRun !== undefined && now - lastRun < intervalMs) continue;

    triggerDiscovery(intg.id, "auto-discovery").catch((err) => {
      logger.error({ err, integrationId: intg.id, integrationName: intg.name }, "Discovery scheduler: failed to start discovery");
    });
  }
}

runScheduledDiscoveries();
setInterval(runScheduledDiscoveries, CHECK_INTERVAL_MS);
