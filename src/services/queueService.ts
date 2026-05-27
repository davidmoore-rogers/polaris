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

import { cpus } from "node:os";
import type { PgBoss as PgBossType, Job as PgBossJob } from "pg-boss";

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { getDirectDatabaseUrl } from "../utils/dbConnections.js";
import {
  acquireWorkerSlot,
  createWorkerSlotPool,
  releaseWorkerSlot,
  type WorkerSlotPool,
} from "../utils/workerSlotPool.js";
import { setPgbossQueueJobs, setPgbossJobAge, recordQueueMode, setMonitorWorkers } from "../metrics.js";
import {
  runProbeFor,
  runTelemetryFor,
  runSystemInfoFor,
  runFastFilteredFor,
  runLldpFor,
  runStorageFor,
  type MonitorCadence,
} from "./monitoringService.js";

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
  recordQueueMode(bootTimeMode);
}

// ─── pg-boss runtime ───────────────────────────────────────────────────────
//
// Naming convention: every Polaris-owned monitor queue starts `polaris-monitor-`;
// the discovery queue is `polaris-discovery-run`. In the multi-process split the
// monitor queues are consumed by the `monitor` role and the discovery queue by
// the `discovery` role; the `web` role (and `all`) publish to both. Each process
// opens its own pg-boss connection via ensureBoss().

export const QUEUE_NAMES: Record<MonitorCadence, string> = {
  probe:        "polaris-monitor-probe",
  fastFiltered: "polaris-monitor-fastfiltered",
  telemetry:    "polaris-monitor-telemetry",
  systemInfo:   "polaris-monitor-systeminfo",
  // Phase 2 carve-out: LLDP + Storage each get their own queue + worker pool
  // + per-asset cadence. Same coalescing semantics as the other cadences
  // (singleton key `<assetId>:<cadence>` collapses duplicate publishes).
  lldp:         "polaris-monitor-lldp",
  storage:      "polaris-monitor-storage",
};

interface MonitorJobPayload {
  assetId: string;
  /**
   * Resolved per-cadence polling method (probe=responseTimePolling,
   * telemetry=telemetryPolling, systemInfo + fastFiltered=interfacesPolling).
   * Labels the per-transport metric. Optional for back-compat with jobs
   * enqueued before this field was added — worker falls back to "unknown".
   */
  transport?: string;
  /**
   * Asset.assetType captured at publish time so the worker can stamp it onto
   * the work-duration histogram without re-reading from the DB. Optional for
   * back-compat with jobs enqueued before this field was added — worker falls
   * back to "unknown".
   */
  assetType?: string;
  /**
   * When true, the worker emits per-job pickup + finish lines at info level
   * with the worker slot id. Set by the publisher when the asset's source
   * integration has `config.verboseLogging === true`. Optional; absent =
   * quiet operation (the default for every install).
   */
  verboseDebug?: boolean;
}

// ─── discovery queue ───────────────────────────────────────────────────────
// Discovery runs as a pg-boss job so it can execute in a dedicated `discovery`
// process instead of inline on the web/producer node. `policy: "singleton"` +
// `singletonKey: integrationId` enforces one active run per integration across
// all processes (the cross-process replacement for the old in-memory
// `activeDiscovery` Map). Runs take minutes, so the handler-runtime cap is far
// larger than any monitor cadence — undersizing it would have pg-boss kill a
// run mid-walk.
export const DISCOVERY_QUEUE_NAME = "polaris-discovery-run";

export interface DiscoveryJobPayload {
  integrationId: string;
  actor: string;
}

/** Signature of the discovery executor injected by the boot path (app.ts). */
export type DiscoveryJobHandler = (integrationId: string, actor: string) => Promise<void>;

let bossInstance: PgBossType | null = null;
let metricsRefreshInterval: ReturnType<typeof setInterval> | null = null;
// Idempotency flags so the per-capability start* functions can each ensure the
// boss/queues without duplicating worker registrations. In the `all` role every
// start* runs in one process; in the split each runs in its own process.
let monitorWorkersStarted = false;
let discoveryWorkerStarted = false;
let queuesEnsured = false;

// Per-cadence worker slot pools, populated at boot inside startPgbossWorkers().
// Acquire on handler entry, release on exit so the slot id rotates through
// jobs in order. Used by both the dedicated workers and the floating loop
// to give operators a human-readable identity in journalctl when an
// integration has `config.verboseLogging` on.
let slotPools: {
  probe:        WorkerSlotPool;
  fastFiltered: WorkerSlotPool;
  telemetry:    WorkerSlotPool;
  systemInfo:   WorkerSlotPool;
  lldp:         WorkerSlotPool;
  storage:      WorkerSlotPool;
  floating:     WorkerSlotPool;
} | null = null;

/**
 * Shared wrapper for the four dedicated `boss.work()` handlers. Acquires
 * a slot from the cadence's pool, optionally logs `monitor.worker.pickup`
 * / `monitor.worker.finish` when the job carries `verboseDebug=true`, and
 * releases the slot in a finally block so a thrown handler doesn't leak it.
 */
async function runDedicatedWorker(
  cadence: MonitorCadence,
  job: PgBossJob<MonitorJobPayload>,
  exec: (assetId: string, labels: { transport: string; assetType: string; verbose?: boolean }) => Promise<unknown>,
): Promise<void> {
  const pool = slotPools![cadence];
  const workerSlot = acquireWorkerSlot(pool);
  const { assetId, transport, assetType, verboseDebug } = job.data;
  // `verbose` is read by monitoringService's AsyncLocalStorage phase context
  // and is intentionally NOT included in the Prometheus work labels — those
  // stay {asset_type, transport} only to keep label cardinality bounded.
  const labels = { transport: transport ?? "unknown", assetType: assetType ?? "unknown", verbose: !!verboseDebug };
  const startedAt = verboseDebug ? Date.now() : 0;
  if (verboseDebug) {
    logger.info(
      { verbose: true, workerSlot, jobId: job.id, cadence, assetId, transport: labels.transport, assetType: labels.assetType },
      "monitor.worker.pickup",
    );
  }
  let outcome: "success" | "failure" = "success";
  try {
    await exec(assetId, labels);
  } catch (err) {
    outcome = "failure";
    throw err;
  } finally {
    if (verboseDebug) {
      logger.info(
        { verbose: true, workerSlot, jobId: job.id, cadence, assetId, outcome, elapsedMs: Date.now() - startedAt },
        "monitor.worker.finish",
      );
    }
    releaseWorkerSlot(pool, workerSlot);
  }
}

// ─── Floating workers ───────────────────────────────────────────────────────
//
// Dedicated `boss.work()` subscriptions own a fixed slice of capacity per
// queue. With four queues at flat localConcurrency, idle slots on quiet
// queues (probe drains fast, fastFiltered is usually empty) sit unused
// while telemetry / systemInfo backlog. The floating loop polls all four
// queues in priority order via `boss.fetch()` so that idle capacity flows
// to wherever the work actually is. Total max-concurrent (dedicated +
// floating) is bounded so the DB pool ceiling stays the same.
//
// `floatingInFlight` is a soft counter — it counts dispatched jobs whose
// dispatchFloatingJob promise hasn't resolved. The loop pauses fetching
// once it hits `maxFloat`. `floatingLoopRunning` is the shutdown signal
// flipped by stopPgbossWorkers.

let floatingInFlight = 0;
let floatingLoopRunning = false;

// Floating worker priority order (Phase 2):
//   probe > fastFiltered > lldp > storage > telemetry > systemInfo
// LLDP outranks storage because LLDP feeds the topology graph (visible to
// operators in the Device Map and asset details Neighbor column) and is
// generally cheaper than the per-vendor disk scalar pair; storage outranks
// telemetry because storage feeds capacity alerts directly. Both still sit
// below probe/fastFiltered so probes (the cheapest cadence) never starve.
const FLOAT_PRIORITY: MonitorCadence[] = ["probe", "fastFiltered", "lldp", "storage", "telemetry", "systemInfo"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Stalled-worker watchdog ─────────────────────────────────────────────────
//
// pg-boss workers stop consuming when the internal polling timer crashes on a
// DB connection error — the "error" event fires and is logged, but the timer
// doesn't restart automatically. The symptom: many jobs in "created" state,
// 0 active for > 1 minute. The fix is a full stop→start cycle.
//
// Safety rails: at most 3 auto-recoveries per rolling hour; each attempt is
// logged so operators can see what happened in journalctl. After the cap is
// hit, a plain error is logged every minute so the alert remains visible.

const STALL_CREATED_THRESHOLD  = 50;   // > 50 queued jobs with 0 active = suspicious
const STALL_CONSECUTIVE_LIMIT   = 4;   // 4 × 15 s = 1 min before we act
const STALL_MAX_RECOVERIES      = 3;
const STALL_RECOVERY_WINDOW_MS  = 60 * 60 * 1000; // 1 h rolling window

let stalledReadings  = 0;
let recoveryAttempts: number[] = []; // timestamps of recent auto-recoveries
let recovering       = false;

async function attemptWorkerRecovery(): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    logger.warn("pg-boss workers stalled; attempting auto-recovery (stop → start)");
    // Stop the floating loop so the next startPgbossWorkers can re-start it.
    floatingLoopRunning = false;
    // Clear the metrics interval so startPgbossWorkers won't create a duplicate.
    if (metricsRefreshInterval !== null) {
      clearInterval(metricsRefreshInterval);
      metricsRefreshInterval = null;
    }
    if (bossInstance) {
      try { await bossInstance.stop({ graceful: false, timeout: 10_000 }); } catch { /* best-effort */ }
      bossInstance = null;
    }
    await startPgbossWorkers();
    logger.info("pg-boss worker auto-recovery completed");
  } catch (err) {
    logger.error({ err }, "pg-boss worker auto-recovery failed — restart polaris to recover monitoring");
  } finally {
    recovering = false;
  }
}

/**
 * Refresh pg-boss queue-depth metrics by querying pgboss.job directly.
 * Runs every 15s while pg-boss is active. Zero-fills all queue×state
 * combinations first so gauges don't linger when a queue drains.
 * Also runs the stalled-worker watchdog on each tick.
 */
async function refreshPgbossMetrics(): Promise<void> {
  let totalCreated = 0;
  let totalActive  = 0;
  let heavyCreated = 0;
  let heavyActive  = 0;
  try {
    const queueNames = Object.values(QUEUE_NAMES);
    // MAX(EXTRACT(...)) gives the oldest waiting job per (queue, state) so a
    // queue that's draining quickly (low age) is distinguishable from one
    // that's stuck (high age) even at identical depth.
    const rows = await prisma.$queryRaw<Array<{ name: string; state: string; count: number; age_seconds: number | null }>>`
      SELECT name,
             state,
             count(*)::int AS count,
             EXTRACT(EPOCH FROM (now() - MIN(created_on)))::float8 AS age_seconds
      FROM pgboss.job
      WHERE name = ANY(${queueNames}::text[])
      AND state IN ('created', 'active', 'failed')
      GROUP BY name, state
    `;
    for (const name of queueNames) {
      setPgbossQueueJobs(name, "created", 0);
      setPgbossQueueJobs(name, "active", 0);
      setPgbossQueueJobs(name, "failed", 0);
      setPgbossJobAge(name, "created", 0);
      setPgbossJobAge(name, "active", 0);
    }
    const heavyQueues = new Set([QUEUE_NAMES.telemetry, QUEUE_NAMES.systemInfo, QUEUE_NAMES.lldp, QUEUE_NAMES.storage]);
    for (const row of rows) {
      setPgbossQueueJobs(row.name, row.state, Number(row.count));
      // Only created/active have a meaningful "oldest job age." Failed jobs
      // sit until the 1h archive runs; their age isn't a backlog signal.
      if (row.state === "created" || row.state === "active") {
        const age = row.age_seconds != null ? Number(row.age_seconds) : 0;
        setPgbossJobAge(row.name, row.state, Number.isFinite(age) ? age : 0);
      }
      if (row.state === "created") {
        totalCreated += Number(row.count);
        if (heavyQueues.has(row.name)) heavyCreated += Number(row.count);
      }
      if (row.state === "active") {
        totalActive += Number(row.count);
        if (heavyQueues.has(row.name)) heavyActive += Number(row.count);
      }
    }
  } catch (err) {
    logger.debug({ err }, "pg-boss metrics refresh failed");
    return;
  }

  // Stalled-worker watchdog. Two independent stall conditions:
  //   (a) all queues — probe workers also stalled (totalActive === 0)
  //   (b) heavy queues only — telemetry/systemInfo stalled while probe runs fine
  // Check (b) catches the partial-stall case where probe workers are active
  // but heavy workers have stopped, which makes totalActive > 0 so (a) never
  // fires despite the backlog.
  const isStalled =
    (totalCreated > STALL_CREATED_THRESHOLD && totalActive === 0) ||
    (heavyCreated > STALL_CREATED_THRESHOLD && heavyActive === 0);

  if (isStalled) {
    stalledReadings++;
    if (stalledReadings >= STALL_CONSECUTIVE_LIMIT) {
      const now = Date.now();
      recoveryAttempts = recoveryAttempts.filter(t => now - t < STALL_RECOVERY_WINDOW_MS);
      if (recoveryAttempts.length < STALL_MAX_RECOVERIES) {
        recoveryAttempts.push(now);
        stalledReadings = 0;
        void attemptWorkerRecovery();
      } else if (stalledReadings % STALL_CONSECUTIVE_LIMIT === 0) {
        // Recovery cap hit — keep logging so the operator sees it
        logger.error(
          { totalCreated, heavyCreated, heavyActive, recoveryAttempts: recoveryAttempts.length },
          "pg-boss workers stalled and auto-recovery cap reached — run: systemctl restart polaris",
        );
      }
    }
  } else {
    stalledReadings = 0;
  }
}

function resolveEnvInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Default worker counts when pg-boss is the active queue. Sized for the
 * "you flipped this on because the cursor queue can't keep up" case, not
 * the small-fleet case (small fleets stay on cursor). Operators can override
 * via env var when benchmarking warrants.
 *
 * Architecture: 24 dedicated workers per queue (4 × 24 = 96 slots) plus a
 * floating pool of 32 workers that polls all four queues in priority order.
 * Total ceiling 128 — same as the previous 32×4 — but the floating pool
 * shifts to wherever the backlog is, so a chronically-busy queue
 * (telemetry / systemInfo on big fleets) gets effective ~56 workers when
 * it needs them, while quiet queues (fastFiltered) don't waste capacity.
 *
 *   POLARIS_MONITOR_PROBE_WORKERS    dedicated workers for probe queue          (default 24)
 *   POLARIS_MONITOR_FAST_WORKERS     dedicated workers for fastFiltered queue   (default 24)
 *   POLARIS_MONITOR_HEAVY_WORKERS    dedicated workers for telemetry + systemInfo queues (default 24 each)
 *   POLARIS_MONITOR_FLOATING_WORKERS floating pool that polls all queues       (default 32)
 */

/**
 * Boot pg-boss and register the four monitor cadence queues. No-op when
 * the boot-time mode is "cursor". Idempotent — repeated calls are absorbed.
 *
 * Workers call back into the same `runFooFor()` functions the cursor pass
 * uses, so per-asset side effects (Asset.update, sample inserts, metrics)
 * are identical between modes — the only thing that differs is who's
 * holding the work queue.
 *
 * Job retention windows match what we'd want for monitor-grade work:
 *   - completed jobs archive after 1h (Polaris already records every probe
 *     outcome in AssetMonitorSample; pg-boss's job row is just queue
 *     bookkeeping, not the source of truth)
 *   - failed jobs archive after 1h (same — failures replicate to monitor
 *     samples and Events; pg-boss's failure rows are debugging breadcrumbs)
 *   - archive deletes after 7 days (covers a "what happened last week"
 *     forensic window without bloating pg-boss's tables)
 */
/**
 * Idempotently open this process's pg-boss connection. Returns the shared
 * instance, or null when pg-boss can't/shouldn't run (cursor mode, package
 * missing, no direct URL). Every role that publishes or consumes calls this;
 * it creates the connection at most once per process.
 */
async function ensureBoss(): Promise<PgBossType | null> {
  if (bossInstance) return bossInstance;
  if (getBootTimeMode() !== "pgboss") return null;
  if (!isPgbossInstalled()) {
    logger.warn("pg-boss queue mode requested but package not installed; staying on cursor");
    return null;
  }
  // Route pg-boss through the direct Postgres URL even when DATABASE_URL
  // points at PgBouncer. pg-boss uses LISTEN/NOTIFY for job-state
  // propagation AND relies on the pg client's prepared-statement cache —
  // both break under PgBouncer transaction pooling. Falls back to
  // DATABASE_URL when POLARIS_DB_DIRECT_URL is unset (= operator is not
  // running PgBouncer; existing single-URL installs are unchanged).
  const directUrl = getDirectDatabaseUrl();
  if (!directUrl) {
    logger.warn("pg-boss requested but neither POLARIS_DB_DIRECT_URL nor DATABASE_URL is set; staying on cursor");
    return null;
  }

  const { PgBoss } = await import("pg-boss");
  // pg-boss manages its own pg.Pool separate from Prisma's adapter pool.
  // Default 20 — sized for the bumped worker defaults below (max 64 per
  // queue on bigger boxes); operators on small pg-boss fleets can drop it
  // back via env var. Expose as POLARIS_PGBOSS_POOL_SIZE so operators can
  // size it alongside DATABASE_POOL_SIZE. NOTE (multi-process): each role's
  // process opens its own pool, so total Postgres connections ≈
  // web + N×monitor + discovery; size against max_connections. See the
  // Capacity Advisor's group-aware budget.
  const pgbossPoolSize = resolveEnvInt("POLARIS_PGBOSS_POOL_SIZE", 20);
  const boss: PgBossType = new PgBoss({
    connectionString: directUrl,
    max: pgbossPoolSize,
  });

  boss.on("error", (err: Error) => {
    logger.error({ err }, "pg-boss error");
  });

  await boss.start();
  bossInstance = boss;
  return boss;
}

/**
 * Idempotently create + converge every Polaris queue (monitor cadences +
 * discovery). createQueue is idempotent on name but does NOT re-apply config
 * to an existing queue, so each createQueue is paired with an updateQueue to
 * force convergence on installs that predate a config change. Run by every
 * role touching pg-boss so a producer-only process can `send` before any
 * consumer has registered.
 */
async function ensureQueues(boss: PgBossType): Promise<void> {
  if (queuesEnsured) return;
  // Per-queue config:
  //   - policy "singleton" + singletonKey on every send → only one job
  //     per (assetId, cadence) can be queued or active. Duplicate submits
  //     while a job is in flight are absorbed silently. Natural coalescing
  //     for the publisher's "re-evaluate every tick" pattern. Different
  //     assetIds run fully in parallel up to localConcurrency. (Earlier
  //     iterations passed "exclusive" here, which is not a documented
  //     pg-boss policy and silently throttled each queue to ~1 active job
  //     globally regardless of localConcurrency.)
  //   - retryLimit 0: monitor cadences are stateless. Next tick re-evaluates
  //     due state and re-publishes; better than retrying with stale snapshot.
  //   - deleteAfterSeconds 1d: keep recent completed/failed for debugging,
  //     then drop. The real audit trail lives in AssetMonitorSample / Events.
  //   - retentionSeconds 1h: bounds queued/retry backlog so a stuck queue
  //     can't bloat unbounded.
  //   - expireInSeconds: handler-runtime cap per queue. pg-boss kills a
  //     handler that exceeds this with `handler execution exceeded Ns` and
  //     marks the job failed. Sized per cadence to bound the worst-case
  //     real work: probe is a single network round trip; fastFiltered is
  //     one collector round-trip; telemetry walks a few SNMP tables;
  //     systemInfo walks every interface + storage + IPsec phase-1/2 +
  //     LLDP. A uniform 60s was killing telemetry/systemInfo jobs mid-walk
  //     on slow SNMP devices, leaving them in `failed` state with empty
  //     error messages (the wrapper never got to stamp one) and forcing
  //     re-publish on the next tick — visible as queue backlog that
  //     workers couldn't drain. Per-queue caps let the heavy cadences
  //     finish naturally without raising worker counts.
  const EXPIRE_BY_QUEUE: Record<MonitorCadence, number> = {
    probe:        30,   // single round trip; probeTimeoutMs ≤ 60s with margin
    fastFiltered: 60,   // one collector round-trip + buffered writes
    telemetry:    180,  // SNMP walks for CPU/mem/sensors
    systemInfo:   300,  // full interface + storage + IPsec + LLDP walk
    // Phase 2 carve-out — LLDP and Storage each get their own queue with the
    // same handler timeout as systemInfo since they share its walk family
    // (SNMP-MIB or FortiOS REST) and might tail at the same pace.
    lldp:         600,
    storage:      600,
  };
  // createQueue is idempotent on name but does NOT re-apply config to an
  // existing queue — the stored `expire_seconds` / `retry_limit` / etc on
  // `pgboss.queue` are persisted on first create and ignored on subsequent
  // calls. So after every createQueue we also issue updateQueue with the
  // same options to force the config to converge on existing installs.
  // updateQueue accepts every field on Queue except `name` / `partition`
  // / `policy`, so policy is set only on createQueue. Cheap no-op when
  // values already match.
  for (const cadence of Object.keys(QUEUE_NAMES) as MonitorCadence[]) {
    const name = QUEUE_NAMES[cadence];
    const queueOptions = {
      retryLimit: 0,
      deleteAfterSeconds: 86_400,
      retentionSeconds: 3_600,
      expireInSeconds: EXPIRE_BY_QUEUE[cadence],
    };
    await boss.createQueue(name, { policy: "singleton", ...queueOptions });
    await boss.updateQueue(name, queueOptions);
  }

  // Discovery queue. Singleton on integrationId (one active run per
  // integration). expireInSeconds dwarfs the monitor caps because a discovery
  // run legitimately takes minutes (FMG fleet walk + DB sync); too-low would
  // have pg-boss kill the run mid-walk. retryLimit 0 — discovery side effects
  // (asset/subnet writes, Events) aren't cheap to replay; the scheduler
  // re-enqueues on its next tick and operators can re-trigger.
  {
    const discoveryOptions = {
      retryLimit: 0,
      deleteAfterSeconds: 86_400,
      retentionSeconds: 7_200,
      expireInSeconds: resolveEnvInt("POLARIS_DISCOVERY_EXPIRE_SECONDS", 3_600),
    };
    await boss.createQueue(DISCOVERY_QUEUE_NAME, { policy: "singleton", ...discoveryOptions });
    await boss.updateQueue(DISCOVERY_QUEUE_NAME, discoveryOptions);
  }

  queuesEnsured = true;
}

/**
 * Ensure the 15s pg-boss metrics refresh loop is running. Idempotent so any
 * role (web producer, monitor, discovery) can call it without spawning a
 * second interval.
 */
function ensureMetricsRefresh(): void {
  if (metricsRefreshInterval !== null) return;
  void refreshPgbossMetrics();
  metricsRefreshInterval = setInterval(() => { void refreshPgbossMetrics(); }, 15_000);
}

/**
 * Producer-only init for roles that publish but don't consume (web / all's
 * scheduler tier). Opens the boss connection + ensures queues exist so
 * publishMonitorJob / publishDiscoveryJob have a live `send` target, and
 * starts the metrics refresh so the Maintenance tab sees queue depth.
 */
export async function startQueueProducer(): Promise<void> {
  const boss = await ensureBoss();
  if (!boss) return;
  await ensureQueues(boss);
  ensureMetricsRefresh();
  logger.info("pg-boss producer initialized (publish-only role)");
}

/**
 * Register the discovery-queue consumer. Called only by roles with
 * runsDiscoveryConsumers (discovery / all). The executor is injected by the
 * boot path to avoid a queueService→discoveryRunner→integrations→queueService
 * import cycle.
 */
export async function startDiscoveryWorker(handler: DiscoveryJobHandler): Promise<void> {
  if (discoveryWorkerStarted) return;
  const boss = await ensureBoss();
  if (!boss) return;
  await ensureQueues(boss);
  const discoveryWorkers = resolveEnvInt("POLARIS_DISCOVERY_WORKERS", 2);
  await boss.work<DiscoveryJobPayload>(DISCOVERY_QUEUE_NAME, {
    localConcurrency: discoveryWorkers, batchSize: 1, pollingIntervalSeconds: 5,
  }, async (jobs: PgBossJob<DiscoveryJobPayload>[]) => {
    const { integrationId, actor } = jobs[0].data;
    await handler(integrationId, actor);
  });
  discoveryWorkerStarted = true;
  ensureMetricsRefresh();
  logger.info({ discoveryWorkers }, "pg-boss discovery worker started");
}

export async function startPgbossWorkers(): Promise<void> {
  if (monitorWorkersStarted) return;
  const boss = await ensureBoss();
  if (!boss) return;
  await ensureQueues(boss);

  // pg-boss v12 renamed the concurrency knobs. `localConcurrency` is the
  // total number of jobs this node will process in parallel for the queue
  // (replaces v11's teamSize × teamConcurrency product). Defaults are flat
  // 24 per queue; the per-queue baseline is supplemented by a floating pool
  // (default 32) that polls all four queues in priority order so idle
  // capacity follows the actual backlog. See the workerSize comment above.
  const probeWorkers    = resolveEnvInt("POLARIS_MONITOR_PROBE_WORKERS", 24);
  const fastWorkers     = resolveEnvInt("POLARIS_MONITOR_FAST_WORKERS",  24);
  const heavyWorkers    = resolveEnvInt("POLARIS_MONITOR_HEAVY_WORKERS", 24);
  // Phase 2 carve-out workers. Defaults sized smaller than heavy (12 vs 24)
  // because LLDP and Storage are lower-frequency than systemInfo + telemetry.
  // Operators on fleets that aggressively reuse the LLDP topology graph can
  // bump POLARIS_MONITOR_LLDP_WORKERS / POLARIS_MONITOR_STORAGE_WORKERS via env.
  const lldpWorkers     = resolveEnvInt("POLARIS_MONITOR_LLDP_WORKERS",    12);
  const storageWorkers  = resolveEnvInt("POLARIS_MONITOR_STORAGE_WORKERS", 12);
  const floatingWorkers = resolveEnvInt("POLARIS_MONITOR_FLOATING_WORKERS", 32);
  setMonitorWorkers({
    probe:        probeWorkers,
    fastFiltered: fastWorkers,
    telemetry:    heavyWorkers,
    systemInfo:   heavyWorkers,
    lldp:         lldpWorkers,
    storage:      storageWorkers,
    floating:     floatingWorkers,
  });
  logger.info(
    {
      probeWorkers, fastWorkers, heavyWorkers, lldpWorkers, storageWorkers, floatingWorkers, cores: cpus().length,
    },
    "pg-boss workers configured",
  );

  // Per-cadence slot pools. Acquired on handler entry, released on exit so
  // an operator can trace one slot's lifecycle through journalctl. Always
  // assigned (cheap); only logged at info level when the job carries
  // `verboseDebug=true`. See src/utils/workerSlotPool.ts.
  slotPools = {
    probe:        createWorkerSlotPool("probe",     probeWorkers),
    fastFiltered: createWorkerSlotPool("fast",      fastWorkers),
    telemetry:    createWorkerSlotPool("telemetry", heavyWorkers),
    systemInfo:   createWorkerSlotPool("sysinfo",   heavyWorkers),
    lldp:         createWorkerSlotPool("lldp",      lldpWorkers),
    storage:      createWorkerSlotPool("storage",   storageWorkers),
    floating:     createWorkerSlotPool("floating",  floatingWorkers),
  };

  await boss.work<MonitorJobPayload>(QUEUE_NAMES.probe, {
    localConcurrency: probeWorkers, batchSize: 1, pollingIntervalSeconds: 1,
  }, async (jobs: PgBossJob<MonitorJobPayload>[]) => {
    await runDedicatedWorker("probe", jobs[0], (assetId, labels) =>
      runProbeFor(assetId, labels),
    );
  });

  await boss.work<MonitorJobPayload>(QUEUE_NAMES.fastFiltered, {
    localConcurrency: fastWorkers, batchSize: 1, pollingIntervalSeconds: 2,
  }, async (jobs: PgBossJob<MonitorJobPayload>[]) => {
    await runDedicatedWorker("fastFiltered", jobs[0], (assetId, labels) =>
      runFastFilteredFor(assetId, labels),
    );
  });

  await boss.work<MonitorJobPayload>(QUEUE_NAMES.telemetry, {
    localConcurrency: heavyWorkers, batchSize: 1, pollingIntervalSeconds: 5,
  }, async (jobs: PgBossJob<MonitorJobPayload>[]) => {
    await runDedicatedWorker("telemetry", jobs[0], (assetId, labels) =>
      runTelemetryFor(assetId, labels),
    );
  });

  await boss.work<MonitorJobPayload>(QUEUE_NAMES.systemInfo, {
    localConcurrency: heavyWorkers, batchSize: 1, pollingIntervalSeconds: 5,
  }, async (jobs: PgBossJob<MonitorJobPayload>[]) => {
    await runDedicatedWorker("systemInfo", jobs[0], (assetId, labels) =>
      runSystemInfoFor(assetId, labels),
    );
  });

  await boss.work<MonitorJobPayload>(QUEUE_NAMES.lldp, {
    localConcurrency: lldpWorkers, batchSize: 1, pollingIntervalSeconds: 5,
  }, async (jobs: PgBossJob<MonitorJobPayload>[]) => {
    await runDedicatedWorker("lldp", jobs[0], (assetId, labels) =>
      runLldpFor(assetId, labels),
    );
  });

  await boss.work<MonitorJobPayload>(QUEUE_NAMES.storage, {
    localConcurrency: storageWorkers, batchSize: 1, pollingIntervalSeconds: 5,
  }, async (jobs: PgBossJob<MonitorJobPayload>[]) => {
    await runDedicatedWorker("storage", jobs[0], (assetId, labels) =>
      runStorageFor(assetId, labels),
    );
  });

  monitorWorkersStarted = true;

  // Floating pool: fire-and-forget. Loop self-manages via floatingLoopRunning.
  void startFloatingWorkers(boss, floatingWorkers);

  ensureMetricsRefresh();
  logger.info(
    { probeWorkers, fastWorkers, heavyWorkers, floatingWorkers },
    "pg-boss queue workers started",
  );
}

/**
 * Floating worker loop. One async function in the foreground polling all
 * four queues with `boss.fetch()`; each fetched job is dispatched to its
 * cadence's runner and counted against `floatingInFlight` until the
 * dispatch promise resolves. When `floatingInFlight >= maxFloat`, the loop
 * sleeps briefly and retries — the cap bounds total floating concurrency
 * regardless of how fast jobs arrive.
 *
 * Priority order matters because `boss.fetch()` is per-queue: the loop
 * always tries probe first, then fastFiltered, then telemetry, then
 * systemInfo. Whichever queue has work first wins the slot. Sleep
 * intervals are tuned for "common case is empty" — 500 ms idle wait keeps
 * the polling load on Postgres modest while still picking up bursts within
 * a single probe cadence.
 *
 * Singleton-key dedup at the publish layer means a floating worker can
 * never collide with a dedicated worker on the same (assetId, cadence) —
 * pg-boss already coalesces those into one in-flight job.
 */
async function startFloatingWorkers(boss: PgBossType, maxFloat: number): Promise<void> {
  if (maxFloat <= 0) {
    logger.info("floating worker pool disabled (POLARIS_MONITOR_FLOATING_WORKERS=0)");
    return;
  }
  floatingLoopRunning = true;
  logger.info({ maxFloat }, "floating worker loop started");
  while (floatingLoopRunning) {
    if (floatingInFlight >= maxFloat) {
      await sleep(100);
      continue;
    }

    let job: PgBossJob<MonitorJobPayload> | null = null;
    let pickedCadence: MonitorCadence | null = null;
    try {
      for (const cadence of FLOAT_PRIORITY) {
        const batch = await boss.fetch<MonitorJobPayload>(QUEUE_NAMES[cadence]);
        if (batch && batch.length > 0) {
          job = batch[0];
          pickedCadence = cadence;
          break;
        }
      }
    } catch (err) {
      logger.warn({ err }, "floating worker fetch failed");
      await sleep(1_000);
      continue;
    }

    if (!job || !pickedCadence) {
      await sleep(500);
      continue;
    }

    floatingInFlight++;
    void dispatchFloatingJob(boss, job, pickedCadence).finally(() => { floatingInFlight--; });
  }
  logger.info("floating worker loop stopped");
}

async function dispatchFloatingJob(
  boss: PgBossType,
  job: PgBossJob<MonitorJobPayload>,
  cadence: MonitorCadence,
): Promise<void> {
  const queueName = QUEUE_NAMES[cadence];
  const { assetId, transport, assetType, verboseDebug } = job.data;
  const labels = { transport: transport ?? "unknown", assetType: assetType ?? "unknown", verbose: !!verboseDebug };
  // Floating slot acquired separately from the dedicated pools so the
  // operator can tell at a glance whether a job ran via dedicated worker
  // (prefix probe/fast/telemetry/sysinfo) or the floating pool (floating).
  const floatingPool = slotPools?.floating ?? null;
  const workerSlot = floatingPool ? acquireWorkerSlot(floatingPool) : "floating-F?";
  const startedAt = verboseDebug ? Date.now() : 0;
  if (verboseDebug) {
    logger.info(
      { verbose: true, workerSlot, jobId: job.id, cadence, assetId, transport: labels.transport, assetType: labels.assetType, pool: "floating" },
      "monitor.worker.pickup",
    );
  }
  let outcome: "success" | "failure" = "success";
  try {
    switch (cadence) {
      case "probe":        await runProbeFor(assetId, labels);        break;
      case "fastFiltered": await runFastFilteredFor(assetId, labels); break;
      case "telemetry":    await runTelemetryFor(assetId, labels);    break;
      case "systemInfo":   await runSystemInfoFor(assetId, labels);   break;
      case "lldp":         await runLldpFor(assetId, labels);         break;
      case "storage":      await runStorageFor(assetId, labels);      break;
    }
    await boss.complete(queueName, job.id);
  } catch (err) {
    outcome = "failure";
    try {
      await boss.fail(queueName, job.id, { message: err instanceof Error ? err.message : String(err) });
    } catch (failErr) {
      logger.debug({ failErr, jobId: job.id, cadence }, "floating worker fail() reporting failed");
    }
  } finally {
    if (verboseDebug) {
      logger.info(
        { verbose: true, workerSlot, jobId: job.id, cadence, assetId, outcome, elapsedMs: Date.now() - startedAt, pool: "floating" },
        "monitor.worker.finish",
      );
    }
    if (floatingPool) releaseWorkerSlot(floatingPool, workerSlot);
  }
}

/**
 * Submit a monitor job. No-op when pg-boss isn't running (e.g. process is on
 * cursor mode, or pg-boss hasn't started yet). The `singletonKey` makes the
 * submission a coalescing operation — a duplicate for the same (assetId,
 * cadence) is silently absorbed while a prior job is queued or running, so
 * the publisher can re-evaluate due assets every tick without piling up
 * stale jobs.
 *
 * `retryLimit: 0` is deliberate: monitor cadences are stateless and the
 * next tick will re-evaluate due state anyway — better to drop a failed
 * job and pick the asset up fresh than retry against a probably-still-down
 * host with a stale snapshot. Per-queue `expireInSeconds` caps the handler
 * runtime so a wedged scrape doesn't hold a worker slot forever; see
 * EXPIRE_BY_QUEUE in startPgbossWorkers above for the per-cadence values.
 */
export async function publishMonitorJob(
  cadence: MonitorCadence,
  assetId: string,
  labels?: { transport?: string; assetType?: string; verboseDebug?: boolean },
): Promise<void> {
  if (!bossInstance) return;
  const queue = QUEUE_NAMES[cadence];
  await bossInstance.send(
    queue,
    {
      assetId,
      transport: labels?.transport,
      assetType: labels?.assetType,
      verboseDebug: labels?.verboseDebug,
    } as MonitorJobPayload,
    {
      singletonKey: `${assetId}:${cadence}`,
    },
  );
}

/**
 * Enqueue a discovery run. Returns true when the job was sent (pg-boss live),
 * false when pg-boss isn't running so the caller can fall back to in-process
 * execution (cursor-mode installs). `singletonKey: integrationId` coalesces a
 * manual trigger that races the scheduler — only one queued-or-active run per
 * integration exists at a time.
 */
export async function publishDiscoveryJob(integrationId: string, actor: string): Promise<boolean> {
  if (!bossInstance) return false;
  await bossInstance.send(
    DISCOVERY_QUEUE_NAME,
    { integrationId, actor } as DiscoveryJobPayload,
    { singletonKey: integrationId },
  );
  return true;
}

/**
 * Graceful stop. Drains in-flight jobs (up to a timeout) before resolving.
 * Called on process shutdown handlers; safe if pg-boss never started.
 */
export async function stopPgbossWorkers(): Promise<void> {
  if (!bossInstance) return;
  // Signal the floating loop to exit on its next iteration. Any in-flight
  // dispatched jobs continue under boss.stop's graceful drain below.
  floatingLoopRunning = false;
  if (metricsRefreshInterval !== null) {
    clearInterval(metricsRefreshInterval);
    metricsRefreshInterval = null;
  }
  try {
    await bossInstance.stop({ graceful: true, timeout: 30_000 });
  } catch (err) {
    logger.warn({ err }, "pg-boss stop failed");
  }
  bossInstance = null;
  monitorWorkersStarted = false;
  discoveryWorkerStarted = false;
  queuesEnsured = false;
}

export function isPgbossRunning(): boolean {
  return bossInstance !== null;
}
