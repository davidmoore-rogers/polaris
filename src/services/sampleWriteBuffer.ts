/**
 * src/services/sampleWriteBuffer.ts
 *
 * Periodic batch-flush buffer for the six monitor sample tables. The hot
 * monitor loop used to issue one `prisma.<sampleTable>.create()` or
 * `createMany()` per work item (per asset, per cadence) — every call
 * acquires one Prisma pool connection. At 1,700+ monitored assets and 132
 * concurrent worker slots, that's the dominant DB connection-pressure
 * driver during steady-state monitoring.
 *
 * Instead, the four `record*` functions in `monitoringService.ts` push
 * sample rows into per-table arrays held here, and a 2-second flush tick
 * (or a 5,000-row size threshold) collapses everything into one
 * `prisma.<table>.createMany()` per table. The state-machine writes
 * (`Asset.monitorStatus`, counters, `last*At` timestamps) stay synchronous
 * — only the append-only time-series rows are buffered.
 *
 * Trade-off: up to 2 s of sample data is lost on a hard crash. Acceptable
 * because (a) sample rows are an append-only time series and the next
 * cadence tick re-supplies fresh data, and (b) Asset-level state — the
 * thing that drives the UI's "current status" pill — is still written
 * synchronously so the operator's view stays consistent through a crash.
 *
 * SIGTERM-safe: `shutdownFlushSampleBuffers()` is awaited from the
 * graceful-shutdown hook in `app.ts` so the in-flight buffer drains
 * before the process exits.
 *
 * Eight append-only tables are batched here:
 *   - asset_monitor_samples         (probe outcomes)
 *   - asset_telemetry_samples       (CPU + memory)
 *   - asset_hardware_sensor_samples (per hardware sensor: temp/fan/voltage/…)
 *   - asset_interface_samples       (per-interface scrape)
 *   - asset_storage_samples         (per-mountpoint)
 *   - asset_ipsec_tunnel_samples    (per-tunnel)
 *   - asset_perf_sla_samples        (per SD-WAN health-check member)
 *   - asset_sdwan_rule_samples      (per SD-WAN service rule)
 *
 * Not batched here (separate handling): `asset_associated_ips` (per-asset
 * delete+create transaction inside `recordSystemInfoResult`) and
 * `asset_lldp_neighbors` (per-asset replace via `persistLldpNeighbors`).
 * Both need per-asset atomicity that an append-only buffer can't provide.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import { startSampleWriteTimer, setSampleBufferDepth } from "../metrics.js";

// ─── Row types ────────────────────────────────────────────────────────────
//
// Defined locally rather than importing Prisma's generated CreateManyInput
// types so the buffer can be unit-tested without a Prisma client in scope.
// The shapes must stay in sync with `prisma/schema.prisma`; the typecheck
// at the createMany call sites in `flushTable()` enforces that.

export interface MonitorSampleRow {
  assetId: string;
  timestamp: Date;
  success: boolean;
  responseTimeMs: number | null;
  error: string | null;
}

export interface TelemetrySampleRow {
  assetId: string;
  timestamp: Date;
  cpuPct: number | null;
  memPct: number | null;
  memUsedBytes: bigint | null;
  memTotalBytes: bigint | null;
}

export interface HardwareSensorSampleRow {
  assetId: string;
  timestamp: Date;
  sensorName: string;
  sensorClass: string; // temperature | fan | voltage | power | disk | other
  value: number | null;
  unit: string | null;
  alarmStatus: string | null;
}

/** Selection cadence for system-info samples (interface / storage / ipsec).
 *  "fast" = operator-pinned entity re-walked on the response-time cadence
 *  (kept at full retention with rollups); "slow" = full system-info scrape
 *  (kept 24h, never rolled up). Required on every write so the discriminator
 *  is always stamped — see selection-aware retention. */
export type SampleCadence = "fast" | "slow";

export interface InterfaceSampleRow {
  assetId: string;
  timestamp: Date;
  cadence: SampleCadence;
  ifName: string;
  adminStatus: string | null;
  operStatus: string | null;
  speedBps: bigint | null;
  ipAddress: string | null;
  macAddress: string | null;
  inOctets: bigint | null;
  outOctets: bigint | null;
  inErrors: bigint | null;
  outErrors: bigint | null;
  ifType: string | null;
  ifParent: string | null;
  vlanId: number | null;
  nativeVlan: number | null;
  taggedVlans: number[];
  trunksAllVlans: boolean;
  alias: string | null;
  description: string | null;
}

export interface StorageSampleRow {
  assetId: string;
  timestamp: Date;
  cadence: SampleCadence;
  mountPath: string;
  totalBytes: bigint | null;
  usedBytes: bigint | null;
}

export interface IpsecTunnelSampleRow {
  assetId: string;
  timestamp: Date;
  cadence: SampleCadence;
  tunnelName: string;
  parentInterface: string | null;
  remoteGateway: string | null;
  status: string;
  incomingBytes: bigint | null;
  outgoingBytes: bigint | null;
  proxyIdCount: number | null;
}

export interface PerfSlaSampleRow {
  assetId: string;
  timestamp: Date;
  cadence: SampleCadence;
  healthCheck: string;
  link: string;
  zone: string | null;
  state: string;
  latencyMs: number | null;
  jitterMs: number | null;
  packetLoss: number | null;
  latencyThresholdMs: number | null;
  jitterThresholdMs: number | null;
  packetLossThreshold: number | null;
}

export interface SdwanRuleSampleRow {
  assetId: string;
  timestamp: Date;
  cadence: SampleCadence;
  ruleName: string;
  ruleId: string | null;
  seq: number | null;
  enabled: boolean | null;
  mode: string | null;
  criteria: string | null;
  healthChecks: string[];
  dst: string[];
  status: string;
  selectedMember: string | null;
  availableMembers: string[];
  priorityZones: string[];
}

// ─── Per-table buffer state ───────────────────────────────────────────────

const buffers = {
  monitor:        [] as MonitorSampleRow[],
  telemetry:      [] as TelemetrySampleRow[],
  hardware:       [] as HardwareSensorSampleRow[],
  iface:          [] as InterfaceSampleRow[],
  storage:        [] as StorageSampleRow[],
  ipsecTunnel:    [] as IpsecTunnelSampleRow[],
  perfSla:        [] as PerfSlaSampleRow[],
  sdwanRule:      [] as SdwanRuleSampleRow[],
};

// Map each buffer key to its `polaris_sample_buffer_depth{table=...}` label
// AND the function that flushes it. Centralized so adding a new sample
// table is a one-line change here plus the matching prisma.createMany call
// in flushTable().
type BufferKey = keyof typeof buffers;

const TABLE_LABEL: Record<BufferKey, string> = {
  monitor:     "asset_monitor_samples",
  telemetry:   "asset_telemetry_samples",
  hardware:    "asset_hardware_sensor_samples",
  iface:       "asset_interface_samples",
  storage:     "asset_storage_samples",
  ipsecTunnel: "asset_ipsec_tunnel_samples",
  perfSla:     "asset_perf_sla_samples",
  sdwanRule:   "asset_sdwan_rule_samples",
};

// Flush early if any single table's depth exceeds this — keeps RSS bounded
// when something burst-publishes (e.g. a manual probe-all-now triggers a
// few thousand probe results inside one 2 s window).
const SIZE_THRESHOLD = 5000;

// Buffer hold window. 2 s = the maximum delay a sample waits before
// landing in Postgres. UI charts hosted off the sample tables will lag
// by at most this long.
export const FLUSH_INTERVAL_MS = 2000;

// ─── Public enqueue API ───────────────────────────────────────────────────
//
// All enqueue helpers are sync — they're called from inside the monitor
// hot loop and must not introduce await points. The size-threshold flush
// is launched via `void` (fire-and-forget) so a burst publisher doesn't
// block on the flush.

export function enqueueMonitorSample(row: MonitorSampleRow): void {
  buffers.monitor.push(row);
  setSampleBufferDepth(TABLE_LABEL.monitor, buffers.monitor.length);
  if (buffers.monitor.length >= SIZE_THRESHOLD) void flushTable("monitor");
}

export function enqueueTelemetrySample(row: TelemetrySampleRow): void {
  buffers.telemetry.push(row);
  setSampleBufferDepth(TABLE_LABEL.telemetry, buffers.telemetry.length);
  if (buffers.telemetry.length >= SIZE_THRESHOLD) void flushTable("telemetry");
}

export function enqueueHardwareSensorSamples(rows: HardwareSensorSampleRow[]): void {
  if (rows.length === 0) return;
  buffers.hardware.push(...rows);
  setSampleBufferDepth(TABLE_LABEL.hardware, buffers.hardware.length);
  if (buffers.hardware.length >= SIZE_THRESHOLD) void flushTable("hardware");
}

export function enqueueInterfaceSamples(rows: InterfaceSampleRow[]): void {
  if (rows.length === 0) return;
  buffers.iface.push(...rows);
  setSampleBufferDepth(TABLE_LABEL.iface, buffers.iface.length);
  if (buffers.iface.length >= SIZE_THRESHOLD) void flushTable("iface");
}

export function enqueueStorageSamples(rows: StorageSampleRow[]): void {
  if (rows.length === 0) return;
  buffers.storage.push(...rows);
  setSampleBufferDepth(TABLE_LABEL.storage, buffers.storage.length);
  if (buffers.storage.length >= SIZE_THRESHOLD) void flushTable("storage");
}

export function enqueueIpsecTunnelSamples(rows: IpsecTunnelSampleRow[]): void {
  if (rows.length === 0) return;
  buffers.ipsecTunnel.push(...rows);
  setSampleBufferDepth(TABLE_LABEL.ipsecTunnel, buffers.ipsecTunnel.length);
  if (buffers.ipsecTunnel.length >= SIZE_THRESHOLD) void flushTable("ipsecTunnel");
}

export function enqueuePerfSlaSamples(rows: PerfSlaSampleRow[]): void {
  if (rows.length === 0) return;
  buffers.perfSla.push(...rows);
  setSampleBufferDepth(TABLE_LABEL.perfSla, buffers.perfSla.length);
  if (buffers.perfSla.length >= SIZE_THRESHOLD) void flushTable("perfSla");
}

export function enqueueSdwanRuleSamples(rows: SdwanRuleSampleRow[]): void {
  if (rows.length === 0) return;
  buffers.sdwanRule.push(...rows);
  setSampleBufferDepth(TABLE_LABEL.sdwanRule, buffers.sdwanRule.length);
  if (buffers.sdwanRule.length >= SIZE_THRESHOLD) void flushTable("sdwanRule");
}

// ─── Flush ────────────────────────────────────────────────────────────────
//
// One flush per table per call so a slow table (e.g. interfaces, which can
// be 30-40 rows per asset per pass) doesn't hold up the others. Each table
// is independently rescheduled if a flush is already running.

const flushing: Record<BufferKey, boolean> = {
  monitor: false, telemetry: false, hardware: false,
  iface: false, storage: false, ipsecTunnel: false,
  perfSla: false, sdwanRule: false,
};

async function flushTable(key: BufferKey): Promise<void> {
  if (flushing[key]) return; // another caller already draining this table
  // Widen to `unknown[]` so the snapshot/retry path can swap rows around
  // without TypeScript collapsing the buffers' six-way union into an
  // unsatisfiable intersection. The concrete row type is enforced at the
  // `prisma.<table>.createMany` call sites in writeBatch().
  const buf: unknown[] = buffers[key] as unknown[];
  if (buf.length === 0) return;
  flushing[key] = true;
  // Snapshot + reset the buffer up front so concurrent enqueues during
  // the awaited write land in a fresh array. If the write fails after
  // retries we re-prepend the snapshot so nothing is dropped.
  const batch = buf.splice(0, buf.length);
  setSampleBufferDepth(TABLE_LABEL[key], 0);
  const stopTimer = startSampleWriteTimer(TABLE_LABEL[key]);
  try {
    await retryOnDeadlock(() => writeBatch(key, batch));
  } catch (err: unknown) {
    // Re-prepend so the next tick retries the same rows. Logged at warn so
    // operators see the failure but the process keeps running.
    logger.warn(
      { err: (err as Error)?.message, table: TABLE_LABEL[key], rowCount: batch.length },
      "sampleWriteBuffer: flush failed; rows will be retried on next tick",
    );
    buf.unshift(...batch);
    setSampleBufferDepth(TABLE_LABEL[key], buf.length);
  } finally {
    stopTimer();
    flushing[key] = false;
  }
}

// `createMany` per table. Kept as a switch because Prisma's typed API
// rejects passing the model name as a string — each `prisma.<x>.createMany`
// call has its own input type which is what enforces row-shape safety.
async function writeBatch(key: BufferKey, batch: unknown[]): Promise<void> {
  switch (key) {
    case "monitor":
      await prisma.assetMonitorSample.createMany({ data: batch as MonitorSampleRow[] });
      return;
    case "telemetry":
      await prisma.assetTelemetrySample.createMany({ data: batch as TelemetrySampleRow[] });
      return;
    case "hardware":
      await prisma.assetHardwareSensorSample.createMany({ data: batch as HardwareSensorSampleRow[] });
      return;
    case "iface":
      await prisma.assetInterfaceSample.createMany({ data: batch as InterfaceSampleRow[] });
      return;
    case "storage":
      await prisma.assetStorageSample.createMany({ data: batch as StorageSampleRow[] });
      return;
    case "ipsecTunnel":
      await prisma.assetIpsecTunnelSample.createMany({ data: batch as IpsecTunnelSampleRow[] });
      return;
    case "perfSla":
      await prisma.assetPerfSlaSample.createMany({ data: batch as PerfSlaSampleRow[] });
      return;
    case "sdwanRule":
      await prisma.assetSdwanRuleSample.createMany({ data: batch as SdwanRuleSampleRow[] });
      return;
  }
}

/** Drain every table. Used by the periodic tick and the shutdown hook. */
export async function flushAllSampleBuffers(): Promise<void> {
  await Promise.all(
    (Object.keys(buffers) as BufferKey[]).map((k) => flushTable(k)),
  );
}

// ─── Boot + shutdown ──────────────────────────────────────────────────────

let flushTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic flush tick. Safe to call multiple times — second and
 * later calls are no-ops. Called once from app.ts at startup.
 */
export function startSampleWriteBuffer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushAllSampleBuffers();
  }, FLUSH_INTERVAL_MS);
  // .unref() so the timer doesn't keep the event loop alive during a
  // graceful shutdown — the shutdown path awaits a final flush explicitly.
  flushTimer.unref?.();
}

/**
 * Final drain before process exit. Called from the SIGTERM/SIGINT hook
 * in app.ts. Idempotent — safe to call even if the timer never started.
 */
export async function shutdownFlushSampleBuffers(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushAllSampleBuffers();
}

// ─── Test hooks ───────────────────────────────────────────────────────────
//
// Exported under __test__ so unit tests can inspect/reset module state
// without exposing the buffers themselves to production callers.

export const __test__ = {
  getBufferDepth(key: BufferKey): number {
    return buffers[key].length;
  },
  reset(): void {
    for (const k of Object.keys(buffers) as BufferKey[]) {
      buffers[k].length = 0;
      flushing[k] = false;
      setSampleBufferDepth(TABLE_LABEL[k], 0);
    }
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  },
  flushTable,
};
