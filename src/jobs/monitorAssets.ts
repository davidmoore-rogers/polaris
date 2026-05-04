/**
 * src/jobs/monitorAssets.ts
 *
 * Periodic asset monitoring tick. Splits work across TWO independent ticking
 * loops so a slow heavy collection (telemetry / systemInfo) on a wedged host
 * can't hold up per-minute probe polling for the rest of the fleet:
 *
 *   - Light loop  (probe + fastFiltered): ticks every 5 s
 *   - Heavy loop  (telemetry + systemInfo): ticks every 30 s, also runs the
 *                 daily sample-retention prune
 *
 * Each loop has its own `running` guard. A long-running heavy pass blocks
 * ONLY future heavy ticks; the light loop keeps firing on its own clock and
 * re-evaluates which assets are due every 5 s.
 *
 * Behavior dispatches on `Setting.monitor.queueMode` (captured at boot):
 *
 *   "cursor" (default) — Each tick calls runMonitorPass() to drain all due
 *                        work in-process via the cursor worker pool.
 *                        Default concurrency is CPU-aware
 *                        (POLARIS_PROBE_CONCURRENCY / POLARIS_HEAVY_CONCURRENCY).
 *
 *   "pgboss"           — Each tick scans the same due-asset set but submits
 *                        one job per (assetId, cadence) to the pg-boss queue
 *                        registered in queueService.startPgbossWorkers().
 *                        Workers (potentially across multiple processes once
 *                        we go horizontal) drain the queues. The exclusive
 *                        queue policy + singletonKey on every send absorbs
 *                        duplicates so the publisher can re-evaluate every
 *                        tick without piling up stale jobs.
 *
 * Cadence pacing is per-asset (Asset.monitorIntervalSec / telemetryIntervalSec
 * / systemInfoIntervalSec, falling back to the global defaults), so the
 * tick interval is intentionally faster than any reasonable cadence —
 * isDue() filters out assets that aren't due yet.
 */

import { cpus } from "node:os";
import {
  runMonitorPass,
  pruneMonitorSamples,
  pruneTelemetrySamples,
  pruneSystemInfoSamples,
  getMonitorSettings,
  pickMonitorClass,
  probeIntervalWithBackoff,
  type MonitorCadence,
} from "../services/monitoringService.js";
import { getBootTimeMode, publishMonitorJob } from "../services/queueService.js";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

const PROBE_TICK_MS = 5_000;
const HEAVY_TICK_MS = 30_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function resolveConcurrency(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

const PROBE_CONCURRENCY = resolveConcurrency(
  "POLARIS_PROBE_CONCURRENCY",
  Math.max(8, Math.min(64, cpus().length * 2)),
);
const HEAVY_CONCURRENCY = resolveConcurrency(
  "POLARIS_HEAVY_CONCURRENCY",
  Math.max(4, Math.min(32, cpus().length)),
);

logger.info(
  { probeConcurrency: PROBE_CONCURRENCY, heavyConcurrency: HEAVY_CONCURRENCY, cores: cpus().length },
  "Monitor worker concurrency configured",
);

let runningProbe = false;
let runningHeavy = false;
let lastPruneAt = 0;

/**
 * pg-boss publisher. Queries the same candidate set as runMonitorPass, runs
 * the same isDue() per-cadence checks, and submits one job per (assetId,
 * cadence) to the appropriate pg-boss queue. Duplicates for an in-flight
 * job are absorbed by the exclusive queue policy + singletonKey, so calling
 * this every tick is safe.
 *
 * Note: small amount of intentional code duplication with runMonitorPass —
 * the candidate query and isDue logic are mirrored. Keeping the cursor and
 * publisher paths separate (rather than parametrizing runMonitorPass) makes
 * each one clearer to read and easier to evolve independently. Both paths
 * call `pickMonitorClass` + the same `isDue` semantics, so the due-set is
 * always identical between modes.
 */
async function publishDueWork(cadences: MonitorCadence[]): Promise<void> {
  const enabled = new Set<MonitorCadence>(cadences);
  const settings = await getMonitorSettings();
  const now = new Date();

  const candidates = await prisma.asset.findMany({
    where: { monitored: true, monitorType: { not: null } },
    select: {
      id: true,
      assetType: true, manufacturer: true,
      monitorType: true, monitorStatus: true, consecutiveFailures: true,
      lastMonitorAt: true, monitorIntervalSec: true,
      lastTelemetryAt: true, telemetryIntervalSec: true,
      lastSystemInfoAt: true, systemInfoIntervalSec: true,
      monitoredInterfaces: true,
      monitoredStorage: true,
      monitoredIpsecTunnels: true,
    },
  });

  function isDue(last: Date | null, perAsset: number | null, defaultSec: number): boolean {
    if (defaultSec <= 0) return false;
    const intervalSec = perAsset || defaultSec;
    if (!last) return true;
    return now.getTime() - last.getTime() >= intervalSec * 1000;
  }

  for (const a of candidates) {
    const cls = pickMonitorClass(settings, { assetType: a.assetType, manufacturer: a.manufacturer }) ?? settings;
    const baseProbeInterval = a.monitorIntervalSec || cls.intervalSeconds;
    const effectiveProbeInterval = probeIntervalWithBackoff(
      baseProbeInterval, a.monitorStatus, a.consecutiveFailures,
    );
    const probe      = isDue(a.lastMonitorAt,    null,                    effectiveProbeInterval);
    const telemetry  = isDue(a.lastTelemetryAt,  a.telemetryIntervalSec,  cls.telemetryIntervalSeconds);
    const systemInfo = isDue(a.lastSystemInfoAt, a.systemInfoIntervalSec, cls.systemInfoIntervalSeconds);
    const hasFastPin =
      (Array.isArray(a.monitoredInterfaces)   && a.monitoredInterfaces.length   > 0) ||
      (Array.isArray(a.monitoredStorage)      && a.monitoredStorage.length      > 0) ||
      (Array.isArray(a.monitoredIpsecTunnels) && a.monitoredIpsecTunnels.length > 0);
    const isDown = a.monitorStatus === "down";

    if (probe && enabled.has("probe")) {
      await publishMonitorJob("probe", a.id, a.monitorType ?? "unknown");
    }
    if (telemetry && !isDown && enabled.has("telemetry")) {
      await publishMonitorJob("telemetry", a.id);
    }
    if (systemInfo && !isDown && enabled.has("systemInfo")) {
      await publishMonitorJob("systemInfo", a.id);
    }
    if (probe && hasFastPin && !systemInfo && !isDown && enabled.has("fastFiltered")) {
      await publishMonitorJob("fastFiltered", a.id);
    }
  }
}

async function probeTick(): Promise<void> {
  if (runningProbe) return;
  runningProbe = true;
  try {
    if (getBootTimeMode() === "pgboss") {
      await publishDueWork(["probe", "fastFiltered"]);
    } else {
      const stats = await runMonitorPass({
        cadences: ["probe", "fastFiltered"],
        concurrency: PROBE_CONCURRENCY,
      });
      if (stats.probed > 0 || stats.fastFiltered.collected > 0) {
        logger.debug({ stats }, "Light monitor pass complete");
      }
    }
  } catch (err) {
    logger.error({ err }, "Light monitor tick failed");
  } finally {
    runningProbe = false;
  }
}

async function heavyTick(): Promise<void> {
  if (runningHeavy) return;
  runningHeavy = true;
  try {
    if (getBootTimeMode() === "pgboss") {
      await publishDueWork(["telemetry", "systemInfo"]);
    } else {
      const stats = await runMonitorPass({
        cadences: ["telemetry", "systemInfo"],
        concurrency: HEAVY_CONCURRENCY,
      });
      if (stats.telemetry.collected > 0 || stats.systemInfo.collected > 0) {
        logger.debug({ stats }, "Heavy monitor pass complete");
      }
    }
    if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      const [pruned, telPruned, sysPruned] = await Promise.all([
        pruneMonitorSamples(),
        pruneTelemetrySamples(),
        pruneSystemInfoSamples(),
      ]);
      lastPruneAt = Date.now();
      if (pruned > 0 || telPruned > 0 || sysPruned > 0) {
        logger.info({ pruned, telPruned, sysPruned }, "Pruned old monitor samples");
      }
    }
  } catch (err) {
    logger.error({ err }, "Heavy monitor tick failed");
  } finally {
    runningHeavy = false;
  }
}

probeTick();
heavyTick();
setInterval(probeTick, PROBE_TICK_MS);
setInterval(heavyTick, HEAVY_TICK_MS);
