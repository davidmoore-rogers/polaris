/**
 * src/services/queueService.ts
 *
 * Monitor work queue mode + pg-boss runtime lifecycle. Polaris ships with
 * two queue implementations:
 *
 *   "cursor" (default) — the in-memory cursor-pool queue inside
 *                        runMonitorPass; used by every install out of
 *                        the box. Fits small/medium fleets fine after
 *                        the Step 4a split-tick fix.
 *   "pgboss"           — pg-boss-backed durable queue with per-cadence
 *                        worker pools (probe / fastFiltered / telemetry
 *                        / systemInfo). Recommended once monitored asset
 *                        count crosses ~500 or pass duration exceeds the
 *                        probe cadence; opt-in via the Maintenance tab
 *                        recommendation alert's [Enable on next restart]
 *                        button. Setting takes effect on next process
 *                        restart so the boot path can wire the right
 *                        scheduler before any tick fires.
 *
 * The active mode lives in `Setting.monitor.queueMode` (`"cursor" | "pgboss"`);
 * reads are cached at startup so subsequent `getQueueMode()` calls don't
 * round-trip the DB. `setQueueMode()` writes the Setting AND updates the
 * cache, but the running process keeps its boot-time mode — only the next
 * restart picks up the change. That's intentional: switching queue
 * scheduler mid-run would require draining in-flight jobs and restarting
 * timers, which is way more complexity than the operator-side restart
 * cost is worth.
 */

import { prisma } from "../db.js";

export type QueueMode = "cursor" | "pgboss";

const SETTING_KEY = "monitor.queueMode";

let cachedMode: QueueMode | null = null;
let cachedPgbossInstalled: boolean | null = null;
/**
 * Mode the running process actually uses. Captured at boot from the Setting
 * value; ignores subsequent setQueueMode() calls so the operator-driven
 * "enable on next restart" semantics are preserved without tracking two
 * separate caches in callers.
 */
let bootTimeMode: QueueMode | null = null;

/**
 * Try to dynamically load pg-boss. The package is bundled, so this only
 * fails if node_modules is incomplete or the install was extracted from a
 * stripped tarball. Cached after first call.
 */
export async function detectPgboss(): Promise<boolean> {
  if (cachedPgbossInstalled !== null) return cachedPgbossInstalled;
  try {
    await import("pg-boss");
    cachedPgbossInstalled = true;
  } catch {
    cachedPgbossInstalled = false;
  }
  return cachedPgbossInstalled;
}

export function isPgbossInstalled(): boolean {
  return cachedPgbossInstalled === true;
}

/**
 * Read the persisted queue mode. Cached after first call. Defaults to
 * "cursor" when no Setting is present, when the value is malformed, or
 * when pg-boss is somehow not installed (defensive fallback so a missing
 * package can never strand a fleet without monitoring).
 */
export async function getQueueMode(): Promise<QueueMode> {
  if (cachedMode !== null) return cachedMode;
  try {
    const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
    const v = row?.value as { mode?: string } | null;
    const fromSetting: QueueMode = v?.mode === "pgboss" ? "pgboss" : "cursor";
    cachedMode = fromSetting === "pgboss" && !isPgbossInstalled() ? "cursor" : fromSetting;
  } catch {
    cachedMode = "cursor";
  }
  return cachedMode;
}

/**
 * Persist the queue mode. Updates the Setting and refreshes the cache, but
 * does NOT change `getBootTimeMode()` — the running process continues using
 * whatever it picked up at boot. The new mode takes effect on next restart.
 */
export async function setQueueMode(mode: QueueMode): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: { mode } },
    create: { key: SETTING_KEY, value: { mode } },
  });
  cachedMode = mode;
}

/**
 * The mode this process is actually running with. Set once at boot by
 * `initializeQueue()`. Subsequent `setQueueMode()` calls update the Setting
 * and the on-disk cache but never this value, so dispatch in the monitor
 * job stays consistent for the lifetime of the process.
 */
export function getBootTimeMode(): QueueMode {
  return bootTimeMode ?? "cursor";
}

/**
 * Warm caches and capture the boot-time mode. Call once at startup, before
 * any monitor tick fires. Idempotent.
 */
export async function initializeQueue(): Promise<void> {
  await detectPgboss();
  bootTimeMode = await getQueueMode();
}
