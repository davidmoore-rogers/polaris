/**
 * src/services/capacityService.ts
 *
 * Computes a "capacity snapshot" of the host + database + monitoring workload
 * and grades it ok / watch / amber / red. Surfaced via GET
 * /api/v1/server-settings/pg-tuning and rendered on the Server Settings →
 * Maintenance tab; the global navbar banner reads severity from the same
 * payload.
 *
 * Rationale: small DBs need no tuning, but the time-series sample tables
 * (asset_monitor_samples, asset_interface_samples, etc.) grow with
 * monitoredAssets × probe-cadence × retention. Once that product blows past
 * host RAM or *any* of the volumes Polaris/Postgres write to is squeezed,
 * ops needs to know before it bites — not after.
 *
 * Volumes scanned (deduped by stat.dev so single-LV installs collapse cleanly):
 *
 *   app      — install dir (where dist/ lives)
 *   state    — POLARIS_STATE_DIR root (often the same as app)
 *   backups  — encrypted DB dump destination
 *   db       — PostgreSQL `SHOW data_directory`, only when the DB is on
 *              localhost (`appHost.dbColocated` is the hint)
 *
 * Severity tiering:
 *   red    — disk free <10% on any volume, DB > 50% of free disk on its
 *            volume, autovacuum stale >7d on a populated sample table,
 *            projected size > 8× host RAM
 *   amber  — disk 10–20% on any volume, dead-tup >20%, projected > 4× RAM,
 *            legacy ramInsufficient/pgTuningNeeded signals
 *   watch  — disk 20–30% on any volume. Drives the transition Event to
 *            syslog/SFTP archival but NOT the navbar banner — gives ops a
 *            "you have weeks, not minutes" signal before amber.
 */

import { totalmem, freemem, cpus, loadavg } from "node:os";
import { statfs, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "../db.js";
import { getMonitorSettings, type MonitorSettings } from "./monitoringService.js";
import { isTimescaleAvailable, isHypertable, SAMPLE_TABLES as TIMESCALE_SAMPLE_TABLES } from "./timescaleService.js";
import { isPgbossInstalled, getBootTimeMode, getQueueMode } from "./queueService.js";
import { getDeploymentContext } from "../utils/deploymentContext.js";
import { BACKUP_DIR, STATE_DIR } from "../utils/paths.js";
import { logger } from "../utils/logger.js";

export type Severity = "ok" | "watch" | "amber" | "red";

export interface CapacityReason {
  severity: "watch" | "amber" | "red";
  code: string;
  message: string;
  suggestion: string;
}

export type VolumeRole = "app" | "state" | "backups" | "db";

export interface VolumeStat {
  /** All Polaris-named paths that resolve to this filesystem. */
  paths: string[];
  /** Roles this volume serves (deduped). Useful for the operator-facing label. */
  roles: VolumeRole[];
  freeBytes: number;
  totalBytes: number;
}

export interface CapacitySampleTable {
  name: string;
  rows: number;
  bytes: number;
  avgBytesPerRow: number;
  deadTupRatio: number;
  lastAutovacuum: string | null;
}

export interface CapacitySnapshot {
  computedAt: string;
  severity: Severity;
  reasons: CapacityReason[];
  appHost: {
    cpuCount: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    loadAvg: [number, number, number];
    /**
     * Every distinct filesystem Polaris and (when co-located) Postgres write
     * to. Pre-deduped by stat.dev so a single-LV box shows one entry, a
     * STIG-style RHEL with separate /var and /opt LVs shows two, etc.
     */
    volumes: VolumeStat[];
    dbColocated: boolean;
  };
  database: {
    sizeBytes: number;
    sampleTables: CapacitySampleTable[];
    /**
     * PostgreSQL `SHOW data_directory` value. Null when the DB is remote
     * (path is meaningless on this host) or when the SHOW failed.
     */
    dataDirectory: string | null;
    /**
     * TimescaleDB extension + per-table hypertable status. Drives the
     * `timescale_recommended` reason and is surfaced on the Maintenance tab
     * so operators can see at a glance whether their sample tables are on
     * the fast path (hypertable + chunk-drop prune + compression).
     */
    timescale: {
      extensionInstalled: boolean;
      hypertableTables: string[];
    };
    /**
     * Monitor work queue status. `pgbossInstalled` reflects whether the
     * pg-boss npm package is available at runtime; `active` is the mode
     * the running process is using (captured from Setting at boot);
     * `persisted` is the current Setting value (= what the next process
     * restart will use). When `active !== persisted`, the operator has
     * flipped the mode via the [Enable on next restart] button and a
     * restart is pending. Surfaced on the Maintenance tab Capabilities row.
     */
    queue: {
      pgbossInstalled: boolean;
      active: "cursor" | "pgboss";
      persisted: "cursor" | "pgboss";
    };
  };
  workload: {
    monitoredAssetCount: number;
    /**
     * Total operator-pinned interfaces being polled on the response-time
     * cadence — sum of `Asset.monitoredInterfaces` array lengths across every
     * monitored asset. Independent of the ~20-iface-per-asset default the
     * steady-state projection assumes for the full system-info pass; this is
     * just the fast-poll subset operators have explicitly opted into.
     */
    monitoredInterfaceCount: number;
    cadences: { responseTimeSec: number; telemetrySec: number; systemInfoSec: number };
    retention: { monitorDays: number; telemetryDays: number; systemInfoDays: number };
    /**
     * Steady-state DB size at the current cadences, retention, and monitored
     * asset count. This is what the database will grow to *if nothing changes*
     * — not a 30-day forecast. Calculated by extrapolating per-asset row rates
     * across the configured retention window for every time-series sample
     * table, then summing.
     */
    steadyStateSizeBytes: number;
  };
}

// Tables we project. Each maps to which retention setting governs it.
const SAMPLE_TABLES: Array<{ name: string; retention: keyof MonitorSettings }> = [
  { name: "asset_monitor_samples",       retention: "sampleRetentionDays"     },
  { name: "asset_telemetry_samples",     retention: "telemetryRetentionDays"  },
  { name: "asset_temperature_samples",   retention: "telemetryRetentionDays"  },
  { name: "asset_interface_samples",     retention: "systemInfoRetentionDays" },
  { name: "asset_storage_samples",       retention: "systemInfoRetentionDays" },
  { name: "asset_ipsec_tunnel_samples",  retention: "systemInfoRetentionDays" },
];

// Default rows-per-asset-per-day when we have no samples yet to learn from.
// Numbers are deliberately conservative so a fresh install with monitoring
// just turned on still gets a sensible projection.
const DEFAULT_ROWS_PER_ASSET_PER_DAY: Record<string, (m: MonitorSettings) => number> = {
  asset_monitor_samples:       (m) => 86400 / m.intervalSeconds,
  asset_telemetry_samples:     (m) => 86400 / m.telemetryIntervalSeconds,
  asset_temperature_samples:   (m) => (86400 / m.telemetryIntervalSeconds) * 4,   // ~4 sensors
  asset_interface_samples:     (m) => (86400 / m.systemInfoIntervalSeconds) * 20, // ~20 ifaces
  asset_storage_samples:       (m) => (86400 / m.systemInfoIntervalSeconds) * 3,  // ~3 mounts
  asset_ipsec_tunnel_samples:  (m) => (86400 / m.systemInfoIntervalSeconds) * 1,  // ~1 tunnel
};

// Defaults used only when a table has zero rows (so avg bytes/row is unknown).
const DEFAULT_BYTES_PER_ROW: Record<string, number> = {
  asset_monitor_samples:       310,
  asset_telemetry_samples:     325,
  asset_temperature_samples:   290,
  asset_interface_samples:     395,
  asset_storage_samples:       310,
  asset_ipsec_tunnel_samples:  390,
};

const APP_DIR = dirname(fileURLToPath(import.meta.url));

// Conventional PGDATA paths per platform. Used when `SHOW data_directory`
// fails — typically because the application's DB role is not a superuser and
// not a member of `pg_read_all_settings` (the default in a least-privilege
// install), which makes `data_directory` unreadable. Without this fallback a
// separate /var on a STIG-style RHEL layout never enters the volume scan and
// the UI shows only the app volume even when /var is the at-risk filesystem.
// Mirrors the candidate list in `src/utils/startupDiskCheck.ts`.
const PG_DATA_DIR_CANDIDATES: string[] = process.platform === "win32"
  ? [
      "C:\\Program Files\\PostgreSQL\\17\\data",
      "C:\\Program Files\\PostgreSQL\\16\\data",
      "C:\\Program Files\\PostgreSQL\\15\\data",
      "C:\\Program Files\\PostgreSQL\\14\\data",
      "C:\\Program Files\\PostgreSQL\\13\\data",
    ]
  : [
      "/var/lib/pgsql/data",
      "/var/lib/pgsql/17/data",
      "/var/lib/pgsql/16/data",
      "/var/lib/pgsql/15/data",
      "/var/lib/postgresql/17/main",
      "/var/lib/postgresql/16/main",
      "/var/lib/postgresql/15/main",
      "/var/lib/postgresql/14/main",
    ];

async function pickFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    try {
      await stat(p);
      return p;
    } catch {
      // not present, keep going
    }
  }
  return null;
}

function isDbLocal(): boolean {
  const url = process.env.DATABASE_URL || "";
  const m = url.match(/@([^:/?]+)/);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Resolve PostgreSQL's data directory. Tries `SHOW data_directory` first
 * because it's authoritative when it works; falls back to scanning the
 * platform's conventional PGDATA candidates when it doesn't (the common case
 * is a non-superuser application role lacking `pg_read_all_settings`, which
 * makes `data_directory` unreadable). Returns null when the DB is remote or
 * when no candidate path exists on disk.
 */
async function resolveDbDataDirectory(): Promise<string | null> {
  if (!isDbLocal()) return null;
  try {
    const rows = await prisma.$queryRawUnsafe<{ data_directory: string }[]>(
      "SHOW data_directory",
    );
    const path = rows[0]?.data_directory;
    if (path && path.length > 0) return path;
  } catch (err: any) {
    logger.debug({ err: err?.message }, "capacityService: SHOW data_directory failed, falling back to platform candidates");
  }
  return pickFirstExistingPath(PG_DATA_DIR_CANDIDATES);
}

/**
 * Statfs a single path. Returns null on any failure (path missing, permission
 * denied, statfs unsupported). Caller drops null entries.
 */
async function statfsPath(
  path: string,
  role: VolumeRole,
): Promise<{ role: VolumeRole; path: string; dev: number; freeBytes: number; totalBytes: number } | null> {
  try {
    const [fs, st] = await Promise.all([statfs(path), stat(path)]);
    return {
      role,
      path,
      dev: Number(st.dev),
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
    };
  } catch {
    return null;
  }
}

/**
 * Build the deduped volume list. Each candidate path is statfs'd; entries
 * sharing the same stat.dev are merged so a single-volume box reports one
 * row (with multiple roles), and a multi-LV layout reports each filesystem
 * once. Roles are preserved as a set so the UI can label "app + state + db
 * on /var" or "db alone on /var/lib/pgsql".
 */
async function getVolumes(dataDirectory: string | null): Promise<VolumeStat[]> {
  const candidates: Array<{ role: VolumeRole; path: string }> = [
    { role: "app",     path: APP_DIR    },
    { role: "state",   path: STATE_DIR  },
    { role: "backups", path: BACKUP_DIR },
  ];
  if (dataDirectory) candidates.push({ role: "db", path: dataDirectory });

  const probed = (await Promise.all(candidates.map((c) => statfsPath(c.path, c.role))))
    .filter((v): v is NonNullable<typeof v> => v !== null);

  // Dedupe by stat.dev. Roles and paths accumulate; free/total are the same
  // for every entry on the same dev so we just take the first.
  const byDev = new Map<number, VolumeStat>();
  for (const p of probed) {
    const existing = byDev.get(p.dev);
    if (existing) {
      if (!existing.roles.includes(p.role)) existing.roles.push(p.role);
      if (!existing.paths.includes(p.path)) existing.paths.push(p.path);
    } else {
      byDev.set(p.dev, {
        paths: [p.path],
        roles: [p.role],
        freeBytes: p.freeBytes,
        totalBytes: p.totalBytes,
      });
    }
  }

  // Stable order: by lowest-free-percent first, so the most-at-risk volume
  // is always the first reasons-loop sees and the first the UI renders.
  return [...byDev.values()].sort((a, b) => {
    const pctA = a.totalBytes > 0 ? a.freeBytes / a.totalBytes : 1;
    const pctB = b.totalBytes > 0 ? b.freeBytes / b.totalBytes : 1;
    return pctA - pctB;
  });
}

interface PgStatRow {
  relname: string;
  n_live_tup: bigint;
  n_dead_tup: bigint;
  bytes: bigint;
  last_autovacuum: Date | null;
}

async function getSampleTableStats(): Promise<CapacitySampleTable[]> {
  const names = SAMPLE_TABLES.map((t) => t.name);
  const rows = await prisma.$queryRawUnsafe<PgStatRow[]>(
    `SELECT
       relname,
       n_live_tup,
       n_dead_tup,
       pg_total_relation_size(quote_ident(relname)) AS bytes,
       last_autovacuum
     FROM pg_stat_user_tables
     WHERE relname = ANY($1::text[])`,
    names,
  );

  // Index by name so we can return a stable, complete list even when a table
  // isn't yet in pg_stat_user_tables (fresh install before first insert).
  const byName = new Map(rows.map((r) => [r.relname, r]));
  return SAMPLE_TABLES.map((t) => {
    const r = byName.get(t.name);
    const live = r ? Number(r.n_live_tup) : 0;
    const dead = r ? Number(r.n_dead_tup) : 0;
    const bytes = r ? Number(r.bytes) : 0;
    const total = live + dead;
    // Divide by (live + dead) so a bloated table — tiny live count, large dead
    // count from a recent aggressive prune — doesn't produce an absurd per-row
    // estimate. bytes / 8 live rows on a 180 MB table → 22 MB/row; bytes /
    // (8 + 80k dead) → ~2 kB/row, which is realistic.
    const avgBytesPerRow = total > 0 ? Math.round(bytes / total) : DEFAULT_BYTES_PER_ROW[t.name] ?? 300;
    return {
      name: t.name,
      rows: live,
      bytes,
      avgBytesPerRow,
      deadTupRatio: total > 0 ? dead / total : 0,
      lastAutovacuum: r?.last_autovacuum ? r.last_autovacuum.toISOString() : null,
    };
  });
}

function projectSteadyStateSize(args: {
  currentDbBytes: number;
  sampleTables: CapacitySampleTable[];
  monitoredCount: number;
  monitor: MonitorSettings;
}): number {
  const { currentDbBytes, sampleTables, monitoredCount, monitor } = args;

  // Subtract current sample-table bytes so we don't double-count when adding
  // the projected sample-table bytes back in.
  const sampleBytesNow = sampleTables.reduce((sum, t) => sum + t.bytes, 0);
  const baseBytes = Math.max(0, currentDbBytes - sampleBytesNow);

  if (monitoredCount === 0) {
    return currentDbBytes;
  }

  let projectedSampleBytes = 0;
  for (const def of SAMPLE_TABLES) {
    const t = sampleTables.find((s) => s.name === def.name);
    if (!t) continue;

    const rowsPerAssetPerDay = DEFAULT_ROWS_PER_ASSET_PER_DAY[def.name](monitor);
    const retentionDays = monitor[def.retention] as number;
    projectedSampleBytes +=
      monitoredCount * rowsPerAssetPerDay * retentionDays * t.avgBytesPerRow;
  }

  return baseBytes + projectedSampleBytes;
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + " GB";
  if (b >= 1024 ** 2) return Math.round(b / 1024 ** 2) + " MB";
  if (b >= 1024)      return Math.round(b / 1024) + " kB";
  return b + " B";
}

/** Friendly label for a volume — combines its roles into "app + state" etc. */
function volumeLabel(v: VolumeStat): string {
  if (v.roles.length === 1) {
    if (v.roles[0] === "db") return "Database volume";
    if (v.roles[0] === "app") return "Application volume";
    if (v.roles[0] === "state") return "State volume";
    if (v.roles[0] === "backups") return "Backups volume";
  }
  const has = (r: VolumeRole) => v.roles.includes(r);
  if (has("db") && has("app")) return "Application + DB volume";
  if (has("db")) return "DB volume";
  return "Application volume";
}

function computeReasons(
  snap: CapacitySnapshot,
  ramInsufficient: boolean,
  pgTuningNeeded: boolean,
): CapacityReason[] {
  const reasons: CapacityReason[] = [];
  const ram = snap.appHost.totalMemoryBytes;

  // ── Per-volume disk thresholds ────────────────────────────────────────────
  // Walk every distinct filesystem Polaris/Postgres write to so a small
  // separate /var (the canonical RHEL trap) is caught even when the install
  // volume is comfortable. Volumes are pre-sorted lowest-free first.
  for (const v of snap.appHost.volumes) {
    if (v.totalBytes <= 0) continue;
    const pct = v.freeBytes / v.totalBytes;
    const pathHint = v.paths[0] ? ` (${v.paths[0]})` : "";
    const label = volumeLabel(v);

    if (pct < 0.10) {
      reasons.push({
        severity: "red",
        code: "disk_critical",
        message: `${label} has only ${formatBytes(v.freeBytes)} free (${(pct * 100).toFixed(1)}%)${pathHint}.`,
        suggestion: v.roles.includes("db")
          ? "Free disk space immediately or expand the volume — PostgreSQL will refuse new writes once the volume is full."
          : "Free disk space immediately or expand the volume — backups and update rollback both need headroom.",
      });
    } else if (pct < 0.20) {
      reasons.push({
        severity: "amber",
        code: "disk_low",
        message: `${label} free is ${(pct * 100).toFixed(0)}%${pathHint}.`,
        suggestion: "Plan to expand the volume soon. Backups and update rollback both require headroom.",
      });
    } else if (pct < 0.30) {
      reasons.push({
        severity: "watch",
        code: "disk_watch",
        message: `${label} free is ${(pct * 100).toFixed(0)}%${pathHint}.`,
        suggestion: "Watch trend over the next few weeks; expand the volume before it crosses 20%.",
      });
    }
  }

  // Database dominates *its* volume (only useful when DB volume is visible).
  const dbVolume = snap.appHost.volumes.find((v) => v.roles.includes("db"));
  if (dbVolume && snap.database.sizeBytes > dbVolume.freeBytes * 0.5) {
    reasons.push({
      severity: "red",
      code: "db_dominates_disk",
      message: `Database (${formatBytes(snap.database.sizeBytes)}) exceeds 50% of free space on its volume.`,
      suggestion: "Reduce sample retention (Asset monitoring settings), expand the disk, or move PostgreSQL to a larger volume.",
    });
  }

  // Steady-state projection exceeds available disk on the DB volume. At current
  // settings the DB will fill the disk before reaching steady-state — the
  // per-volume disk-free thresholds above won't fire until it's already too late.
  if (dbVolume && snap.workload.steadyStateSizeBytes > dbVolume.freeBytes) {
    reasons.push({
      severity: "red",
      code: "projected_exceeds_disk",
      message: `Steady-state database size (${formatBytes(snap.workload.steadyStateSizeBytes)}) exceeds free space on the database volume (${formatBytes(dbVolume.freeBytes)} free).`,
      suggestion: "Reduce sample retention or monitored asset count, or expand the database volume.",
    });
  } else if (dbVolume && snap.workload.steadyStateSizeBytes > dbVolume.freeBytes * 0.75) {
    reasons.push({
      severity: "amber",
      code: "projected_exceeds_disk",
      message: `Steady-state database size (${formatBytes(snap.workload.steadyStateSizeBytes)}) will consume more than 75% of free space on the database volume (${formatBytes(dbVolume.freeBytes)} free).`,
      suggestion: "Consider reducing sample retention or expanding the database volume before it fills.",
    });
  }

  // Stale autovacuum on a populated sample table — bloat will keep growing.
  // Collapsed into a single reason listing every affected table so an install
  // with several bloated sample tables doesn't render the same advice 3-5
  // times stacked vertically.
  const staleTables = snap.database.sampleTables.filter((t) => {
    if (!t.lastAutovacuum || t.rows <= 1000) return false;
    return Date.now() - new Date(t.lastAutovacuum).getTime() > 7 * 86400 * 1000;
  });
  if (staleTables.length > 0) {
    const names = staleTables.map((t) => t.name).join(", ");
    reasons.push({
      severity: "red",
      code: "autovacuum_stale",
      message: staleTables.length === 1
        ? `Table ${names} hasn't been autovacuumed in over 7 days.`
        : `${staleTables.length} tables haven't been autovacuumed in over 7 days: ${names}.`,
      suggestion: `Investigate autovacuum status. Run VACUUM on the affected tables manually and lower autovacuum_vacuum_scale_factor to 0.05 for each.`,
    });
  }

  // Steady-state DB size > 8× host RAM — query performance will collapse.
  if (snap.workload.steadyStateSizeBytes > ram * 8) {
    reasons.push({
      severity: "red",
      code: "projected_db_huge",
      message: `Steady-state database size (${formatBytes(snap.workload.steadyStateSizeBytes)}) is more than 8× host RAM at current settings.`,
      suggestion: "Add RAM, reduce sample retention, or reduce the monitored asset count. Charts will get progressively slower.",
    });
  }

  // ── Amber: autovacuum lag ────────────────────────────────────────────────
  // Collapsed into a single reason listing every affected table with its
  // dead-tuple percentage — multiple bloated sample tables would otherwise
  // each push their own near-identical warning row.
  const laggingTables = snap.database.sampleTables.filter(
    (t) => t.rows > 1000 && t.deadTupRatio > 0.20,
  );
  if (laggingTables.length > 0) {
    const list = laggingTables
      .map((t) => `${t.name} (${(t.deadTupRatio * 100).toFixed(0)}%)`)
      .join(", ");
    reasons.push({
      severity: "amber",
      code: "autovacuum_lag",
      message: laggingTables.length === 1
        ? `Table ${list} has dead tuples building up — autovacuum is falling behind.`
        : `${laggingTables.length} tables have dead tuples building up — autovacuum is falling behind: ${list}.`,
      suggestion: `Lower autovacuum_vacuum_scale_factor to 0.05 for the affected tables.`,
    });
  }

  if (snap.workload.steadyStateSizeBytes > ram * 4 && snap.workload.steadyStateSizeBytes <= ram * 8) {
    reasons.push({
      severity: "amber",
      code: "projected_db_large",
      message: `Steady-state database size (${formatBytes(snap.workload.steadyStateSizeBytes)}) exceeds 4× host RAM.`,
      suggestion: "Consider adding RAM or reducing sample retention before performance degrades.",
    });
  }

  // ── Watch: pg-boss recommendation ────────────────────────────────────────
  // Once the monitored fleet crosses ~500 assets and the operator is still
  // on the cursor queue, advise switching to pg-boss. Below that threshold
  // cursor (post-Step-4a split-tick fix) keeps up fine; above it the in-
  // process worker pool starts contending with HTTP request handlers and
  // the publisher loses headroom for adding workers without restarting.
  // Skip when pg-boss isn't installed (no actionable advice to give).
  const PGBOSS_RECOMMEND_ASSETS = 500;
  if (
    snap.database.queue.active === "cursor" &&
    snap.database.queue.pgbossInstalled &&
    snap.workload.monitoredAssetCount > PGBOSS_RECOMMEND_ASSETS
  ) {
    const ctx = getDeploymentContext();
    const suggestion = !ctx.dbIsLocal
      ? "Click Enable on next restart to switch. pg-boss creates its own tables in the polaris database — confirm your DB role has CREATE TABLE permission with your DBA before flipping."
      : "Click Enable on next restart to switch. After the next application restart Polaris will use the pg-boss queue with per-cadence worker pools.";
    reasons.push({
      severity: "watch",
      code: "pgboss_recommended",
      message: `Monitoring ${snap.workload.monitoredAssetCount} assets on the cursor queue. pg-boss has structural per-cadence isolation that scales further.`,
      suggestion,
    });
  }

  // ── Watch: TimescaleDB recommendation ────────────────────────────────────
  // Once the sample tables together cross ~1 GB and the extension isn't
  // installed, advise the operator. Below the threshold it's not worth
  // bothering them — plain Postgres prune handles small sample tables fine.
  // Above it, partition-drop prune and compression are step-change wins
  // (10-30× storage reduction, instant chunk drops vs. seq-scan deleteMany).
  // The suggestion adapts to deployment context so the install hint matches
  // the operator's actual environment.
  const TIMESCALE_RECOMMEND_BYTES = 1024 * 1024 * 1024; // 1 GB
  const sampleTableBytes = snap.database.sampleTables.reduce((sum, t) => sum + t.bytes, 0);
  if (!snap.database.timescale.extensionInstalled && sampleTableBytes > TIMESCALE_RECOMMEND_BYTES) {
    const ctx = getDeploymentContext();
    const suggestion = !ctx.dbIsLocal
      ? "Ask your database administrator to install the timescaledb extension on the polaris database. Some managed services (RDS for Postgres) don't support it; Timescale Cloud and Azure Postgres Flexible Server do."
      : ctx.runtimeIsContainer
        ? "Switch your Postgres container to the timescale/timescaledb:latest-pg15 image. Existing data is preserved on the volume."
        : "Install TimescaleDB on this server. See docs/INSTALL.md → Recommended: TimescaleDB.";
    reasons.push({
      severity: "watch",
      code: "timescale_recommended",
      message: `Sample tables are ${formatBytes(sampleTableBytes)}. Installing TimescaleDB would compress them by ~10× and make daily prune instant.`,
      suggestion,
    });
  }

  // Carry forward the legacy RAM-insufficient and PG-tuning signals as amber.
  if (ramInsufficient) {
    reasons.push({
      severity: "amber",
      code: "ram_insufficient",
      message: `Host RAM is below the recommended minimum for the current database size.`,
      suggestion: "Add RAM to reach the recommended minimum (see the host card for the target).",
    });
  }
  if (pgTuningNeeded) {
    reasons.push({
      severity: "amber",
      code: "pg_tuning_needed",
      message: `One or more PostgreSQL settings are below the recommended minimum.`,
      suggestion: "See the PostgreSQL Tuning section below for the specific settings to adjust.",
    });
  }

  return reasons;
}

function deriveSeverity(reasons: CapacityReason[]): Severity {
  if (reasons.some((r) => r.severity === "red")) return "red";
  if (reasons.some((r) => r.severity === "amber")) return "amber";
  if (reasons.some((r) => r.severity === "watch")) return "watch";
  return "ok";
}

/**
 * Build the snapshot. Pure: reads system state but does not write any
 * Settings or Events. Use `recordCapacityTransition` if you want to fire
 * the audit-log Event on severity changes.
 */
export async function getCapacitySnapshot(opts: {
  ramInsufficient: boolean;
  pgTuningNeeded: boolean;
}): Promise<CapacitySnapshot> {
  const dataDirectory = await resolveDbDataDirectory();

  const [
    monitor,
    monitoredCount,
    monitoredInterfaceRow,
    volumes,
    dbSizeRow,
    sampleTables,
  ] = await Promise.all([
    getMonitorSettings(),
    prisma.asset.count({ where: { monitored: true } }),
    prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COALESCE(SUM(COALESCE(array_length("monitoredInterfaces", 1), 0)), 0)::bigint AS count
         FROM "assets"
        WHERE monitored = true`,
    ),
    getVolumes(dataDirectory),
    prisma.$queryRawUnsafe<{ size: bigint }[]>(
      "SELECT pg_database_size(current_database()) AS size",
    ),
    getSampleTableStats(),
  ]);

  const monitoredInterfaceCount = Number(monitoredInterfaceRow[0]?.count ?? 0);
  const dbSizeBytes = Number(dbSizeRow[0]?.size ?? 0);

  const cadences = {
    responseTimeSec: monitor.intervalSeconds,
    telemetrySec:    monitor.telemetryIntervalSeconds,
    systemInfoSec:   monitor.systemInfoIntervalSeconds,
  };
  const retention = {
    monitorDays:    monitor.sampleRetentionDays,
    telemetryDays:  monitor.telemetryRetentionDays,
    systemInfoDays: monitor.systemInfoRetentionDays,
  };

  const steadyStateSizeBytes = projectSteadyStateSize({
    currentDbBytes: dbSizeBytes,
    sampleTables,
    monitoredCount,
    monitor,
  });

  const snap: CapacitySnapshot = {
    computedAt: new Date().toISOString(),
    severity: "ok",
    reasons: [],
    appHost: {
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      loadAvg: loadavg() as [number, number, number],
      volumes,
      dbColocated: isDbLocal(),
    },
    database: {
      sizeBytes: dbSizeBytes,
      sampleTables,
      dataDirectory,
      timescale: {
        extensionInstalled: isTimescaleAvailable(),
        hypertableTables: TIMESCALE_SAMPLE_TABLES.filter((t) => isHypertable(t)),
      },
      queue: {
        pgbossInstalled: isPgbossInstalled(),
        active: getBootTimeMode(),
        persisted: await getQueueMode(),
      },
    },
    workload: {
      monitoredAssetCount: monitoredCount,
      monitoredInterfaceCount,
      cadences,
      retention,
      steadyStateSizeBytes,
    },
  };

  snap.reasons = computeReasons(snap, opts.ramInsufficient, opts.pgTuningNeeded);
  snap.severity = deriveSeverity(snap.reasons);
  return snap;
}

// ─── Transition-only Event emission ───────────────────────────────────────────
// Storing the last severity in a Setting key lets us emit an Event only when
// severity actually changes. The Event flows out through eventArchiveService
// to syslog/SFTP, so a flip into red on a busy night reaches the on-call
// channel even when the UI has already stopped responding (DB on the floor).
// The route handler and a periodic job both call this; concurrent calls are
// idempotent because we re-read the stored value inside the same flow and
// no-op when it already matches the new severity.

const SEVERITY_SETTING_KEY = "capacity.lastSeverity";

interface StoredSeverity {
  severity: Severity;
  recordedAt: string;
}

async function readStoredSeverity(): Promise<StoredSeverity | null> {
  const row = await prisma.setting.findUnique({ where: { key: SEVERITY_SETTING_KEY } });
  if (!row) return null;
  const v = row.value as Partial<StoredSeverity> | null;
  if (!v || !v.severity) return null;
  return { severity: v.severity as Severity, recordedAt: v.recordedAt ?? new Date(0).toISOString() };
}

async function writeStoredSeverity(severity: Severity): Promise<void> {
  const value: StoredSeverity = { severity, recordedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: SEVERITY_SETTING_KEY },
    update: { value: value as any },
    create: { key: SEVERITY_SETTING_KEY, value: value as any },
  });
}

function severityRank(s: Severity): number {
  if (s === "red") return 3;
  if (s === "amber") return 2;
  if (s === "watch") return 1;
  return 0;
}

function pickHeadlineReason(reasons: CapacityReason[]): CapacityReason | null {
  if (reasons.length === 0) return null;
  const ranked = [...reasons].sort((a, b) => {
    const rank = (s: CapacityReason["severity"]) =>
      s === "red" ? 3 : s === "amber" ? 2 : 1;
    return rank(b.severity) - rank(a.severity);
  });
  return ranked[0];
}

/**
 * Compare current snapshot severity against the last-stored severity and emit
 * one `capacity.severity_changed` Event if they differ. Best-effort — failures
 * are logged at debug level and never thrown so a transient DB hiccup doesn't
 * break the snapshot fetch.
 *
 * Maps severity to Event level: red → "error", amber/watch → "warning",
 * ok → "info" (recovery).
 */
export async function recordCapacityTransition(snap: CapacitySnapshot): Promise<void> {
  try {
    const prior = await readStoredSeverity();
    if (prior && prior.severity === snap.severity) return;

    const level = snap.severity === "red"
      ? "error"
      : snap.severity === "amber" || snap.severity === "watch"
      ? "warning"
      : "info";

    const direction = !prior
      ? "initial"
      : severityRank(snap.severity) > severityRank(prior.severity)
        ? "escalated"
        : "recovered";

    const headline = pickHeadlineReason(snap.reasons);
    const message = !prior
      ? `Capacity baseline established at ${snap.severity}.`
      : direction === "escalated"
        ? `Capacity ${prior.severity} → ${snap.severity}${headline ? `: ${headline.message}` : "."}`
        : `Capacity ${prior.severity} → ${snap.severity} (recovered).`;

    await prisma.event.create({
      data: {
        action: "capacity.severity_changed",
        resourceType: "system",
        actor: "system",
        level,
        message,
        details: {
          from: prior?.severity ?? null,
          to: snap.severity,
          direction,
          reasons: snap.reasons,
          volumes: snap.appHost.volumes.map((v) => ({
            paths: v.paths,
            roles: v.roles,
            freeBytes: v.freeBytes,
            totalBytes: v.totalBytes,
            freePct: v.totalBytes > 0
              ? Number(((v.freeBytes / v.totalBytes) * 100).toFixed(1))
              : null,
          })),
        } as any,
      },
    });

    await writeStoredSeverity(snap.severity);
  } catch (err: any) {
    logger.debug({ err: err?.message }, "capacityService: recordCapacityTransition failed");
  }
}
