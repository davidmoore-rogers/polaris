/**
 * src/services/fmgWorker.ts — Per-integration FortiManager worker with two lanes.
 *
 * FortiManager's "one-request-at-a-time" rule is specifically about its
 * `/sys/proxy/json` passthrough endpoint, which forwards calls through to
 * managed FortiGates. FMG drops parallel proxy connections past 1-2 concurrent
 * requests for the same API user. Native FMG endpoints (`/pm/config/...`,
 * `/dvmdb/...`) hit FMG's own database and don't have that constraint.
 *
 * This worker therefore exposes two lanes per integration:
 *
 *   • Proxy lane  — strict single-consumer FIFO (concurrency = 1). Honors the
 *                   FMG hard limit. Used for every `/sys/proxy/json` call.
 *   • Native lane — unbounded; just tracks inflight count for observability.
 *                   Used for every CMDB / dvmdb / auth / other native call.
 *
 * Each lane has its own gauges: `polaris_fmg_worker_queue_depth` and
 * `polaris_fmg_worker_inflight` apply to the proxy lane (back-compat with the
 * pre-split metric names); `polaris_fmg_worker_native_inflight` is the native
 * lane's counter.
 *
 * Cross-feature serialization still holds where it matters: discovery's per-
 * device proxy queries, reservation push (proxy mode), quarantine push (proxy
 * mode), and the manual /sys/proxy/json proxy endpoint all share the same
 * single proxy slot per integration. Native queries — mgmt-IP resolution,
 * CMDB scrapes, the device roster — now run concurrently up to whatever
 * `discoveryParallelism` and the host can handle.
 *
 * Abort: `submitProxy()` and `submitNative()` both accept an optional
 * AbortSignal. Proxy lane: pre-dispatch abort yanks the entry from the queue.
 * Native lane: abort fires the underlying task's own signal-aware fetch
 * (the worker doesn't queue native calls so there's nothing to yank).
 */

import {
  setFmgWorkerQueueDepth,
  setFmgWorkerInflight,
  setFmgWorkerNativeInflight,
} from "../metrics.js";

class AbortError extends Error {
  override name = "AbortError";
  constructor(message = "Aborted before FMG worker started the task") {
    super(message);
  }
}

interface QueueEntry<T = unknown> {
  label: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  // Listener attached to the signal so we can drop the entry from the queue
  // immediately on early abort. Removed on dispatch.
  onAbort?: () => void;
}

export class FmgWorker {
  readonly integrationId: string;

  // ── Proxy lane: strict FIFO concurrency=1 ──────────────────────────────
  private proxyQueue: QueueEntry[] = [];
  private proxyInFlight: QueueEntry | null = null;
  private proxyDraining = false;

  // ── Native lane: unbounded; just tracks inflight count ─────────────────
  private nativeInFlight = 0;

  constructor(integrationId: string) {
    this.integrationId = integrationId;
  }

  get proxyQueueDepth(): number {
    return this.proxyQueue.length;
  }

  get proxyInFlightLabel(): string | null {
    return this.proxyInFlight?.label ?? null;
  }

  get nativeInFlightCount(): number {
    return this.nativeInFlight;
  }

  /**
   * Submit a `/sys/proxy/json`-bound task to the strict proxy lane.
   * Returns a promise resolving with the task's result or rejecting with the
   * task's error. Aborting before the task starts removes the entry from the
   * queue and rejects with AbortError; aborting in-flight is the task's
   * responsibility (via the fetch signal).
   */
  submitProxy<T>(label: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new AbortError(`Aborted before submit: ${label}`));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = { label, run, resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          const idx = this.proxyQueue.indexOf(entry as QueueEntry);
          if (idx >= 0) {
            this.proxyQueue.splice(idx, 1);
            this.publishProxyDepth();
            entry.reject(new AbortError(`Aborted while queued: ${label}`));
          }
        };
        entry.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.proxyQueue.push(entry as QueueEntry);
      this.publishProxyDepth();
      this.drainProxy();
    });
  }

  /**
   * Submit a native FMG task (CMDB, dvmdb, auth, etc.) to the unbounded
   * native lane. The task fires immediately — the worker only tracks the
   * inflight count for the `polaris_fmg_worker_native_inflight` gauge.
   * Abort handling is the task's responsibility (fetch signal threading).
   */
  async submitNative<T>(label: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new AbortError(`Aborted before submit: ${label}`);
    }
    this.nativeInFlight++;
    this.publishNativeInflight();
    try {
      return await run();
    } finally {
      this.nativeInFlight--;
      this.publishNativeInflight();
    }
  }

  private async drainProxy(): Promise<void> {
    if (this.proxyDraining) return;
    this.proxyDraining = true;
    try {
      while (this.proxyQueue.length > 0) {
        const entry = this.proxyQueue.shift()!;
        this.publishProxyDepth();
        if (entry.signal && entry.onAbort) {
          entry.signal.removeEventListener("abort", entry.onAbort);
        }
        if (entry.signal?.aborted) {
          entry.reject(new AbortError(`Aborted before dispatch: ${entry.label}`));
          continue;
        }
        this.proxyInFlight = entry;
        this.publishProxyInflight(1);
        try {
          const result = await entry.run();
          entry.resolve(result);
        } catch (err) {
          entry.reject(err);
        } finally {
          this.proxyInFlight = null;
          this.publishProxyInflight(0);
        }
      }
    } finally {
      this.proxyDraining = false;
    }
  }

  private publishProxyDepth(): void {
    setFmgWorkerQueueDepth(this.integrationId, this.proxyQueue.length);
  }

  private publishProxyInflight(value: 0 | 1): void {
    setFmgWorkerInflight(this.integrationId, value);
  }

  private publishNativeInflight(): void {
    setFmgWorkerNativeInflight(this.integrationId, this.nativeInFlight);
  }
}

const workers = new Map<string, FmgWorker>();

/**
 * Returns the FmgWorker for the given integration id, creating it on first
 * call. Always returns the same worker instance for the same integration id
 * across the life of the process.
 */
export function getFmgWorker(integrationId: string): FmgWorker {
  let worker = workers.get(integrationId);
  if (!worker) {
    worker = new FmgWorker(integrationId);
    workers.set(integrationId, worker);
  }
  return worker;
}

/**
 * Returns every FmgWorker currently instantiated in this process. Used by the
 * activity-heartbeat job to publish a snapshot of proxy/native lane state to
 * the DB so the web role can surface it on the integration card even when the
 * actual FMG calls run in a separate discovery process.
 */
export function getAllFmgWorkers(): FmgWorker[] {
  return Array.from(workers.values());
}

/**
 * Test-only: clear the worker registry. Resets module state between test runs
 * so each test starts with a clean queue.
 */
export function __resetFmgWorkersForTests(): void {
  workers.clear();
}
