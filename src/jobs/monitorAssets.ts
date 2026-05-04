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
 * Each loop has its own `running` guard and concurrency. A long-running
 * heavy pass blocks ONLY future heavy ticks; the light loop keeps firing
 * on its own clock and re-evaluates which assets are due every 5 s.
 *
 * Cadence pacing is per-asset (Asset.monitorIntervalSec / telemetryIntervalSec
 * / systemInfoIntervalSec, falling back to the global defaults), so the
 * tick interval is intentionally faster than any reasonable cadence —
 * runMonitorPass filters out assets that aren't due yet.
 *
 * Default concurrency is CPU-aware (`cpus().length * 2` for the light loop,
 * `cpus().length` for the heavy one). Operators can override via env:
 *   POLARIS_PROBE_CONCURRENCY=...
 *   POLARIS_HEAVY_CONCURRENCY=...
 */

import { cpus } from "node:os";
import {
  runMonitorPass,
  pruneMonitorSamples,
  pruneTelemetrySamples,
  pruneSystemInfoSamples,
} from "../services/monitoringService.js";
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

async function probeTick(): Promise<void> {
  if (runningProbe) return;
  runningProbe = true;
  try {
    const stats = await runMonitorPass({
      cadences: ["probe", "fastFiltered"],
      concurrency: PROBE_CONCURRENCY,
    });
    if (stats.probed > 0 || stats.fastFiltered.collected > 0) {
      logger.debug({ stats }, "Light monitor pass complete");
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
    const stats = await runMonitorPass({
      cadences: ["telemetry", "systemInfo"],
      concurrency: HEAVY_CONCURRENCY,
    });
    if (stats.telemetry.collected > 0 || stats.systemInfo.collected > 0) {
      logger.debug({ stats }, "Heavy monitor pass complete");
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
