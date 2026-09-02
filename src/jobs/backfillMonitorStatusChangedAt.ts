/**
 * src/jobs/backfillMonitorStatusChangedAt.ts
 *
 * One-shot startup job: seeds Asset.monitorStatusChangedAt for assets that
 * were already in warning/down/recovering before the column existed. The
 * column is stamped going forward by recordProbeResult; this job covers the
 * gap on existing installs so the Dashboard's "how long has this been
 * warning/down" duration isn't blank for the lifetime of the current outage.
 *
 * Source for the seed value: the most recent `monitor.status_changed` Event
 * whose details.nextStatus matches the asset's current monitorStatus. Events
 * are pruned at 7 days; assets whose last transition is older than that get
 * left null (Dashboard renders "—").
 *
 * Idempotent — only touches rows where monitorStatusChangedAt IS NULL.
 *
 * Import from src/app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";

async function backfillMonitorStatusChangedAt(): Promise<void> {
  const start = Date.now();
  try {
    await runInstrumentedJob("backfillMonitorStatusChangedAt", async () => {
      const candidates = await prisma.asset.findMany({
        where: {
          monitored: true,
          monitorStatusChangedAt: null,
          monitorStatus: { in: ["warning", "down", "recovering"] },
        },
        select: { id: true, monitorStatus: true },
      });
      if (candidates.length === 0) return;

      // ONE query for the newest transition event per candidate, not one per
      // asset: `distinct` on resourceId with resourceId-then-timestamp-desc
      // ordering resolves to a DISTINCT ON, so each asset's latest
      // monitor.status_changed comes back in a single read. The per-asset
      // findFirst this replaces hit the (large, hourly-pruned) Events table
      // once per candidate, and the pair of round trips ran again on EVERY
      // boot for any candidate it couldn't stamp — a candidate stays a
      // candidate while its column is null, and stamping a value the events
      // don't support would be worse than leaving it blank.
      const latestByAsset = new Map<string, { timestamp: Date; details: unknown }>();
      for (const ev of await prisma.event.findMany({
        where: { action: "monitor.status_changed", resourceId: { in: candidates.map((c) => c.id) } },
        orderBy: [{ resourceId: "asc" }, { timestamp: "desc" }],
        distinct: ["resourceId"],
        select: { resourceId: true, timestamp: true, details: true },
      })) {
        if (ev.resourceId) latestByAsset.set(ev.resourceId, { timestamp: ev.timestamp, details: ev.details });
      }

      const stamps: Array<{ id: string; at: Date }> = [];
      for (const asset of candidates) {
        const evt = latestByAsset.get(asset.id);
        if (!evt) continue;
        const details = evt.details as { nextStatus?: string } | null;
        if (!details || details.nextStatus !== asset.monitorStatus) continue;
        stamps.push({ id: asset.id, at: evt.timestamp });
      }

      // Each asset takes its own event's timestamp, so these can't collapse
      // into an updateMany — chunked transactions instead of N awaited writes.
      const CHUNK = 200;
      for (let i = 0; i < stamps.length; i += CHUNK) {
        await prisma.$transaction(
          stamps.slice(i, i + CHUNK).map((s) =>
            prisma.asset.update({ where: { id: s.id }, data: { monitorStatusChangedAt: s.at } }),
          ),
        );
      }
      const stamped = stamps.length;

      if (stamped > 0) {
        logger.info(
          {
            candidates: candidates.length,
            stamped,
            elapsedMs: Date.now() - start,
          },
          "Backfilled monitorStatusChangedAt from monitor.status_changed events",
        );
      }
    });
  } catch (err: any) {
    logger.error(
      { err: err?.message ?? String(err) },
      "monitorStatusChangedAt backfill failed (next status change will repopulate)",
    );
  }
}

setTimeout(backfillMonitorStatusChangedAt, 60_000);
