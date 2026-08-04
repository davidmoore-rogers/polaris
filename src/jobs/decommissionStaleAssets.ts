/**
 * src/jobs/decommissionStaleAssets.ts
 *
 * Scheduled job: marks assets whose lastSeen is older than the configured
 * inactivity threshold (in months) as decommissioned. Threshold is configured
 * on the Events page → Settings → Assets tab. A value of 0 disables the job.
 *
 * Asset.lastSeen means verified network presence (see bumpLastSeen in
 * src/utils/assetInvariants.ts), so eligibility also consults directory /
 * agent activity on the AssetSource rows: a device that syncs to Intune or
 * logs onto AD (e.g. a remote laptop that never touches the LAN) or whose
 * Polaris Agent is still reporting is alive, not gone — it must not be
 * auto-decommissioned no matter how stale its on-network lastSeen is.
 * Assets with lastSeen = null are never eligible (Prisma `lt` excludes null).
 *
 * Runs every 24 hours. Import from src/app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { getAssetDecommissionSettings } from "../services/eventArchiveService.js";
import { logEvent } from "../services/eventLogService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function decommissionStaleAssets(): Promise<void> {
  try {
    await runInstrumentedJob("decommissionStaleAssets", async () => {
    const { inactivityMonths } = await getAssetDecommissionSettings();
    if (inactivityMonths <= 0) return;

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - inactivityMonths);

    const stale = await prisma.asset.findMany({
      where: {
        // maintenance: the window pauses all polling so lastSeen freezes by
        // design — never age a maintenance-window asset into decommission
        // (which would also clamp monitored=false and break the
        // maintenanceScheduler's status restore).
        status: { notIn: ["decommissioned", "disabled", "maintenance"] },
        lastSeen: { lt: cutoff },
        // Recent directory / agent activity vetoes decommission even when
        // on-network presence is stale (cloud-only laptops, agent-reporting
        // hosts the network integrations can't see).
        sources: {
          none: {
            sourceKind: { in: ["entra", "intune", "ad", "polaris-agent"] },
            lastSeen: { gte: cutoff },
          },
        },
      },
      select: { id: true, hostname: true, ipAddress: true },
    });

    if (stale.length === 0) return;

    const ids = stale.map((a) => a.id);
    const result = await prisma.asset.updateMany({
      where: { id: { in: ids } },
      data: { status: "decommissioned", statusChangedAt: new Date(), statusChangedBy: "system" },
    });

    logger.info(
      { count: result.count, inactivityMonths },
      `Auto-decommissioned ${result.count} stale asset(s) (not seen in >${inactivityMonths} month(s))`,
    );

    for (const a of stale) {
      logEvent({
        action: "asset.auto_decommissioned",
        resourceType: "asset",
        resourceId: a.id,
        resourceName: a.hostname || a.ipAddress || undefined,
        actor: "system",
        level: "info",
        message: `Asset "${a.hostname || a.ipAddress || "unknown"}" auto-decommissioned after ${inactivityMonths} month(s) of inactivity`,
      });
    }
    });
  } catch (err) {
    logger.error(err, "Error running asset auto-decommission job");
  }
}

decommissionStaleAssets();
setInterval(decommissionStaleAssets, INTERVAL_MS);
