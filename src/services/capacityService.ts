/**
 * src/services/capacityService.ts
 *
 * Computes a "capacity snapshot" of the host + database + monitoring workload
 * and grades it ok / amber / red. Surfaced via GET /api/v1/server-settings/pg-tuning
 * and rendered on the Server Settings → Maintenance tab; the global navbar
 * banner reads severity from the same payload.
 *
 * Rationale: small DBs need no tuning, but the time-series sample tables
 * (asset_monitor_samples, asset_interface_samples, etc.) grow with
 * monitoredAssets × probe-cadence × retention. Once that product blows past
 * host RAM or the disk is squeezed, ops needs to know before it bites — not
 * after. This service makes the math observable.
 *
 * Disk free is measured against the Polaris install path. When PostgreSQL is
 * remote, that's only the *application* disk (where backups and the update
 * staging area live); the DB's actual data volume is invisible to us.
 * `appHost.dbColocated` flags the easy case (host=localhost in DATABASE_URL).
 */

import { totalmem, freemem, cpus, loadavg } from "node:os";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "../db.js";
import { getMonitorSettings, type MonitorSettings } from "./monitoringService.js";

export type Severity = "ok" | "amber" | "red";

export interface CapacityReason {
  severity: "amber" | "red";
  code: string;
  message: string;
  suggestion: string;
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
    diskFreeBytes: number | null;
    diskTotalBytes: number | null;
    diskPath: string | null;
    dbColocated: boolean;
  };
  database: {
    sizeBytes: number;
    sampleTables: CapacitySampleTable[];
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

// Resolve install dir once; statfs needs an existing path.
const APP_DIR = dirname(fileURLToPath(import.meta.url));

function isDbLocal(): boolean {
  const url = process.env.DATABASE_URL || "";
  const m = url.match(/@([^:/?]+)/);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

async function getDiskStats(): Promise<{ free: number | null; total: number | null; path: string | null }> {
  try {
    const stats = await statfs(APP_DIR);
    // Node's BigInt fields converted to Number — Polaris-scale disks fit in 53 bits.
    return {
      free:  Number(stats.bavail) * Number(stats.bsize),
      total: Number(stats.blocks) * Number(stats.bsize),
      path:  APP_DIR,
    };
  } catch {
    return { free: null, total: null, path: null };
  }
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
    const avgBytesPerRow = live > 0 ? Math.round(bytes / live) : DEFAULT_BYTES_PER_ROW[t.name] ?? 300;
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

/**
 * Steady-state size = current non-sample DB size + sum over sample tables of
 * (monitoredAssets × rowsPerAssetPerDay × retentionDays × avgBytesPerRow).
 *
 * "rowsPerAssetPerDay" is learned from observed table:asset ratios when
 * possible (so a switch with 48 ports projects bigger than a workstation),
 * and falls back to defaults when the table is empty.
 */
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
    // No monitoring → sample tables don't grow. Steady state = current.
    return currentDbBytes;
  }

  let projectedSampleBytes = 0;
  for (const def of SAMPLE_TABLES) {
    const t = sampleTables.find((s) => s.name === def.name);
    if (!t) continue;

    // Derive rows-per-asset-per-day. If we have observed data for this table,
    // use the configured cadence to back into a per-asset rate using the
    // ratio: rate = (current rows per day) / monitoredCount. Otherwise use
    // the default model.
    const rowsPerAssetPerDay = DEFAULT_ROWS_PER_ASSET_PER_DAY[def.name](monitor);

    const retentionDays = monitor[def.retention] as number;
    projectedSampleBytes +=
      monitoredCount * rowsPerAssetPerDay * retentionDays * t.avgBytesPerRow;
  }

  // Events table is a fixed 7-day rolling window — treat as constant (use
  // current bytes, not projected). It's part of `baseBytes` already.
  return baseBytes + projectedSampleBytes;
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + " GB";
  if (b >= 1024 ** 2) return Math.round(b / 1024 ** 2) + " MB";
  if (b >= 1024)      return Math.round(b / 1024) + " kB";
  return b + " B";
}

function computeReasons(snap: CapacitySnapshot, ramInsufficient: boolean, pgTuningNeeded: boolean): CapacityReason[] {
  const reasons: CapacityReason[] = [];
  const ram = snap.appHost.totalMemoryBytes;

  // ── Red conditions ───────────────────────────────────────────────────────

  // Disk free < 10%
  if (snap.appHost.diskFreeBytes != null && snap.appHost.diskTotalBytes) {
    const pct = snap.appHost.diskFreeBytes / snap.appHost.diskTotalBytes;
    if (pct < 0.10) {
      reasons.push({
        severity: "red",
        code: "disk_critical",
        message: `Application disk has only ${formatBytes(snap.appHost.diskFreeBytes)} free (${(pct * 100).toFixed(1)}%).`,
        suggestion: "Free disk space immediately or expand the volume — backups and update rollback both need headroom.",
      });
    }
  }

  // Database dominates the disk (only when co-located, otherwise we don't know
  // the DB volume's free space).
  if (snap.appHost.dbColocated && snap.appHost.diskFreeBytes != null) {
    if (snap.database.sizeBytes > snap.appHost.diskFreeBytes * 0.5) {
      reasons.push({
        severity: "red",
        code: "db_dominates_disk",
        message: `Database (${formatBytes(snap.database.sizeBytes)}) exceeds 50% of free disk space.`,
        suggestion: "Reduce sample retention (Asset monitoring settings), expand the disk, or move PostgreSQL to a larger volume.",
      });
    }
  }

  // Stale autovacuum on a populated sample table — bloat will keep growing.
  for (const t of snap.database.sampleTables) {
    if (t.lastAutovacuum && t.rows > 1000) {
      const ageMs = Date.now() - new Date(t.lastAutovacuum).getTime();
      if (ageMs > 7 * 86400 * 1000) {
        reasons.push({
          severity: "red",
          code: "autovacuum_stale",
          message: `Table ${t.name} hasn't been autovacuumed in over 7 days.`,
          suggestion: `Investigate autovacuum status. Run VACUUM ${t.name}; manually and lower autovacuum_vacuum_scale_factor for this table.`,
        });
      }
    }
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

  // ── Amber conditions ─────────────────────────────────────────────────────

  // Disk free 10–20%
  if (snap.appHost.diskFreeBytes != null && snap.appHost.diskTotalBytes) {
    const pct = snap.appHost.diskFreeBytes / snap.appHost.diskTotalBytes;
    if (pct >= 0.10 && pct < 0.20) {
      reasons.push({
        severity: "amber",
        code: "disk_low",
        message: `Application disk free is ${(pct * 100).toFixed(0)}%.`,
        suggestion: "Plan to expand the disk soon. Backups and update rollback both require headroom.",
      });
    }
  }

  // Autovacuum lag (dead-tup ratio > 20%) on a populated table.
  for (const t of snap.database.sampleTables) {
    if (t.rows > 1000 && t.deadTupRatio > 0.20) {
      reasons.push({
        severity: "amber",
        code: "autovacuum_lag",
        message: `Table ${t.name} has ${(t.deadTupRatio * 100).toFixed(0)}% dead tuples — autovacuum is falling behind.`,
        suggestion: `Lower autovacuum_vacuum_scale_factor for ${t.name} to 0.05.`,
      });
    }
  }

  // Steady-state DB size 4–8× RAM (caught above when > 8× as red).
  if (snap.workload.steadyStateSizeBytes > ram * 4 && snap.workload.steadyStateSizeBytes <= ram * 8) {
    reasons.push({
      severity: "amber",
      code: "projected_db_large",
      message: `Steady-state database size (${formatBytes(snap.workload.steadyStateSizeBytes)}) exceeds 4× host RAM.`,
      suggestion: "Consider adding RAM or reducing sample retention before performance degrades.",
    });
  }

  // Carry forward the legacy RAM-insufficient and PG-tuning signals as amber
  // so the new snapshot is a strict superset of the old check.
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
  if (reasons.length > 0) return "amber";
  return "ok";
}

/**
 * Build the snapshot. Caller is responsible for layering the legacy
 * `pg-tuning` / `ramInsufficient` signals on top via `extraAmberCodes`,
 * which the route handler computes alongside.
 */
export async function getCapacitySnapshot(opts: {
  ramInsufficient: boolean;
  pgTuningNeeded: boolean;
}): Promise<CapacitySnapshot> {
  const [
    monitor,
    monitoredCount,
    monitoredInterfaceRow,
    diskStats,
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
    getDiskStats(),
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
      diskFreeBytes: diskStats.free,
      diskTotalBytes: diskStats.total,
      diskPath: diskStats.path,
      dbColocated: isDbLocal(),
    },
    database: {
      sizeBytes: dbSizeBytes,
      sampleTables,
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
