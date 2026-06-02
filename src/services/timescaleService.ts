/**
 * src/services/timescaleService.ts
 *
 * TimescaleDB detection and hypertable utilities. Polaris's monitoring
 * sample tables (asset_monitor_samples, asset_telemetry_samples,
 * asset_temperature_samples, asset_interface_samples, asset_storage_samples,
 * asset_ipsec_tunnel_samples) work as plain Postgres tables OR as Timescale
 * hypertables; the prune layer dispatches on hypertable status so the same
 * code path works in both modes.
 *
 * Detection runs once at startup via `detectTimescale()` and caches the
 * result + per-table hypertable status. Subsequent calls return the cached
 * value. Re-detection happens automatically after the boot-time conversion
 * pass (Step 3b) so downstream `isHypertable()` checks reflect the
 * post-conversion state.
 *
 * Detection failures are non-fatal — the cache stays at "extension not
 * available" and the prune layer falls through to the deleteMany path.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

/** Source sample tables we project / prune / hypertable. Partitioned by `timestamp`. */
export const SAMPLE_TABLES = [
  "asset_monitor_samples",
  "asset_telemetry_samples",
  "asset_temperature_samples",
  "asset_interface_samples",
  "asset_storage_samples",
  "asset_ipsec_tunnel_samples",
] as const;

/**
 * Hourly + daily rollup tables produced by sampleRollupService. Partitioned
 * by `bucketStart` (not `timestamp`). Same Timescale treatment as the source
 * tables: hypertable conversion + per-table compression with the
 * `TIMESCALE_COMPRESS_AFTER_DAYS` window.
 */
export const ROLLUP_TABLES = [
  "asset_monitor_samples_hourly",
  "asset_monitor_samples_daily",
  "asset_telemetry_samples_hourly",
  "asset_telemetry_samples_daily",
  "asset_temperature_samples_hourly",
  "asset_temperature_samples_daily",
  "asset_interface_samples_hourly",
  "asset_interface_samples_daily",
  "asset_storage_samples_hourly",
  "asset_storage_samples_daily",
  "asset_ipsec_tunnel_samples_hourly",
  "asset_ipsec_tunnel_samples_daily",
] as const;

/** Every table we manage as a hypertable — source + rollup. */
export const ALL_HYPERTABLE_CANDIDATES = [
  ...SAMPLE_TABLES,
  ...ROLLUP_TABLES,
] as const;

export type SampleTableName = typeof SAMPLE_TABLES[number];
export type RollupTableName = typeof ROLLUP_TABLES[number];
export type ManagedHypertableName = typeof ALL_HYPERTABLE_CANDIDATES[number];

interface DetectionState {
  extensionInstalled: boolean;
  hypertables: Set<string>;
  detectedAt: number;
}

let state: DetectionState = {
  extensionInstalled: false,
  hypertables: new Set(),
  detectedAt: 0,
};

/**
 * Probe Postgres for the timescaledb extension and the hypertable status of
 * every sample table. Caches the result. Idempotent — call as many times as
 * you like; the cache only updates when the probe succeeds.
 */
export async function detectTimescale(): Promise<DetectionState> {
  try {
    const ext = await prisma.$queryRawUnsafe<{ extname: string }[]>(
      `SELECT extname FROM pg_extension WHERE extname = 'timescaledb'`,
    );
    const installed = ext.length > 0;
    const hypertables = new Set<string>();
    if (installed) {
      // Hypertable inventory. `timescaledb_information.hypertables` only lists
      // tables that are currently hypertables — anything missing is plain
      // Postgres. Filter to our sample tables so we ignore unrelated user
      // hypertables (none in Polaris today, but safe to scope).
      try {
        const rows = await prisma.$queryRawUnsafe<{ hypertable_name: string }[]>(
          `SELECT hypertable_name FROM timescaledb_information.hypertables`,
        );
        for (const r of rows) {
          if ((ALL_HYPERTABLE_CANDIDATES as readonly string[]).includes(r.hypertable_name)) {
            hypertables.add(r.hypertable_name);
          }
        }
      } catch (err) {
        // Schema didn't exist yet (extension just installed but information
        // schema not visible to this role). Still set installed=true so the
        // operator-facing alert dismisses; hypertable conversion will fix it
        // on next boot once the schema is reachable.
        logger.debug({ err }, "timescaledb_information schema unreadable; treating sample tables as plain");
      }
    }
    state = { extensionInstalled: installed, hypertables, detectedAt: Date.now() };
    logger.info(
      { installed, hypertables: [...hypertables] },
      "TimescaleDB detection complete",
    );
  } catch (err) {
    logger.warn({ err }, "TimescaleDB detection failed; treating as not available");
    state = { extensionInstalled: false, hypertables: new Set(), detectedAt: Date.now() };
  }
  return state;
}

export function isTimescaleAvailable(): boolean {
  return state.extensionInstalled;
}

export function isHypertable(tableName: string): boolean {
  return state.hypertables.has(tableName);
}

export function getDetectionState(): DetectionState {
  return state;
}

/**
 * Drop chunks older than the supplied cutoff from a hypertable. No-op when
 * the table is not a hypertable; cheap to call unconditionally.
 *
 * `drop_chunks` is chunk-granular — it can only drop a chunk when ALL rows
 * in the chunk are older than the cutoff. That makes it a fast pre-filter
 * before the per-class deleteMany pass: chunks beyond the longest retention
 * disappear in O(1) without a seq-scan, then deleteMany handles the residue
 * inside the retention window.
 */
export async function dropChunks(tableName: string, olderThan: Date): Promise<void> {
  if (!isHypertable(tableName)) return;
  try {
    // Cast to `timestamp` (without time zone) — the sample tables' partitioning
    // column is Prisma `DateTime` which maps to `timestamp(3)` in Postgres, so
    // drop_chunks rejects a `timestamptz` cutoff with SQLSTATE 22023:
    // "invalid time argument type". The ISO string Date.toISOString() produces
    // is UTC; Postgres strips the trailing Z when parsing into `timestamp`, so
    // the comparison stays correct (column values are UTC by convention).
    await prisma.$executeRawUnsafe(
      `SELECT drop_chunks($1::regclass, $2::timestamp)`,
      tableName,
      olderThan.toISOString(),
    );
  } catch (err) {
    logger.warn({ err, table: tableName }, "drop_chunks failed; falling back to deleteMany");
  }
}

// Compression-window resolver for `add_compression_policy`. Operators tune
// via TIMESCALE_COMPRESS_AFTER_DAYS; default 7 keeps the 1h / 24h / 7d UI
// chart ranges on uncompressed chunks for instant query latency. 0 disables
// compression entirely (chunks stay uncompressed forever).
function resolveCompressAfterDays(): number {
  const raw = process.env.TIMESCALE_COMPRESS_AFTER_DAYS;
  if (!raw) return 7;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 7;
  return n;
}

/**
 * Convert the source sample tables AND the rollup tables to hypertables
 * (idempotent) and apply / refresh per-table compression. Runs once at boot,
 * AFTER `detectTimescale()` has populated the cache. No-op when the
 * extension is not installed.
 *
 * Per-table flow:
 *   1. If not yet a hypertable, `create_hypertable(..., migrate_data => TRUE)`
 *      with `if_not_exists => TRUE`. Existing data is reorganized into
 *      chunks during the call (brief ACCESS EXCLUSIVE lock — typically
 *      sub-second on small fleets, several minutes on huge ones).
 *   2. Enable / refresh column compression. Idempotent ALTER TABLE.
 *      `compress_segmentby = "assetId"` keeps the read pattern (filter by
 *      asset, range over time) efficient inside compressed chunks.
 *   3. Drop any existing compression policy and re-add with the current
 *      `TIMESCALE_COMPRESS_AFTER_DAYS` window — so changing the env var
 *      between boots actually takes effect.
 *
 * Source tables partition by `timestamp`; rollup tables partition by
 * `bucketStart`. The compression `orderby` clause uses the same column so
 * compressed chunks stay time-ordered for the prune layer's `drop_chunks`
 * fast path.
 *
 * Errors on any single table are logged and swallowed; the loop continues
 * on the next table. The prune layer falls back to plain-table deleteMany
 * for any table that didn't make it through.
 */
// Selection-aware source tables (interfaces / storage / ipsec) carry a mix of
// "fast" (operator-selected, full retention) and "slow"/unselected rows that
// prune trims to 24h via a per-row deleteMany. Two requirements fall out:
//   - a small (1-day) chunk interval so drop_chunks peels selected history at
//     day granularity and the slow 24h trim lands in small recent chunks;
//   - compress-after >= 2 days so the 24h deleteMany never has to touch a
//     compressed chunk (rows in compressed chunks can't be DELETEd).
const SELECTION_AWARE_SOURCE_TABLES = new Set<string>([
  "asset_interface_samples",
  "asset_storage_samples",
  "asset_ipsec_tunnel_samples",
]);
const SELECTION_AWARE_CHUNK_INTERVAL = "1 day";
const SELECTION_AWARE_MIN_COMPRESS_AFTER_DAYS = 2;

export async function migrateToHypertables(): Promise<void> {
  if (!isTimescaleAvailable()) return;
  const compressAfterDays = resolveCompressAfterDays();

  const targets: Array<{ table: string; partitionColumn: "timestamp" | "bucketStart" }> = [
    ...SAMPLE_TABLES.map((t) => ({ table: t, partitionColumn: "timestamp" as const })),
    ...ROLLUP_TABLES.map((t) => ({ table: t, partitionColumn: "bucketStart" as const })),
  ];

  for (const { table, partitionColumn } of targets) {
    try {
      const wasHypertable = isHypertable(table);
      const start = Date.now();
      const selectionAware = SELECTION_AWARE_SOURCE_TABLES.has(table);

      if (!wasHypertable) {
        logger.info({ table, partitionColumn }, "Converting sample table to hypertable");
        await prisma.$executeRawUnsafe(
          `SELECT create_hypertable($1::regclass, by_range('${partitionColumn}'), if_not_exists => TRUE, migrate_data => TRUE)`,
          table,
        );
      }

      // Smaller chunk interval for the selection-aware tables. Affects only
      // chunks created after this call — existing chunks keep their interval
      // and age out naturally. Idempotent.
      if (selectionAware) {
        await prisma.$executeRawUnsafe(
          `SELECT set_chunk_time_interval($1::regclass, INTERVAL '${SELECTION_AWARE_CHUNK_INTERVAL}')`,
          table,
        );
      }

      // Enable column compression. Setting these table options is idempotent
      // — re-running with the same values is a no-op. compress_segmentby
      // pins compressed rows by assetId so per-asset queries inside a
      // compressed chunk decompress only the relevant segment, not the whole
      // chunk. The orderby column matches the partition column so compressed
      // chunks stay time-ordered for drop_chunks pruning.
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table}" SET (timescaledb.compress = on, timescaledb.compress_segmentby = '"assetId"', timescaledb.compress_orderby = '"${partitionColumn}" DESC')`,
      );

      // Compression policy. Always remove + re-add so the operator's current
      // TIMESCALE_COMPRESS_AFTER_DAYS value is what's enforced after a boot
      // — `add_compression_policy(if_not_exists => TRUE)` would silently
      // keep the old window even if the env var changed.
      await prisma.$executeRawUnsafe(
        `SELECT remove_compression_policy($1::regclass, if_exists => TRUE)`,
        table,
      );
      // Selection-aware tables keep the recent window uncompressed long enough
      // that the unselected 24h deleteMany never hits a compressed chunk. When
      // compression is disabled globally (0), leave it disabled.
      const effectiveCompressAfter =
        selectionAware && compressAfterDays > 0
          ? Math.max(compressAfterDays, SELECTION_AWARE_MIN_COMPRESS_AFTER_DAYS)
          : compressAfterDays;
      if (effectiveCompressAfter > 0) {
        await prisma.$executeRawUnsafe(
          `SELECT add_compression_policy($1::regclass, INTERVAL '${effectiveCompressAfter} days')`,
          table,
        );
      }

      const action = wasHypertable ? "Refreshed compression on" : "Converted to hypertable:";
      logger.info(
        { table, partitionColumn, durationMs: Date.now() - start, compressAfterDays: effectiveCompressAfter, selectionAware },
        `${action} ${table}`,
      );
    } catch (err) {
      logger.error(
        { err, table, partitionColumn },
        "Hypertable migration failed for this table; falling back to plain-table prune path",
      );
    }
  }

  // Re-detect so isHypertable() reflects the post-conversion state for the
  // prune layer + the capacity snapshot.
  await detectTimescale();
}
