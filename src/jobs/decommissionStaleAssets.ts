/**
 * src/jobs/decommissionStaleAssets.ts
 *
 * Scheduled job: marks assets whose lastSeen is older than the configured
 * inactivity threshold (in months) as decommissioned. Threshold is configured
 * on the Events page → Settings → Assets tab. A value of 0 disables the job.
 *
 * Runs every 24 hours. Import from src/app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { getAssetDecommissionSettings } from "../services/eventArchiveService.js";
import { logEvent } from "../api/routes/events.js";

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function decommissionStaleAssets(): Promise<void> {
  try {
    const { inactivityMonths } = await getAssetDecommissionSettings();
    if (inactivityMonths <= 0) return;

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - inactivityMonths);

    const stale = await prisma.asset.findMany({
      where: {
        status: { notIn: ["decommissioned", "disabled"] },
        lastSeen: { lt: cutoff },
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
  } catch (err) {
    logger.error(err, "Error running asset auto-decommission job");
  }
}

decommissionStaleAssets();
setInterval(decommissionStaleAssets, INTERVAL_MS);
