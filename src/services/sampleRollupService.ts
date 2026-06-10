/**
 * src/services/sampleRollupService.ts
 *
 * Rolls up the six monitor sample tables into per-hour and per-day
 * aggregates. Phase 2 of the tiered sample-retention work — writes the
 * tables phase 1 created. Nothing reads them yet (phase 4 lands the
 * tier-routing helper that picks rollup tier vs detail at query time).
 *
 * Mechanism: one custom INSERT...ON CONFLICT statement per source per
 * tier. Portable across plain Postgres and TimescaleDB — uses
 * `date_trunc('hour' | 'day', ts)` rather than Timescale's `time_bucket`
 * so a single code path covers both deployments. On Timescale boxes the
 * rollup tables can still be hypertables (see timescaleService.ts) but
 * the rollup writer doesn't depend on that.
 *
 * Counter-table handling: AssetInterfaceSample and AssetIpsecTunnelSample
 * carry cumulative counters that can wrap or reset. The rollup stores
 * `first` and `last` values per bucket plus `lastBucketSampleAt`, so the
 * read layer (phase 4) can derive rate as
 *   rate = (last - first) / (lastBucketSampleAt - bucketStart in seconds)
 * dropping negative deltas as counter resets — same convention the
 * detail-tier `/interface-history` endpoint uses today.
 *
 * Daily-from-hourly: rather than re-scanning the (potentially huge)
 * detail table for the daily bucket, the daily rollup reads from the
 * hourly tier. Aggregation: SUM for counts, weighted-avg for gauge means
 * (weighted by the underlying sampleCount), MIN/MAX for min/max, and
 * `(ARRAY_AGG(... ORDER BY bucketStart ASC))[1]` / DESC for first/last
 * counter values across the day's hourly buckets.
 *
 * Idempotent — re-running with the same lookback window UPDATEs the
 * existing buckets in place. The hourly job uses a 2-hour lookback so
 * late-arriving samples (which the buffer can flush up to 2 seconds late
 * by design — see sampleWriteBuffer.ts) still land in the right bucket
 * on the next tick. The daily job uses a 2-day lookback for the same
 * reason at a coarser cadence.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { startSampleRollupTimer } from "../metrics.js";

export type RollupTier = "hourly" | "daily";

export type SourceTable =
  | "monitor"
  | "telemetry"
  | "hardware"
  | "interface"
  | "storage"
  | "ipsec"
  | "perfSla"
  | "sdwanRule";

interface RollupDef {
  source:        SourceTable;
  /** Source table name in Postgres (snake_case). */
  detailTable:   string;
  /** Hourly rollup table name. */
  hourlyTable:   string;
  /** Daily rollup table name. */
  dailyTable:    string;
}

const DEFS: RollupDef[] = [
  { source: "monitor",     detailTable: "asset_monitor_samples",       hourlyTable: "asset_monitor_samples_hourly",       dailyTable: "asset_monitor_samples_daily"       },
  { source: "telemetry",   detailTable: "asset_telemetry_samples",     hourlyTable: "asset_telemetry_samples_hourly",     dailyTable: "asset_telemetry_samples_daily"     },
  { source: "hardware",    detailTable: "asset_hardware_sensor_samples", hourlyTable: "asset_hardware_sensor_samples_hourly", dailyTable: "asset_hardware_sensor_samples_daily" },
  { source: "interface",   detailTable: "asset_interface_samples",     hourlyTable: "asset_interface_samples_hourly",     dailyTable: "asset_interface_samples_daily"     },
  { source: "storage",     detailTable: "asset_storage_samples",       hourlyTable: "asset_storage_samples_hourly",       dailyTable: "asset_storage_samples_daily"       },
  { source: "ipsec",       detailTable: "asset_ipsec_tunnel_samples",  hourlyTable: "asset_ipsec_tunnel_samples_hourly",  dailyTable: "asset_ipsec_tunnel_samples_daily"  },
  { source: "perfSla",     detailTable: "asset_perf_sla_samples",      hourlyTable: "asset_perf_sla_samples_hourly",      dailyTable: "asset_perf_sla_samples_daily"      },
  { source: "sdwanRule",   detailTable: "asset_sdwan_rule_samples",    hourlyTable: "asset_sdwan_rule_samples_hourly",    dailyTable: "asset_sdwan_rule_samples_daily"    },
];

export interface RollupResult {
  source: SourceTable;
  tier:   RollupTier;
  /** Rows touched (inserted + updated). Drawn from `cmd_status` after the INSERT. */
  rowsTouched: number;
  durationMs:  number;
}

/**
 * Roll up every source table into its hourly tier, looking back
 * `lookbackHours` hours from now. Idempotent — runs `INSERT...ON
 * CONFLICT DO UPDATE` so re-running over the same window rewrites
 * existing buckets with fresh aggregates.
 */
export async function rollupHourly(lookbackHours = 2): Promise<RollupResult[]> {
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000);
  return runAll("hourly", since);
}

/**
 * Roll up every hourly tier into its daily tier, looking back
 * `lookbackDays` days from now. Reads from `<table>_hourly`, not from
 * the detail table — keeps the daily tick cheap even on big fleets.
 */
export async function rollupDaily(lookbackDays = 2): Promise<RollupResult[]> {
  const since = new Date(Date.now() - lookbackDays * 86400 * 1000);
  return runAll("daily", since);
}

async function runAll(tier: RollupTier, since: Date): Promise<RollupResult[]> {
  const results: RollupResult[] = [];
  for (const def of DEFS) {
    const result = await runOne(def, tier, since);
    results.push(result);
  }
  return results;
}

async function runOne(def: RollupDef, tier: RollupTier, since: Date): Promise<RollupResult> {
  const stop = startSampleRollupTimer(tier, def.source);
  const t0 = Date.now();
  let rowsTouched = 0;
  try {
    const sql = buildSql(def, tier);
    // $executeRawUnsafe returns the affected row count (INSERT + UPDATE).
    rowsTouched = await prisma.$executeRawUnsafe(sql, since);
  } catch (err) {
    logger.error(
      { err, source: def.source, tier, since: since.toISOString() },
      "Sample rollup failed for this table; continuing with the next",
    );
  } finally {
    stop();
  }
  return { source: def.source, tier, rowsTouched, durationMs: Date.now() - t0 };
}

// ─── SQL builders ────────────────────────────────────────────────────────────
//
// Each builder returns ONE parameterised statement. $1 = since timestamp.
// Bucket size is encoded as `'1 hour'` / `'1 day'` and the source table
// switches between detail (for hourly tier) and hourly (for daily tier).

function buildSql(def: RollupDef, tier: RollupTier): string {
  switch (def.source) {
    case "monitor":      return tier === "hourly" ? sqlMonitorHourly()      : sqlMonitorDaily();
    case "telemetry":    return tier === "hourly" ? sqlTelemetryHourly()    : sqlTelemetryDaily();
    case "hardware":     return tier === "hourly" ? sqlHardwareHourly()     : sqlHardwareDaily();
    case "interface":    return tier === "hourly" ? sqlInterfaceHourly()    : sqlInterfaceDaily();
    case "storage":      return tier === "hourly" ? sqlStorageHourly()      : sqlStorageDaily();
    case "ipsec":        return tier === "hourly" ? sqlIpsecHourly()        : sqlIpsecDaily();
    case "perfSla":      return tier === "hourly" ? sqlPerfSlaHourly()      : sqlPerfSlaDaily();
    case "sdwanRule":    return tier === "hourly" ? sqlSdwanRuleHourly()    : sqlSdwanRuleDaily();
  }
}

// ─── Monitor (gauge — response time) ─────────────────────────────────────────

function sqlMonitorHourly(): string {
  return `
    INSERT INTO "asset_monitor_samples_hourly" (
      "id", "assetId", "bucketStart",
      "sampleCount", "successCount", "failureCount",
      "avgResponseTimeMs", "minResponseTimeMs", "maxResponseTimeMs"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE success)::int,
      COUNT(*) FILTER (WHERE NOT success)::int,
      AVG("responseTimeMs") FILTER (WHERE success AND "responseTimeMs" IS NOT NULL),
      MIN("responseTimeMs") FILTER (WHERE success AND "responseTimeMs" IS NOT NULL),
      MAX("responseTimeMs") FILTER (WHERE success AND "responseTimeMs" IS NOT NULL)
    FROM "asset_monitor_samples"
    WHERE "timestamp" >= $1
    GROUP BY "assetId", bucket_start
    ON CONFLICT ("bucketStart", "assetId") DO UPDATE SET
      "sampleCount"       = EXCLUDED."sampleCount",
      "successCount"      = EXCLUDED."successCount",
      "failureCount"      = EXCLUDED."failureCount",
      "avgResponseTimeMs" = EXCLUDED."avgResponseTimeMs",
      "minResponseTimeMs" = EXCLUDED."minResponseTimeMs",
      "maxResponseTimeMs" = EXCLUDED."maxResponseTimeMs"
  `;
}

function sqlMonitorDaily(): string {
  // Weighted average: SUM(avgResponseTimeMs * successCount) / NULLIF(SUM(successCount), 0).
  // The successCount is the correct weight because avgResponseTimeMs was
  // computed over successes only.
  return `
    INSERT INTO "asset_monitor_samples_daily" (
      "id", "assetId", "bucketStart",
      "sampleCount", "successCount", "failureCount",
      "avgResponseTimeMs", "minResponseTimeMs", "maxResponseTimeMs"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      SUM("sampleCount")::int,
      SUM("successCount")::int,
      SUM("failureCount")::int,
      SUM("avgResponseTimeMs" * "successCount") / NULLIF(SUM("successCount"), 0),
      MIN("minResponseTimeMs"),
      MAX("maxResponseTimeMs")
    FROM "asset_monitor_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start
    ON CONFLICT ("bucketStart", "assetId") DO UPDATE SET
      "sampleCount"       = EXCLUDED."sampleCount",
      "successCount"      = EXCLUDED."successCount",
      "failureCount"      = EXCLUDED."failureCount",
      "avgResponseTimeMs" = EXCLUDED."avgResponseTimeMs",
      "minResponseTimeMs" = EXCLUDED."minResponseTimeMs",
      "maxResponseTimeMs" = EXCLUDED."maxResponseTimeMs"
  `;
}

// ─── Telemetry (gauge — CPU + memory) ────────────────────────────────────────

function sqlTelemetryHourly(): string {
  return `
    INSERT INTO "asset_telemetry_samples_hourly" (
      "id", "assetId", "bucketStart", "sampleCount",
      "avgCpuPct", "minCpuPct", "maxCpuPct",
      "avgMemPct", "minMemPct", "maxMemPct",
      "avgMemUsedBytes", "maxMemUsedBytes", "lastMemTotalBytes"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      COUNT(*)::int,
      AVG("cpuPct"), MIN("cpuPct"), MAX("cpuPct"),
      AVG("memPct"), MIN("memPct"), MAX("memPct"),
      AVG("memUsedBytes")::bigint, MAX("memUsedBytes"),
      (ARRAY_AGG("memTotalBytes" ORDER BY "timestamp" DESC) FILTER (WHERE "memTotalBytes" IS NOT NULL))[1]
    FROM "asset_telemetry_samples"
    WHERE "timestamp" >= $1
    GROUP BY "assetId", bucket_start
    ON CONFLICT ("bucketStart", "assetId") DO UPDATE SET
      "sampleCount"       = EXCLUDED."sampleCount",
      "avgCpuPct"         = EXCLUDED."avgCpuPct",
      "minCpuPct"         = EXCLUDED."minCpuPct",
      "maxCpuPct"         = EXCLUDED."maxCpuPct",
      "avgMemPct"         = EXCLUDED."avgMemPct",
      "minMemPct"         = EXCLUDED."minMemPct",
      "maxMemPct"         = EXCLUDED."maxMemPct",
      "avgMemUsedBytes"   = EXCLUDED."avgMemUsedBytes",
      "maxMemUsedBytes"   = EXCLUDED."maxMemUsedBytes",
      "lastMemTotalBytes" = EXCLUDED."lastMemTotalBytes"
  `;
}

function sqlTelemetryDaily(): string {
  // Weighted averages by sampleCount.
  return `
    INSERT INTO "asset_telemetry_samples_daily" (
      "id", "assetId", "bucketStart", "sampleCount",
      "avgCpuPct", "minCpuPct", "maxCpuPct",
      "avgMemPct", "minMemPct", "maxMemPct",
      "avgMemUsedBytes", "maxMemUsedBytes", "lastMemTotalBytes"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      SUM("sampleCount")::int,
      SUM("avgCpuPct"      * "sampleCount") / NULLIF(SUM("sampleCount"), 0),
      MIN("minCpuPct"),
      MAX("maxCpuPct"),
      SUM("avgMemPct"      * "sampleCount") / NULLIF(SUM("sampleCount"), 0),
      MIN("minMemPct"),
      MAX("maxMemPct"),
      (SUM("avgMemUsedBytes" * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      MAX("maxMemUsedBytes"),
      (ARRAY_AGG("lastMemTotalBytes" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastMemTotalBytes" IS NOT NULL))[1]
    FROM "asset_telemetry_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start
    ON CONFLICT ("bucketStart", "assetId") DO UPDATE SET
      "sampleCount"       = EXCLUDED."sampleCount",
      "avgCpuPct"         = EXCLUDED."avgCpuPct",
      "minCpuPct"         = EXCLUDED."minCpuPct",
      "maxCpuPct"         = EXCLUDED."maxCpuPct",
      "avgMemPct"         = EXCLUDED."avgMemPct",
      "minMemPct"         = EXCLUDED."minMemPct",
      "maxMemPct"         = EXCLUDED."maxMemPct",
      "avgMemUsedBytes"   = EXCLUDED."avgMemUsedBytes",
      "maxMemUsedBytes"   = EXCLUDED."maxMemUsedBytes",
      "lastMemTotalBytes" = EXCLUDED."lastMemTotalBytes"
  `;
}

// ─── Hardware sensors (gauge per sensor; mixed classes/units) ─────────────────
//
// One row per (sensor) per bucket. `value` averages within a class+unit (the
// rollup is keyed on sensorName, which is class/unit-stable within a device).
// `sensorClass` and `unit` are descriptive — carried up as the bucket's most
// recent value. `alarmStatus` is not aggregatable, so it lives only on the
// detail tier.

function sqlHardwareHourly(): string {
  return `
    INSERT INTO "asset_hardware_sensor_samples_hourly" (
      "id", "assetId", "bucketStart", "sensorName", "sensorClass", "unit",
      "sampleCount", "avgValue", "minValue", "maxValue"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "sensorName",
      (ARRAY_AGG("sensorClass" ORDER BY "timestamp" DESC))[1],
      (ARRAY_AGG("unit"        ORDER BY "timestamp" DESC) FILTER (WHERE "unit" IS NOT NULL))[1],
      COUNT(*)::int,
      AVG("value"), MIN("value"), MAX("value")
    FROM "asset_hardware_sensor_samples"
    WHERE "timestamp" >= $1
    GROUP BY "assetId", bucket_start, "sensorName"
    ON CONFLICT ("bucketStart", "assetId", "sensorName") DO UPDATE SET
      "sensorClass" = EXCLUDED."sensorClass",
      "unit"        = EXCLUDED."unit",
      "sampleCount" = EXCLUDED."sampleCount",
      "avgValue"    = EXCLUDED."avgValue",
      "minValue"    = EXCLUDED."minValue",
      "maxValue"    = EXCLUDED."maxValue"
  `;
}

function sqlHardwareDaily(): string {
  return `
    INSERT INTO "asset_hardware_sensor_samples_daily" (
      "id", "assetId", "bucketStart", "sensorName", "sensorClass", "unit",
      "sampleCount", "avgValue", "minValue", "maxValue"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "sensorName",
      (ARRAY_AGG("sensorClass" ORDER BY "bucketStart" DESC))[1],
      (ARRAY_AGG("unit"        ORDER BY "bucketStart" DESC) FILTER (WHERE "unit" IS NOT NULL))[1],
      SUM("sampleCount")::int,
      SUM("avgValue" * "sampleCount") / NULLIF(SUM("sampleCount"), 0),
      MIN("minValue"),
      MAX("maxValue")
    FROM "asset_hardware_sensor_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "sensorName"
    ON CONFLICT ("bucketStart", "assetId", "sensorName") DO UPDATE SET
      "sensorClass" = EXCLUDED."sensorClass",
      "unit"        = EXCLUDED."unit",
      "sampleCount" = EXCLUDED."sampleCount",
      "avgValue"    = EXCLUDED."avgValue",
      "minValue"    = EXCLUDED."minValue",
      "maxValue"    = EXCLUDED."maxValue"
  `;
}

// ─── Storage (gauge per mountpoint) ──────────────────────────────────────────

function sqlStorageHourly(): string {
  return `
    INSERT INTO "asset_storage_samples_hourly" (
      "id", "assetId", "bucketStart", "mountPath", "sampleCount",
      "avgUsedBytes", "minUsedBytes", "maxUsedBytes", "lastTotalBytes"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "mountPath",
      COUNT(*)::int,
      AVG("usedBytes")::bigint,
      MIN("usedBytes"),
      MAX("usedBytes"),
      (ARRAY_AGG("totalBytes" ORDER BY "timestamp" DESC) FILTER (WHERE "totalBytes" IS NOT NULL))[1]
    FROM "asset_storage_samples"
    WHERE "timestamp" >= $1 AND "cadence" = 'fast'
    GROUP BY "assetId", bucket_start, "mountPath"
    ON CONFLICT ("bucketStart", "assetId", "mountPath") DO UPDATE SET
      "sampleCount"    = EXCLUDED."sampleCount",
      "avgUsedBytes"   = EXCLUDED."avgUsedBytes",
      "minUsedBytes"   = EXCLUDED."minUsedBytes",
      "maxUsedBytes"   = EXCLUDED."maxUsedBytes",
      "lastTotalBytes" = EXCLUDED."lastTotalBytes"
  `;
}

function sqlStorageDaily(): string {
  return `
    INSERT INTO "asset_storage_samples_daily" (
      "id", "assetId", "bucketStart", "mountPath", "sampleCount",
      "avgUsedBytes", "minUsedBytes", "maxUsedBytes", "lastTotalBytes"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "mountPath",
      SUM("sampleCount")::int,
      (SUM("avgUsedBytes" * "sampleCount") / NULLIF(SUM("sampleCount"), 0))::bigint,
      MIN("minUsedBytes"),
      MAX("maxUsedBytes"),
      (ARRAY_AGG("lastTotalBytes" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastTotalBytes" IS NOT NULL))[1]
    FROM "asset_storage_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "mountPath"
    ON CONFLICT ("bucketStart", "assetId", "mountPath") DO UPDATE SET
      "sampleCount"    = EXCLUDED."sampleCount",
      "avgUsedBytes"   = EXCLUDED."avgUsedBytes",
      "minUsedBytes"   = EXCLUDED."minUsedBytes",
      "maxUsedBytes"   = EXCLUDED."maxUsedBytes",
      "lastTotalBytes" = EXCLUDED."lastTotalBytes"
  `;
}

// ─── Interface (counter — octets, errors) ────────────────────────────────────
//
// Detail samples carry cumulative counters. The rollup stores per-bucket
// first/last so the read layer can derive rate without re-scanning detail.
// Last-seen descriptor columns (status, ip, mac, alias, ...) use the most
// recent sample's value within the bucket via ARRAY_AGG ORDER BY DESC.

function sqlInterfaceHourly(): string {
  return `
    INSERT INTO "asset_interface_samples_hourly" (
      "id", "assetId", "bucketStart", "ifName", "sampleCount",
      "firstInOctets",  "lastInOctets",
      "firstOutOctets", "lastOutOctets",
      "firstInErrors",  "lastInErrors",
      "firstOutErrors", "lastOutErrors",
      "maxSpeedBps",
      "lastAdminStatus", "lastOperStatus",
      "lastIpAddress", "lastMacAddress",
      "lastAlias", "lastDescription",
      "lastIfType", "lastIfParent", "lastVlanId",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "ifName",
      COUNT(*)::int,
      (ARRAY_AGG("inOctets"  ORDER BY "timestamp" ASC)  FILTER (WHERE "inOctets"  IS NOT NULL))[1],
      (ARRAY_AGG("inOctets"  ORDER BY "timestamp" DESC) FILTER (WHERE "inOctets"  IS NOT NULL))[1],
      (ARRAY_AGG("outOctets" ORDER BY "timestamp" ASC)  FILTER (WHERE "outOctets" IS NOT NULL))[1],
      (ARRAY_AGG("outOctets" ORDER BY "timestamp" DESC) FILTER (WHERE "outOctets" IS NOT NULL))[1],
      (ARRAY_AGG("inErrors"  ORDER BY "timestamp" ASC)  FILTER (WHERE "inErrors"  IS NOT NULL))[1],
      (ARRAY_AGG("inErrors"  ORDER BY "timestamp" DESC) FILTER (WHERE "inErrors"  IS NOT NULL))[1],
      (ARRAY_AGG("outErrors" ORDER BY "timestamp" ASC)  FILTER (WHERE "outErrors" IS NOT NULL))[1],
      (ARRAY_AGG("outErrors" ORDER BY "timestamp" DESC) FILTER (WHERE "outErrors" IS NOT NULL))[1],
      MAX("speedBps"),
      (ARRAY_AGG("adminStatus" ORDER BY "timestamp" DESC) FILTER (WHERE "adminStatus" IS NOT NULL))[1],
      (ARRAY_AGG("operStatus"  ORDER BY "timestamp" DESC) FILTER (WHERE "operStatus"  IS NOT NULL))[1],
      (ARRAY_AGG("ipAddress"   ORDER BY "timestamp" DESC) FILTER (WHERE "ipAddress"   IS NOT NULL))[1],
      (ARRAY_AGG("macAddress"  ORDER BY "timestamp" DESC) FILTER (WHERE "macAddress"  IS NOT NULL))[1],
      (ARRAY_AGG("alias"       ORDER BY "timestamp" DESC) FILTER (WHERE "alias"       IS NOT NULL))[1],
      (ARRAY_AGG("description" ORDER BY "timestamp" DESC) FILTER (WHERE "description" IS NOT NULL))[1],
      (ARRAY_AGG("ifType"      ORDER BY "timestamp" DESC) FILTER (WHERE "ifType"      IS NOT NULL))[1],
      (ARRAY_AGG("ifParent"    ORDER BY "timestamp" DESC) FILTER (WHERE "ifParent"    IS NOT NULL))[1],
      (ARRAY_AGG("vlanId"      ORDER BY "timestamp" DESC) FILTER (WHERE "vlanId"      IS NOT NULL))[1],
      MAX("timestamp")
    FROM "asset_interface_samples"
    WHERE "timestamp" >= $1 AND "cadence" = 'fast'
    GROUP BY "assetId", bucket_start, "ifName"
    ON CONFLICT ("bucketStart", "assetId", "ifName") DO UPDATE SET
      "sampleCount"        = EXCLUDED."sampleCount",
      "firstInOctets"      = EXCLUDED."firstInOctets",
      "lastInOctets"       = EXCLUDED."lastInOctets",
      "firstOutOctets"     = EXCLUDED."firstOutOctets",
      "lastOutOctets"      = EXCLUDED."lastOutOctets",
      "firstInErrors"      = EXCLUDED."firstInErrors",
      "lastInErrors"       = EXCLUDED."lastInErrors",
      "firstOutErrors"     = EXCLUDED."firstOutErrors",
      "lastOutErrors"      = EXCLUDED."lastOutErrors",
      "maxSpeedBps"        = EXCLUDED."maxSpeedBps",
      "lastAdminStatus"    = EXCLUDED."lastAdminStatus",
      "lastOperStatus"     = EXCLUDED."lastOperStatus",
      "lastIpAddress"      = EXCLUDED."lastIpAddress",
      "lastMacAddress"     = EXCLUDED."lastMacAddress",
      "lastAlias"          = EXCLUDED."lastAlias",
      "lastDescription"    = EXCLUDED."lastDescription",
      "lastIfType"         = EXCLUDED."lastIfType",
      "lastIfParent"       = EXCLUDED."lastIfParent",
      "lastVlanId"         = EXCLUDED."lastVlanId",
      "lastBucketSampleAt" = EXCLUDED."lastBucketSampleAt"
  `;
}

function sqlInterfaceDaily(): string {
  return `
    INSERT INTO "asset_interface_samples_daily" (
      "id", "assetId", "bucketStart", "ifName", "sampleCount",
      "firstInOctets",  "lastInOctets",
      "firstOutOctets", "lastOutOctets",
      "firstInErrors",  "lastInErrors",
      "firstOutErrors", "lastOutErrors",
      "maxSpeedBps",
      "lastAdminStatus", "lastOperStatus",
      "lastIpAddress", "lastMacAddress",
      "lastAlias", "lastDescription",
      "lastIfType", "lastIfParent", "lastVlanId",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "ifName",
      SUM("sampleCount")::int,
      (ARRAY_AGG("firstInOctets"  ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstInOctets"  IS NOT NULL))[1],
      (ARRAY_AGG("lastInOctets"   ORDER BY "bucketStart" DESC) FILTER (WHERE "lastInOctets"   IS NOT NULL))[1],
      (ARRAY_AGG("firstOutOctets" ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstOutOctets" IS NOT NULL))[1],
      (ARRAY_AGG("lastOutOctets"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastOutOctets"  IS NOT NULL))[1],
      (ARRAY_AGG("firstInErrors"  ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstInErrors"  IS NOT NULL))[1],
      (ARRAY_AGG("lastInErrors"   ORDER BY "bucketStart" DESC) FILTER (WHERE "lastInErrors"   IS NOT NULL))[1],
      (ARRAY_AGG("firstOutErrors" ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstOutErrors" IS NOT NULL))[1],
      (ARRAY_AGG("lastOutErrors"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastOutErrors"  IS NOT NULL))[1],
      MAX("maxSpeedBps"),
      (ARRAY_AGG("lastAdminStatus" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastAdminStatus" IS NOT NULL))[1],
      (ARRAY_AGG("lastOperStatus"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastOperStatus"  IS NOT NULL))[1],
      (ARRAY_AGG("lastIpAddress"   ORDER BY "bucketStart" DESC) FILTER (WHERE "lastIpAddress"   IS NOT NULL))[1],
      (ARRAY_AGG("lastMacAddress"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastMacAddress"  IS NOT NULL))[1],
      (ARRAY_AGG("lastAlias"       ORDER BY "bucketStart" DESC) FILTER (WHERE "lastAlias"       IS NOT NULL))[1],
      (ARRAY_AGG("lastDescription" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastDescription" IS NOT NULL))[1],
      (ARRAY_AGG("lastIfType"      ORDER BY "bucketStart" DESC) FILTER (WHERE "lastIfType"      IS NOT NULL))[1],
      (ARRAY_AGG("lastIfParent"    ORDER BY "bucketStart" DESC) FILTER (WHERE "lastIfParent"    IS NOT NULL))[1],
      (ARRAY_AGG("lastVlanId"      ORDER BY "bucketStart" DESC) FILTER (WHERE "lastVlanId"      IS NOT NULL))[1],
      MAX("lastBucketSampleAt")
    FROM "asset_interface_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "ifName"
    ON CONFLICT ("bucketStart", "assetId", "ifName") DO UPDATE SET
      "sampleCount"        = EXCLUDED."sampleCount",
      "firstInOctets"      = EXCLUDED."firstInOctets",
      "lastInOctets"       = EXCLUDED."lastInOctets",
      "firstOutOctets"     = EXCLUDED."firstOutOctets",
      "lastOutOctets"      = EXCLUDED."lastOutOctets",
      "firstInErrors"      = EXCLUDED."firstInErrors",
      "lastInErrors"       = EXCLUDED."lastInErrors",
      "firstOutErrors"     = EXCLUDED."firstOutErrors",
      "lastOutErrors"      = EXCLUDED."lastOutErrors",
      "maxSpeedBps"        = EXCLUDED."maxSpeedBps",
      "lastAdminStatus"    = EXCLUDED."lastAdminStatus",
      "lastOperStatus"     = EXCLUDED."lastOperStatus",
      "lastIpAddress"      = EXCLUDED."lastIpAddress",
      "lastMacAddress"     = EXCLUDED."lastMacAddress",
      "lastAlias"          = EXCLUDED."lastAlias",
      "lastDescription"    = EXCLUDED."lastDescription",
      "lastIfType"         = EXCLUDED."lastIfType",
      "lastIfParent"       = EXCLUDED."lastIfParent",
      "lastVlanId"         = EXCLUDED."lastVlanId",
      "lastBucketSampleAt" = EXCLUDED."lastBucketSampleAt"
  `;
}

// ─── IPsec (counter — bytes; status counts) ──────────────────────────────────

function sqlIpsecHourly(): string {
  return `
    INSERT INTO "asset_ipsec_tunnel_samples_hourly" (
      "id", "assetId", "bucketStart", "tunnelName", "sampleCount",
      "statusUpCount", "statusDownCount", "statusPartialCount", "statusDynamicCount",
      "firstIncomingBytes", "lastIncomingBytes",
      "firstOutgoingBytes", "lastOutgoingBytes",
      "lastRemoteGateway", "lastParentInterface", "lastProxyIdCount",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "tunnelName",
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE status = 'up')::int,
      COUNT(*) FILTER (WHERE status = 'down')::int,
      COUNT(*) FILTER (WHERE status = 'partial')::int,
      COUNT(*) FILTER (WHERE status = 'dynamic')::int,
      (ARRAY_AGG("incomingBytes" ORDER BY "timestamp" ASC)  FILTER (WHERE "incomingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("incomingBytes" ORDER BY "timestamp" DESC) FILTER (WHERE "incomingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("outgoingBytes" ORDER BY "timestamp" ASC)  FILTER (WHERE "outgoingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("outgoingBytes" ORDER BY "timestamp" DESC) FILTER (WHERE "outgoingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("remoteGateway"   ORDER BY "timestamp" DESC) FILTER (WHERE "remoteGateway"   IS NOT NULL))[1],
      (ARRAY_AGG("parentInterface" ORDER BY "timestamp" DESC) FILTER (WHERE "parentInterface" IS NOT NULL))[1],
      (ARRAY_AGG("proxyIdCount"    ORDER BY "timestamp" DESC) FILTER (WHERE "proxyIdCount"    IS NOT NULL))[1],
      MAX("timestamp")
    FROM "asset_ipsec_tunnel_samples"
    WHERE "timestamp" >= $1 AND "cadence" = 'fast'
    GROUP BY "assetId", bucket_start, "tunnelName"
    ON CONFLICT ("bucketStart", "assetId", "tunnelName") DO UPDATE SET
      "sampleCount"         = EXCLUDED."sampleCount",
      "statusUpCount"       = EXCLUDED."statusUpCount",
      "statusDownCount"     = EXCLUDED."statusDownCount",
      "statusPartialCount"  = EXCLUDED."statusPartialCount",
      "statusDynamicCount"  = EXCLUDED."statusDynamicCount",
      "firstIncomingBytes"  = EXCLUDED."firstIncomingBytes",
      "lastIncomingBytes"   = EXCLUDED."lastIncomingBytes",
      "firstOutgoingBytes"  = EXCLUDED."firstOutgoingBytes",
      "lastOutgoingBytes"   = EXCLUDED."lastOutgoingBytes",
      "lastRemoteGateway"   = EXCLUDED."lastRemoteGateway",
      "lastParentInterface" = EXCLUDED."lastParentInterface",
      "lastProxyIdCount"    = EXCLUDED."lastProxyIdCount",
      "lastBucketSampleAt"  = EXCLUDED."lastBucketSampleAt"
  `;
}

function sqlIpsecDaily(): string {
  return `
    INSERT INTO "asset_ipsec_tunnel_samples_daily" (
      "id", "assetId", "bucketStart", "tunnelName", "sampleCount",
      "statusUpCount", "statusDownCount", "statusPartialCount", "statusDynamicCount",
      "firstIncomingBytes", "lastIncomingBytes",
      "firstOutgoingBytes", "lastOutgoingBytes",
      "lastRemoteGateway", "lastParentInterface", "lastProxyIdCount",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "tunnelName",
      SUM("sampleCount")::int,
      SUM("statusUpCount")::int,
      SUM("statusDownCount")::int,
      SUM("statusPartialCount")::int,
      SUM("statusDynamicCount")::int,
      (ARRAY_AGG("firstIncomingBytes" ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstIncomingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("lastIncomingBytes"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastIncomingBytes"  IS NOT NULL))[1],
      (ARRAY_AGG("firstOutgoingBytes" ORDER BY "bucketStart" ASC)  FILTER (WHERE "firstOutgoingBytes" IS NOT NULL))[1],
      (ARRAY_AGG("lastOutgoingBytes"  ORDER BY "bucketStart" DESC) FILTER (WHERE "lastOutgoingBytes"  IS NOT NULL))[1],
      (ARRAY_AGG("lastRemoteGateway"   ORDER BY "bucketStart" DESC) FILTER (WHERE "lastRemoteGateway"   IS NOT NULL))[1],
      (ARRAY_AGG("lastParentInterface" ORDER BY "bucketStart" DESC) FILTER (WHERE "lastParentInterface" IS NOT NULL))[1],
      (ARRAY_AGG("lastProxyIdCount"    ORDER BY "bucketStart" DESC) FILTER (WHERE "lastProxyIdCount"    IS NOT NULL))[1],
      MAX("lastBucketSampleAt")
    FROM "asset_ipsec_tunnel_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "tunnelName"
    ON CONFLICT ("bucketStart", "assetId", "tunnelName") DO UPDATE SET
      "sampleCount"         = EXCLUDED."sampleCount",
      "statusUpCount"       = EXCLUDED."statusUpCount",
      "statusDownCount"     = EXCLUDED."statusDownCount",
      "statusPartialCount"  = EXCLUDED."statusPartialCount",
      "statusDynamicCount"  = EXCLUDED."statusDynamicCount",
      "firstIncomingBytes"  = EXCLUDED."firstIncomingBytes",
      "lastIncomingBytes"   = EXCLUDED."lastIncomingBytes",
      "firstOutgoingBytes"  = EXCLUDED."firstOutgoingBytes",
      "lastOutgoingBytes"   = EXCLUDED."lastOutgoingBytes",
      "lastRemoteGateway"   = EXCLUDED."lastRemoteGateway",
      "lastParentInterface" = EXCLUDED."lastParentInterface",
      "lastProxyIdCount"    = EXCLUDED."lastProxyIdCount",
      "lastBucketSampleAt"  = EXCLUDED."lastBucketSampleAt"
  `;
}

// ─── SD-WAN Performance SLA (gauge per health-check member) ───────────────────
//
// latency/jitter/packet-loss are instantaneous gauges → averaged like
// telemetry (NOT first/last-diffed like the IPsec byte counters). Link state
// rolls up into up/down counts. Only cadence='fast' rows roll up (SD-WAN stamps
// every row "fast" — see recordSystemInfoResult).

function sqlPerfSlaHourly(): string {
  return `
    INSERT INTO "asset_perf_sla_samples_hourly" (
      "id", "assetId", "bucketStart", "healthCheck", "link", "sampleCount",
      "stateUpCount", "stateDownCount",
      "avgLatencyMs", "minLatencyMs", "maxLatencyMs",
      "avgJitterMs", "minJitterMs", "maxJitterMs",
      "avgPacketLoss", "minPacketLoss", "maxPacketLoss",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('hour', "timestamp") AS bucket_start,
      "healthCheck",
      "link",
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE state = 'up')::int,
      COUNT(*) FILTER (WHERE state = 'down')::int,
      AVG("latencyMs"), MIN("latencyMs"), MAX("latencyMs"),
      AVG("jitterMs"),  MIN("jitterMs"),  MAX("jitterMs"),
      AVG("packetLoss"), MIN("packetLoss"), MAX("packetLoss"),
      MAX("timestamp")
    FROM "asset_perf_sla_samples"
    WHERE "timestamp" >= $1 AND "cadence" = 'fast'
    GROUP BY "assetId", bucket_start, "healthCheck", "link"
    ON CONFLICT ("bucketStart", "assetId", "healthCheck", "link") DO UPDATE SET
      "sampleCount"        = EXCLUDED."sampleCount",
      "stateUpCount"       = EXCLUDED."stateUpCount",
      "stateDownCount"     = EXCLUDED."stateDownCount",
      "avgLatencyMs"       = EXCLUDED."avgLatencyMs",
      "minLatencyMs"       = EXCLUDED."minLatencyMs",
      "maxLatencyMs"       = EXCLUDED."maxLatencyMs",
      "avgJitterMs"        = EXCLUDED."avgJitterMs",
      "minJitterMs"        = EXCLUDED."minJitterMs",
      "maxJitterMs"        = EXCLUDED."maxJitterMs",
      "avgPacketLoss"      = EXCLUDED."avgPacketLoss",
      "minPacketLoss"      = EXCLUDED."minPacketLoss",
      "maxPacketLoss"      = EXCLUDED."maxPacketLoss",
      "lastBucketSampleAt" = EXCLUDED."lastBucketSampleAt"
  `;
}

function sqlPerfSlaDaily(): string {
  // Weighted averages by sampleCount (gauges); min/max carried straight up.
  return `
    INSERT INTO "asset_perf_sla_samples_daily" (
      "id", "assetId", "bucketStart", "healthCheck", "link", "sampleCount",
      "stateUpCount", "stateDownCount",
      "avgLatencyMs", "minLatencyMs", "maxLatencyMs",
      "avgJitterMs", "minJitterMs", "maxJitterMs",
      "avgPacketLoss", "minPacketLoss", "maxPacketLoss",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "healthCheck",
      "link",
      SUM("sampleCount")::int,
      SUM("stateUpCount")::int,
      SUM("stateDownCount")::int,
      SUM("avgLatencyMs"  * "sampleCount") / NULLIF(SUM("sampleCount"), 0), MIN("minLatencyMs"),  MAX("maxLatencyMs"),
      SUM("avgJitterMs"   * "sampleCount") / NULLIF(SUM("sampleCount"), 0), MIN("minJitterMs"),   MAX("maxJitterMs"),
      SUM("avgPacketLoss" * "sampleCount") / NULLIF(SUM("sampleCount"), 0), MIN("minPacketLoss"), MAX("maxPacketLoss"),
      MAX("lastBucketSampleAt")
    FROM "asset_perf_sla_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "healthCheck", "link"
    ON CONFLICT ("bucketStart", "assetId", "healthCheck", "link") DO UPDATE SET
      "sampleCount"        = EXCLUDED."sampleCount",
      "stateUpCount"       = EXCLUDED."stateUpCount",
      "stateDownCount"     = EXCLUDED."stateDownCount",
      "avgLatencyMs"       = EXCLUDED."avgLatencyMs",
      "minLatencyMs"       = EXCLUDED."minLatencyMs",
      "maxLatencyMs"       = EXCLUDED."maxLatencyMs",
      "avgJitterMs"        = EXCLUDED."avgJitterMs",
      "minJitterMs"        = EXCLUDED."minJitterMs",
      "maxJitterMs"        = EXCLUDED."maxJitterMs",
      "avgPacketLoss"      = EXCLUDED."avgPacketLoss",
      "minPacketLoss"      = EXCLUDED."minPacketLoss",
      "maxPacketLoss"      = EXCLUDED."maxPacketLoss",
      "lastBucketSampleAt" = EXCLUDED."lastBucketSampleAt"
  `;
}

// ─── SD-WAN service rules (categorical — selected member) ─────────────────────
//
// selectedMember is categorical, so there's nothing to average. The rollup
// keeps the last-seen selection (+ status/mode/availableMembers) for a coarse
// view and a `selectionChangeCount` failover metric computed via LAG over the
// per-rule timeline. The detail tier remains the authoritative failover
// timeline. selectionChangeCount is approximate at the oldest in-window bucket
// boundary (the LAG for that bucket's first sample sees no prior row inside the
// lookback window); the detail series is exact.

function sqlSdwanRuleHourly(): string {
  return `
    WITH ordered AS (
      SELECT
        "assetId", "ruleName", "timestamp",
        "selectedMember", "status", "mode", "availableMembers",
        date_trunc('hour', "timestamp") AS bucket_start,
        LAG("selectedMember") OVER (PARTITION BY "assetId", "ruleName" ORDER BY "timestamp") AS prev_member
      FROM "asset_sdwan_rule_samples"
      WHERE "timestamp" >= $1 AND "cadence" = 'fast'
    )
    INSERT INTO "asset_sdwan_rule_samples_hourly" (
      "id", "assetId", "bucketStart", "ruleName", "sampleCount",
      "statusUpCount", "statusDownCount", "selectionChangeCount",
      "lastSelectedMember", "lastStatus", "lastMode",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      bucket_start,
      "ruleName",
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE status = 'up')::int,
      COUNT(*) FILTER (WHERE status = 'down')::int,
      SUM(CASE WHEN "selectedMember" IS DISTINCT FROM prev_member AND prev_member IS NOT NULL THEN 1 ELSE 0 END)::int,
      (ARRAY_AGG("selectedMember"   ORDER BY "timestamp" DESC) FILTER (WHERE "selectedMember" IS NOT NULL))[1],
      (ARRAY_AGG("status"           ORDER BY "timestamp" DESC))[1],
      (ARRAY_AGG("mode"             ORDER BY "timestamp" DESC) FILTER (WHERE "mode" IS NOT NULL))[1],
      MAX("timestamp")
    FROM ordered
    GROUP BY "assetId", bucket_start, "ruleName"
    ON CONFLICT ("bucketStart", "assetId", "ruleName") DO UPDATE SET
      "sampleCount"          = EXCLUDED."sampleCount",
      "statusUpCount"        = EXCLUDED."statusUpCount",
      "statusDownCount"      = EXCLUDED."statusDownCount",
      "selectionChangeCount" = EXCLUDED."selectionChangeCount",
      "lastSelectedMember"   = EXCLUDED."lastSelectedMember",
      "lastStatus"           = EXCLUDED."lastStatus",
      "lastMode"             = EXCLUDED."lastMode",
      "lastBucketSampleAt"   = EXCLUDED."lastBucketSampleAt"
  `;
}

function sqlSdwanRuleDaily(): string {
  // Cross-hour failovers are already attributed to the later hourly bucket by
  // the detail-granularity LAG above, so summing hourly counts is exact.
  return `
    INSERT INTO "asset_sdwan_rule_samples_daily" (
      "id", "assetId", "bucketStart", "ruleName", "sampleCount",
      "statusUpCount", "statusDownCount", "selectionChangeCount",
      "lastSelectedMember", "lastStatus", "lastMode",
      "lastBucketSampleAt"
    )
    SELECT
      gen_random_uuid()::text,
      "assetId",
      date_trunc('day', "bucketStart") AS bucket_start,
      "ruleName",
      SUM("sampleCount")::int,
      SUM("statusUpCount")::int,
      SUM("statusDownCount")::int,
      SUM("selectionChangeCount")::int,
      (ARRAY_AGG("lastSelectedMember"   ORDER BY "bucketStart" DESC) FILTER (WHERE "lastSelectedMember" IS NOT NULL))[1],
      (ARRAY_AGG("lastStatus"           ORDER BY "bucketStart" DESC) FILTER (WHERE "lastStatus" IS NOT NULL))[1],
      (ARRAY_AGG("lastMode"             ORDER BY "bucketStart" DESC) FILTER (WHERE "lastMode" IS NOT NULL))[1],
      MAX("lastBucketSampleAt")
    FROM "asset_sdwan_rule_samples_hourly"
    WHERE "bucketStart" >= $1
    GROUP BY "assetId", bucket_start, "ruleName"
    ON CONFLICT ("bucketStart", "assetId", "ruleName") DO UPDATE SET
      "sampleCount"          = EXCLUDED."sampleCount",
      "statusUpCount"        = EXCLUDED."statusUpCount",
      "statusDownCount"      = EXCLUDED."statusDownCount",
      "selectionChangeCount" = EXCLUDED."selectionChangeCount",
      "lastSelectedMember"   = EXCLUDED."lastSelectedMember",
      "lastStatus"           = EXCLUDED."lastStatus",
      "lastMode"             = EXCLUDED."lastMode",
      "lastBucketSampleAt"   = EXCLUDED."lastBucketSampleAt"
  `;
}
