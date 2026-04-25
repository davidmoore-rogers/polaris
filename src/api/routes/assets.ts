/**
 * src/api/routes/assets.ts — Asset management CRUD
 * GET routes are available to all authenticated users.
 * POST / PUT / DELETE require assets admin role.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requireAssetsAdmin, requireNetworkAdmin } from "../middleware/auth.js";
import { logEvent, buildChanges } from "./events.js";
import { getConfiguredResolver } from "../../services/dnsService.js";
import { lookupOui, lookupOuiOverride } from "../../services/ouiService.js";
import { clampAcquiredToLastSeen } from "../../utils/assetInvariants.js";
import { getIpHistory, getHistorySettings, updateHistorySettings, pruneOldHistory } from "../../services/assetIpHistoryService.js";
import {
  getMonitorSettings, updateMonitorSettings,
  probeAsset, recordProbeResult,
  collectTelemetry, recordTelemetryResult,
  collectSystemInfo, recordSystemInfoResult,
} from "../../services/monitoringService.js";

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const AssetTypeEnum = z.enum([
  "server", "switch", "router", "firewall",
  "workstation", "printer", "access_point", "other",
]);

const AssetStatusEnum = z.enum([
  "active", "maintenance", "decommissioned", "storage", "disabled",
]);

const macRegex = /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/;

const CreateAssetSchema = z.object({
  ipAddress:     z.string().min(1).optional(),
  macAddress:    z.string().regex(macRegex, "Invalid MAC address format (expected AA:BB:CC:DD:EE:FF)").optional(),
  hostname:      z.string().optional(),
  dnsName:       z.string().optional(),
  assetTag:      z.string().optional(),
  serialNumber:  z.string().optional(),
  manufacturer:  z.string().optional(),
  model:         z.string().optional(),
  assetType:     AssetTypeEnum.optional().default("other"),
  status:        AssetStatusEnum.optional().default("storage"),
  location:      z.string().optional(),
  department:    z.string().optional(),
  assignedTo:    z.string().optional(),
  os:            z.string().optional(),
  acquiredAt:    z.string().datetime().optional().or(z.literal("")).transform(v => v || undefined),
  warrantyExpiry:z.string().datetime().optional().or(z.literal("")).transform(v => v || undefined),
  purchaseOrder: z.string().optional(),
  notes:         z.string().optional(),
  tags:          z.array(z.string()).optional(),
});

const MonitorTypeEnum = z.enum(["fortimanager", "fortigate", "activedirectory", "snmp", "winrm", "ssh", "icmp"]);

const INTEGRATION_LOCKED_MONITOR_TYPES = ["fortimanager", "fortigate", "activedirectory"] as const;
function isIntegrationLockedType(t: string | null | undefined): boolean {
  return !!t && (INTEGRATION_LOCKED_MONITOR_TYPES as readonly string[]).includes(t);
}

const UpdateAssetSchema = CreateAssetSchema.partial().extend({
  monitored:             z.boolean().optional(),
  monitorType:           MonitorTypeEnum.nullable().optional(),
  monitorCredentialId:   z.string().uuid().nullable().optional(),
  monitorIntervalSec:    z.number().int().min(5).max(86400).nullable().optional(),
  // Per-asset cadence overrides for the System tab. Null falls back to
  // monitor.telemetryIntervalSeconds / systemInfoIntervalSeconds.
  telemetryIntervalSec:  z.number().int().min(15).max(86400).nullable().optional(),
  systemInfoIntervalSec: z.number().int().min(60).max(86400).nullable().optional(),
});

/**
 * Asserts the requested monitoring config is internally consistent.
 * Mutates `data` in place to clear conflicting columns so a stale FK
 * or stale type can't survive the save.
 */
function validateMonitorConfig(data: Record<string, unknown>, existing: { discoveredByIntegrationId?: string | null; monitorType?: string | null; monitorCredentialId?: string | null }): void {
  const monitored = data.monitored === undefined ? undefined : Boolean(data.monitored);
  const monitorType =
    data.monitorType === undefined ? existing.monitorType : (data.monitorType as string | null);
  const monitorCredentialId =
    data.monitorCredentialId === undefined
      ? existing.monitorCredentialId
      : (data.monitorCredentialId as string | null);

  // Lock monitorType for assets owned by their discovering integration —
  // FMG/FortiGate firewalls and AD-discovered Windows hosts. The UI mirrors
  // this by graying out the dropdown.
  const integrationLocked =
    !!existing.discoveredByIntegrationId && isIntegrationLockedType(existing.monitorType);
  if (integrationLocked && data.monitorType !== undefined && data.monitorType !== existing.monitorType) {
    throw new AppError(400, "Monitoring source for this asset is locked to its discovering integration");
  }

  if (monitored === false) {
    // Clear consec failures so the next enable starts clean; keep type/cred selection.
    data.consecutiveFailures = 0;
    return;
  }
  if (monitored === true || monitorType) {
    if (!monitorType) {
      throw new AppError(400, "Monitoring requires a monitor type");
    }
    if (monitorType === "snmp" || monitorType === "winrm" || monitorType === "ssh") {
      if (!monitorCredentialId) {
        throw new AppError(400, `Monitoring with ${monitorType} requires a credential`);
      }
    } else {
      // ICMP / fortinet probes don't use the credential FK; clear it.
      if (data.monitorCredentialId === undefined && existing.monitorCredentialId) {
        data.monitorCredentialId = null;
      }
    }
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/assets — list all assets (all authenticated users, paginated)
router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 10000);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const { status, assetType, department, search, createdBy } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (assetType) where.assetType = assetType;
    if (department) where.department = { contains: department, mode: "insensitive" };
    if (createdBy === "me") where.createdBy = req.session?.username ?? null;
    else if (createdBy) where.createdBy = createdBy;
    if (search) {
      where.OR = [
        { hostname:  { contains: search, mode: "insensitive" } },
        { dnsName:   { contains: search, mode: "insensitive" } },
        { ipAddress: { contains: search, mode: "insensitive" } },
        { macAddress:{ contains: search, mode: "insensitive" } },
        { assetTag:  { contains: search, mode: "insensitive" } },
        { assignedTo:{ contains: search, mode: "insensitive" } },
      ];
    }
    // Trim list payload: omit heavy fields (notes, associatedUsers) and fields
    // the list table + CSV export never reference. The single-asset GET /:id
    // below still returns the full record for the view/edit modal.
    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
        select: {
          id: true,
          hostname: true,
          dnsName: true,
          assetTag: true,
          ipAddress: true,
          macAddress: true,
          macAddresses: true,
          associatedIps: true,
          serialNumber: true,
          manufacturer: true,
          model: true,
          os: true,
          osVersion: true,
          assetType: true,
          status: true,
          statusChangedAt: true,
          statusChangedBy: true,
          location: true,
          learnedLocation: true,
          lastSeen: true,
          acquiredAt: true,
          createdAt: true,
          monitored: true,
          monitorType: true,
          monitorStatus: true,
          lastMonitorAt: true,
          lastResponseTimeMs: true,
        },
      }),
      prisma.asset.count({ where }),
    ]);
    res.json({ assets, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/ip-history-settings — get history retention settings (all authenticated users)
// Must be defined before /:id to avoid route shadowing.
router.get("/ip-history-settings", async (_req, res, next) => {
  try {
    res.json(await getHistorySettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/ip-history-settings — update retention settings (assets admin)
router.put("/ip-history-settings", requireAssetsAdmin, async (req, res, next) => {
  try {
    const { retentionDays } = z.object({ retentionDays: z.number().int().min(0).max(3650) }).parse(req.body);
    await updateHistorySettings({ retentionDays });
    const pruned = await pruneOldHistory();
    logEvent({ action: "asset.history_settings.updated", actor: req.session?.username, message: `IP history retention set to ${retentionDays} day(s)${pruned ? `; pruned ${pruned} old record(s)` : ""}` });
    res.json({ ok: true, pruned });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/monitor-settings — global monitor defaults (any authed user)
// Defined before /:id to avoid route shadowing.
router.get("/monitor-settings", async (_req, res, next) => {
  try {
    res.json(await getMonitorSettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/monitor-settings — update global monitor defaults (admin)
router.put("/monitor-settings", requireAssetsAdmin, async (req, res, next) => {
  try {
    const body = z.object({
      intervalSeconds:           z.number().int().min(5).max(86400).optional(),
      failureThreshold:          z.number().int().min(1).max(100).optional(),
      sampleRetentionDays:       z.number().int().min(0).max(3650).optional(),
      // System tab cadences. Telemetry minimum 15s (anything faster wastes
      // probes; the data only changes meaningfully every minute or so).
      // System info minimum 60s (interface scrapes are heavier).
      telemetryIntervalSeconds:  z.number().int().min(15).max(86400).optional(),
      systemInfoIntervalSeconds: z.number().int().min(60).max(86400).optional(),
      telemetryRetentionDays:    z.number().int().min(0).max(3650).optional(),
      systemInfoRetentionDays:   z.number().int().min(0).max(3650).optional(),
    }).parse(req.body);
    const next = await updateMonitorSettings(body);
    logEvent({
      action: "monitor.settings.updated",
      actor: req.session?.username,
      message: `Monitor settings updated (probe ${next.intervalSeconds}s/threshold ${next.failureThreshold}/retain ${next.sampleRetentionDays}d, telemetry ${next.telemetryIntervalSeconds}s/retain ${next.telemetryRetentionDays}d, sysinfo ${next.systemInfoIntervalSeconds}s/retain ${next.systemInfoRetentionDays}d)`,
    });
    res.json(next);
  } catch (err) { next(err); }
});

// POST /api/v1/assets/bulk-monitor — enable/disable monitoring on a set of assets.
// Body: { ids, monitored, monitorType?, monitorCredentialId?, monitorIntervalSec? }.
// On enable: applies the same monitorType + credential to every selected asset
// (assets locked to a discovering integration — FMG/FortiGate firewalls, AD-discovered
// Windows hosts — keep their integration-locked type; request type is ignored for those
// rows). Returns per-id error list for any rejected rows.
router.post("/bulk-monitor", requireAssetsAdmin, async (req, res, next) => {
  try {
    const body = z.object({
      ids:                 z.array(z.string().uuid()).min(1),
      monitored:           z.boolean(),
      monitorType:         MonitorTypeEnum.nullable().optional(),
      monitorCredentialId: z.string().uuid().nullable().optional(),
      monitorIntervalSec:  z.number().int().min(5).max(86400).nullable().optional(),
    }).parse(req.body);

    const assets = await prisma.asset.findMany({
      where: { id: { in: body.ids } },
      select: { id: true, hostname: true, discoveredByIntegrationId: true, monitorType: true, monitorCredentialId: true },
    });
    const byId = new Map(assets.map((a) => [a.id, a]));
    const updated: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const id of body.ids) {
      const a = byId.get(id);
      if (!a) { errors.push({ id, error: "Asset not found" }); continue; }
      const data: Record<string, unknown> = { monitored: body.monitored };
      const integrationLocked =
        !!a.discoveredByIntegrationId && isIntegrationLockedType(a.monitorType);
      if (!integrationLocked && body.monitorType !== undefined) data.monitorType = body.monitorType;
      if (body.monitorCredentialId !== undefined) data.monitorCredentialId = body.monitorCredentialId;
      if (body.monitorIntervalSec !== undefined) data.monitorIntervalSec = body.monitorIntervalSec;
      try {
        validateMonitorConfig(data, a);
        await prisma.asset.update({ where: { id }, data: data as any });
        updated.push(id);
      } catch (err: any) {
        errors.push({ id, error: err?.message || "Update failed" });
      }
    }

    logEvent({
      action: body.monitored ? "monitor.bulk_enabled" : "monitor.bulk_disabled",
      resourceType: "asset",
      actor: req.session?.username,
      message: `Bulk ${body.monitored ? "enabled" : "disabled"} monitoring on ${updated.length} asset(s)` + (errors.length ? `; ${errors.length} error(s)` : ""),
      details: errors.length ? { errors } : undefined,
    });
    res.json({ updated: updated.length, errors });
  } catch (err) { next(err); }
});

// GET /api/v1/assets/:id — get single asset (all authenticated users)
router.get("/:id", async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: req.params.id as string },
      include: {
        discoveredByIntegration: { select: { id: true, name: true, type: true } },
        monitorCredential:       { select: { id: true, name: true, type: true } },
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    res.json(asset);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/ip-history — IP address history for an asset (all authenticated users)
router.get("/:id/ip-history", async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string }, select: { id: true } });
    if (!asset) throw new AppError(404, "Asset not found");
    res.json(await getIpHistory(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/monitor-history?range=1h|24h|7d|30d OR ?from=ISO&to=ISO
router.get("/:id/monitor-history", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const fromQ = req.query.from ? String(req.query.from) : null;
    const toQ   = req.query.to   ? String(req.query.to)   : null;
    let since: Date;
    let until: Date;
    let rangeLabel: string;
    if (fromQ && toQ) {
      const f = new Date(fromQ), t = new Date(toQ);
      if (isNaN(+f) || isNaN(+t)) throw new AppError(400, "Invalid from/to date");
      if (+f >= +t) throw new AppError(400, "from must be before to");
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      if (+t - +f > oneYearMs) throw new AppError(400, "Custom range cannot exceed 1 year");
      since = f;
      until = t;
      rangeLabel = "custom";
    } else {
      const range = String(req.query.range || "24h");
      const windowMs =
        range === "1h"  ?  1 * 60 * 60 * 1000 :
        range === "7d"  ?  7 * 24 * 60 * 60 * 1000 :
        range === "30d" ? 30 * 24 * 60 * 60 * 1000 :
                            24 * 60 * 60 * 1000;
      until = new Date();
      since = new Date(+until - windowMs);
      rangeLabel = range;
    }
    const samples = await prisma.assetMonitorSample.findMany({
      where: { assetId: id, timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, success: true, responseTimeMs: true, error: true },
    });
    const total = samples.length;
    const failed = samples.filter((s) => !s.success).length;
    const okSamples = samples.filter((s) => s.success && typeof s.responseTimeMs === "number").map((s) => s.responseTimeMs as number);
    const avgMs = okSamples.length ? Math.round(okSamples.reduce((a, b) => a + b, 0) / okSamples.length) : null;
    const minMs = okSamples.length ? Math.min(...okSamples) : null;
    const maxMs = okSamples.length ? Math.max(...okSamples) : null;
    res.json({
      range: rangeLabel,
      since,
      until,
      samples,
      stats: {
        total,
        failed,
        successRate: total ? (total - failed) / total : null,
        packetLossRate: total ? failed / total : null,
        avgMs, minMs, maxMs,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/:id/probe-now — run a one-off probe immediately (assets admin).
// Triggers all three cadences (response-time, telemetry, system info) so the
// asset details panel refreshes everything at once instead of waiting for the
// scheduler to come around.
router.post("/:id/probe-now", requireAssetsAdmin, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const result = await probeAsset(id);
    await recordProbeResult(id, result);
    // Telemetry + system info on best-effort — failures don't fail the probe.
    try {
      const tr = await collectTelemetry(id);
      await recordTelemetryResult(id, tr);
    } catch { /* ignore */ }
    try {
      const sr = await collectSystemInfo(id);
      await recordSystemInfoResult(id, sr);
    } catch { /* ignore */ }
    res.json(result);
  } catch (err) { next(err); }
});

// ─── System tab endpoints ──────────────────────────────────────────────────
//
// Telemetry, interface, and storage histories live on /assets/:id/... and
// share the same range/from-to query semantics as /monitor-history. BigInt
// columns are coerced to Number on the way out — interface octets up to
// 2^53-1 (≈9 PB) fit safely.

const RANGE_MS: Record<string, number> = {
  "1h":  1 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d":  7  * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function resolveRange(req: any): { since: Date; until: Date; rangeLabel: string } {
  const fromQ = req.query.from ? String(req.query.from) : null;
  const toQ   = req.query.to   ? String(req.query.to)   : null;
  if (fromQ && toQ) {
    const f = new Date(fromQ), t = new Date(toQ);
    if (isNaN(+f) || isNaN(+t)) throw new AppError(400, "Invalid from/to date");
    if (+f >= +t) throw new AppError(400, "from must be before to");
    if (+t - +f > 365 * 24 * 60 * 60 * 1000) throw new AppError(400, "Custom range cannot exceed 1 year");
    return { since: f, until: t, rangeLabel: "custom" };
  }
  const range = String(req.query.range || "24h");
  const windowMs = RANGE_MS[range] ?? RANGE_MS["24h"];
  const until = new Date();
  return { since: new Date(+until - windowMs), until, rangeLabel: range };
}

function bigIntToNumber(v: bigint | null | undefined): number | null {
  if (v == null) return null;
  return Number(v);
}

// GET /assets/:id/telemetry-history?range=...|from=...&to=... — CPU+memory time series
router.get("/:id/telemetry-history", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { since, until, rangeLabel } = resolveRange(req);
    const samples = await prisma.assetTelemetrySample.findMany({
      where: { assetId: id, timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, cpuPct: true, memPct: true, memUsedBytes: true, memTotalBytes: true },
    });
    const rows = samples.map((s) => ({
      timestamp:     s.timestamp,
      cpuPct:        s.cpuPct,
      memPct:        s.memPct,
      memUsedBytes:  bigIntToNumber(s.memUsedBytes),
      memTotalBytes: bigIntToNumber(s.memTotalBytes),
    }));
    const cpus = rows.map((r) => r.cpuPct).filter((x): x is number => typeof x === "number");
    const mems = rows.map((r) => r.memPct ?? (r.memTotalBytes && r.memUsedBytes ? (r.memUsedBytes / r.memTotalBytes) * 100 : null))
                     .filter((x): x is number => typeof x === "number");
    res.json({
      range: rangeLabel,
      since,
      until,
      samples: rows,
      stats: {
        total:     rows.length,
        avgCpuPct: cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null,
        maxCpuPct: cpus.length ? Math.max(...cpus) : null,
        avgMemPct: mems.length ? mems.reduce((a, b) => a + b, 0) / mems.length : null,
        maxMemPct: mems.length ? Math.max(...mems) : null,
      },
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/system-info — latest interface + storage snapshot. Returns
// every interface row tied to the most-recent system-info scrape timestamp,
// plus the most-recent telemetry row. Used to populate the System tab grid
// without requiring the client to make three separate calls.
router.get("/:id/system-info", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, monitored: true, monitorType: true, lastTelemetryAt: true, lastSystemInfoAt: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    const [latestTelemetry, latestIfaceMeta, latestStorageMeta] = await Promise.all([
      prisma.assetTelemetrySample.findFirst({
        where: { assetId: id },
        orderBy: { timestamp: "desc" },
      }),
      prisma.assetInterfaceSample.findFirst({
        where: { assetId: id },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
      prisma.assetStorageSample.findFirst({
        where: { assetId: id },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
    ]);

    const interfaces = latestIfaceMeta
      ? await prisma.assetInterfaceSample.findMany({
          where: { assetId: id, timestamp: latestIfaceMeta.timestamp },
          orderBy: { ifName: "asc" },
        })
      : [];
    const storage = latestStorageMeta
      ? await prisma.assetStorageSample.findMany({
          where: { assetId: id, timestamp: latestStorageMeta.timestamp },
          orderBy: { mountPath: "asc" },
        })
      : [];

    res.json({
      monitored: asset.monitored,
      monitorType: asset.monitorType,
      lastTelemetryAt: asset.lastTelemetryAt,
      lastSystemInfoAt: asset.lastSystemInfoAt,
      telemetry: latestTelemetry ? {
        timestamp:     latestTelemetry.timestamp,
        cpuPct:        latestTelemetry.cpuPct,
        memPct:        latestTelemetry.memPct,
        memUsedBytes:  bigIntToNumber(latestTelemetry.memUsedBytes),
        memTotalBytes: bigIntToNumber(latestTelemetry.memTotalBytes),
      } : null,
      interfaces: interfaces.map((i) => ({
        timestamp:   i.timestamp,
        ifName:      i.ifName,
        adminStatus: i.adminStatus,
        operStatus:  i.operStatus,
        speedBps:    bigIntToNumber(i.speedBps),
        ipAddress:   i.ipAddress,
        macAddress:  i.macAddress,
        inOctets:    bigIntToNumber(i.inOctets),
        outOctets:   bigIntToNumber(i.outOctets),
      })),
      storage: storage.map((s) => ({
        timestamp:  s.timestamp,
        mountPath:  s.mountPath,
        totalBytes: bigIntToNumber(s.totalBytes),
        usedBytes:  bigIntToNumber(s.usedBytes),
      })),
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/interface-history?ifName=...&range=... — per-interface counters
router.get("/:id/interface-history", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const ifName = req.query.ifName ? String(req.query.ifName) : null;
    if (!ifName) throw new AppError(400, "ifName query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const samples = await prisma.assetInterfaceSample.findMany({
      where: { assetId: id, ifName, timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    res.json({
      range: rangeLabel,
      ifName,
      since,
      until,
      samples: samples.map((s) => ({
        timestamp:   s.timestamp,
        adminStatus: s.adminStatus,
        operStatus:  s.operStatus,
        speedBps:    bigIntToNumber(s.speedBps),
        ipAddress:   s.ipAddress,
        macAddress:  s.macAddress,
        inOctets:    bigIntToNumber(s.inOctets),
        outOctets:   bigIntToNumber(s.outOctets),
      })),
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/storage-history?mountPath=...&range=... — per-mountpoint usage
router.get("/:id/storage-history", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const mountPath = req.query.mountPath ? String(req.query.mountPath) : null;
    if (!mountPath) throw new AppError(400, "mountPath query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const samples = await prisma.assetStorageSample.findMany({
      where: { assetId: id, mountPath, timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    res.json({
      range: rangeLabel,
      mountPath,
      since,
      until,
      samples: samples.map((s) => ({
        timestamp:  s.timestamp,
        totalBytes: bigIntToNumber(s.totalBytes),
        usedBytes:  bigIntToNumber(s.usedBytes),
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets — create (assets admin)
router.post("/", requireAssetsAdmin, async (req, res, next) => {
  try {
    const input = CreateAssetSchema.parse(req.body);
    const data: Record<string, unknown> = { ...input };
    if (input.macAddress) data.macAddress = input.macAddress.toUpperCase().replace(/-/g, ":");
    if (input.acquiredAt) data.acquiredAt = new Date(input.acquiredAt);
    if (input.warrantyExpiry) data.warrantyExpiry = new Date(input.warrantyExpiry);
    if (input.ipAddress) data.ipSource = "manual";
    // Always stamp status tracking on creation (status is always set here)
    data.statusChangedAt = new Date();
    data.statusChangedBy = req.session?.username ?? "manual";
    data.createdBy = req.session?.username ?? null;
    clampAcquiredToLastSeen(data);
    const asset = await prisma.asset.create({ data: data as any });
    logEvent({ action: "asset.created", resourceType: "asset", resourceId: asset.id, resourceName: input.hostname || input.ipAddress, actor: req.session?.username, message: `Asset "${input.hostname || input.ipAddress || "unknown"}" created` });
    res.status(201).json(asset);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/:id — update (assets admin)
router.put("/:id", requireAssetsAdmin, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.asset.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Asset not found");
    const input = UpdateAssetSchema.parse(req.body);
    const data: Record<string, unknown> = { ...input };
    if (input.macAddress) data.macAddress = input.macAddress.toUpperCase().replace(/-/g, ":");
    if (input.acquiredAt) data.acquiredAt = new Date(input.acquiredAt);
    else if (input.acquiredAt === undefined) delete data.acquiredAt;
    if (input.warrantyExpiry) data.warrantyExpiry = new Date(input.warrantyExpiry);
    else if (input.warrantyExpiry === undefined) delete data.warrantyExpiry;
    if (input.ipAddress) data.ipSource = "manual";
    if (input.status !== undefined) {
      data.statusChangedAt = new Date();
      data.statusChangedBy = req.session?.username ?? "manual";
    }
    validateMonitorConfig(data, existing);
    clampAcquiredToLastSeen(data, existing);
    const asset = await prisma.asset.update({ where: { id }, data: data as any });
    const trackFields = ["hostname", "ipAddress", "macAddress", "manufacturer", "model", "serialNumber", "assetType", "status", "location", "notes", "dnsName"] as const;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const f of trackFields) { before[f] = (existing as any)[f]; after[f] = (asset as any)[f]; }
    const changes = buildChanges(before, after);
    logEvent({ action: "asset.updated", resourceType: "asset", resourceId: id, resourceName: asset.hostname || asset.ipAddress || undefined, actor: req.session?.username, message: `Asset "${asset.hostname || asset.ipAddress || "unknown"}" updated`, details: changes ? { changes } : undefined });
    res.json(asset);
  } catch (err) {
    next(err);
  }
});

// Fallback TTL (seconds) when the resolver can't return one (standard mode).
// Used for both positive results and negative caching (no PTR record found).
const DEFAULT_PTR_TTL_S = 3600;

function isPtrExpired(fetchedAt: Date | string | null | undefined, ttlSeconds: number | null | undefined, now: number): boolean {
  if (!fetchedAt) return true;
  const fetched = typeof fetchedAt === "string" ? new Date(fetchedAt).getTime() : (fetchedAt as Date).getTime();
  const ttlMs = (ttlSeconds ?? DEFAULT_PTR_TTL_S) * 1000;
  return (now - fetched) > ttlMs;
}

// POST /api/v1/assets/dns-lookup — bulk PTR lookup; skips IPs whose cached result is within TTL
router.post("/dns-lookup", requireAssetsAdmin, async (req, res, next) => {
  try {
    const now = Date.now();
    const resolver = await getConfiguredResolver();

    // ── Primary IPs ──────────────────────────────────────────────────────────
    const primaryAssets = await prisma.asset.findMany({
      where: { ipAddress: { not: null }, status: { notIn: ["decommissioned", "disabled"] } },
      select: { id: true, ipAddress: true, hostname: true, dnsName: true, dnsNameFetchedAt: true, dnsNameTtl: true },
    });

    // Only query IPs whose cached PTR has expired (or was never fetched)
    const needsPrimary = primaryAssets.filter((a) => isPtrExpired(a.dnsNameFetchedAt, a.dnsNameTtl, now));
    let skippedPrimary = primaryAssets.length - needsPrimary.length;

    let resolved = 0;
    let failed = 0;
    const results: Array<{ id: string; ip: string; dnsName: string }> = [];

    for (const asset of needsPrimary) {
      if (!asset.ipAddress) continue;
      const fetchedAt = new Date();
      try {
        const records = await resolver.reverse(asset.ipAddress);
        if (records.length > 0) {
          const { name: dnsName, ttl } = records[0];
          await prisma.asset.update({ where: { id: asset.id }, data: { dnsName, dnsNameFetchedAt: fetchedAt, dnsNameTtl: ttl } });
          results.push({ id: asset.id, ip: asset.ipAddress, dnsName });
          resolved++;
        } else {
          // Negative cache: record the attempt so we don't retry until TTL expires
          await prisma.asset.update({ where: { id: asset.id }, data: { dnsNameFetchedAt: fetchedAt, dnsNameTtl: null } });
          failed++;
        }
      } catch {
        await prisma.asset.update({ where: { id: asset.id }, data: { dnsNameFetchedAt: fetchedAt, dnsNameTtl: null } });
        failed++;
      }
    }

    // ── Associated IPs ───────────────────────────────────────────────────────
    const assocAssets = await prisma.asset.findMany({
      where: { status: { notIn: ["decommissioned", "disabled"] } },
      select: { id: true, associatedIps: true },
    });

    let assocResolved = 0;
    let assocSkipped = 0;
    for (const asset of assocAssets) {
      const entries: any[] = Array.isArray(asset.associatedIps) ? (asset.associatedIps as any[]) : [];
      if (entries.length === 0) continue;

      let changed = false;
      const updated = await Promise.all(entries.map(async (entry: any) => {
        if (!entry.ip) return entry;
        if (!isPtrExpired(entry.ptrFetchedAt, entry.ptrTtl, now)) { assocSkipped++; return entry; }
        const ptrFetchedAt = new Date().toISOString();
        try {
          const records = await resolver.reverse(entry.ip);
          if (records.length > 0) {
            assocResolved++;
            changed = true;
            return { ...entry, ptrName: records[0].name, ptrTtl: records[0].ttl, ptrFetchedAt };
          }
        } catch {}
        // Negative cache
        changed = true;
        return { ...entry, ptrName: entry.ptrName ?? null, ptrTtl: null, ptrFetchedAt };
      }));

      if (changed) {
        await prisma.asset.update({ where: { id: asset.id }, data: { associatedIps: updated } });
      }
    }

    logEvent({
      action: "asset.dns.bulk", resourceType: "asset", actor: req.session?.username,
      message: `Bulk DNS lookup: ${resolved} resolved, ${failed} failed, ${skippedPrimary} skipped (TTL); ${assocResolved} associated IP PTR(s) resolved, ${assocSkipped} skipped`,
    });
    res.json({ total: needsPrimary.length, skipped: skippedPrimary, resolved, failed, assocResolved, assocSkipped, results });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/dns-lookup — PTR lookup for a single asset; always queries (user-triggered)
router.post("/:id/dns-lookup", requireAssetsAdmin, async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string } });
    if (!asset) throw new AppError(404, "Asset not found");

    const assocIps: any[] = Array.isArray(asset.associatedIps) ? (asset.associatedIps as any[]) : [];
    if (!asset.ipAddress && assocIps.length === 0) throw new AppError(400, "Asset has no IP address");

    const resolver = await getConfiguredResolver();
    let dnsName: string | null = asset.dnsName;
    let dnsNameTtl: number | null = null;
    const fetchedAt = new Date();

    if (asset.ipAddress) {
      try {
        const records = await resolver.reverse(asset.ipAddress);
        if (records.length > 0) { dnsName = records[0].name; dnsNameTtl = records[0].ttl; }
        else dnsName = null;
      } catch {
        dnsName = null;
      }
    }

    // PTR for each associated IP — always re-query on single-asset lookup
    let assocResolved = 0;
    const updatedAssocIps = await Promise.all(assocIps.map(async (entry: any) => {
      if (!entry.ip) return entry;
      const ptrFetchedAt = new Date().toISOString();
      try {
        const records = await resolver.reverse(entry.ip);
        if (records.length > 0) {
          assocResolved++;
          return { ...entry, ptrName: records[0].name, ptrTtl: records[0].ttl, ptrFetchedAt };
        }
      } catch {}
      return { ...entry, ptrName: entry.ptrName ?? null, ptrTtl: null, ptrFetchedAt };
    }));

    const updateData: Record<string, unknown> = {
      dnsName,
      dnsNameFetchedAt: fetchedAt,
      dnsNameTtl,
      associatedIps: updatedAssocIps,
    };
    await prisma.asset.update({ where: { id: asset.id }, data: updateData });

    if (!dnsName && assocResolved === 0) {
      const testedIp = asset.ipAddress || assocIps[0]?.ip;
      return res.json({ ok: false, message: `No PTR records found for ${testedIp}${assocIps.length > 1 ? " or its associated IPs" : ""}` });
    }

    const parts: string[] = [];
    if (dnsName) parts.push(`${asset.ipAddress} → ${dnsName}${dnsNameTtl != null ? ` (TTL ${dnsNameTtl}s)` : ""}`);
    if (assocResolved > 0) parts.push(`${assocResolved} associated IP PTR(s) resolved`);
    const message = parts.join("; ");

    logEvent({ action: "asset.dns.resolved", resourceType: "asset", resourceId: asset.id, resourceName: asset.hostname || asset.ipAddress || undefined, actor: req.session?.username, message: `DNS resolved: ${message}` });
    res.json({ ok: true, dnsName, dnsNameTtl, assocResolved, message });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/forward-lookup — A/AAAA lookup from hostname/dnsName → fills ipAddress
router.post("/:id/forward-lookup", requireAssetsAdmin, async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string } });
    if (!asset) throw new AppError(404, "Asset not found");
    if (asset.ipAddress) throw new AppError(400, "Asset already has an IP address");
    const lookupName = asset.dnsName || asset.hostname;
    if (!lookupName) throw new AppError(400, "Asset has no hostname or DNS name to look up");

    const resolver = await getConfiguredResolver();
    const start = Date.now();
    const records = await resolver.lookup(lookupName);
    const elapsed = Date.now() - start;

    if (records.length === 0) {
      return res.json({ ok: false, message: `No A/AAAA records found for ${lookupName}` });
    }

    const ip = records[0].address;
    await prisma.asset.update({ where: { id: asset.id }, data: { ipAddress: ip, ipSource: "dns" } });

    logEvent({ action: "asset.dns.forward_resolved", resourceType: "asset", resourceId: asset.id, resourceName: asset.hostname || asset.dnsName || undefined, actor: req.session?.username, message: `Forward DNS: ${lookupName} → ${ip} in ${elapsed}ms` });
    res.json({ ok: true, ipAddress: ip, message: `${lookupName} → ${ip} in ${elapsed}ms` });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/oui-lookup — bulk OUI manufacturer lookup
router.post("/oui-lookup", requireAssetsAdmin, async (req, res, next) => {
  try {
    const assets = await prisma.asset.findMany({
      where: { macAddress: { not: null }, manufacturer: null, status: { notIn: ["decommissioned", "disabled"] } },
      select: { id: true, macAddress: true, hostname: true, ipAddress: true },
    });

    let resolved = 0;
    let failed = 0;
    const results: Array<{ id: string; mac: string; manufacturer: string }> = [];

    for (const asset of assets) {
      if (!asset.macAddress) continue;
      const vendor = await lookupOui(asset.macAddress);
      if (vendor) {
        const override = await lookupOuiOverride(asset.macAddress);
        const data: { manufacturer: string; model?: string } = { manufacturer: vendor };
        if (override?.device) data.model = override.device;
        await prisma.asset.update({ where: { id: asset.id }, data });
        results.push({ id: asset.id, mac: asset.macAddress, manufacturer: vendor });
        resolved++;
      } else {
        failed++;
      }
    }

    logEvent({ action: "asset.oui.bulk", resourceType: "asset", message: `Bulk OUI lookup: ${resolved} resolved, ${failed} unmatched out of ${assets.length} assets`, actor: req.session?.username });
    res.json({ total: assets.length, resolved, failed, results });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/oui-lookup — OUI manufacturer lookup for a single asset
router.post("/:id/oui-lookup", requireAssetsAdmin, async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string } });
    if (!asset) throw new AppError(404, "Asset not found");
    if (!asset.macAddress) throw new AppError(400, "Asset has no MAC address");

    const vendor = await lookupOui(asset.macAddress);
    if (!vendor) {
      return res.json({ ok: false, message: `No OUI match for ${asset.macAddress}` });
    }

    const override = await lookupOuiOverride(asset.macAddress);
    const data: { manufacturer: string; model?: string } = { manufacturer: vendor };
    if (override?.device) data.model = override.device;
    await prisma.asset.update({ where: { id: asset.id }, data });
    const msg = data.model
      ? `OUI resolved: ${asset.macAddress} → ${vendor} / ${data.model}`
      : `OUI resolved: ${asset.macAddress} → ${vendor}`;
    logEvent({ action: "asset.oui.resolved", resourceType: "asset", resourceId: asset.id, resourceName: asset.hostname || asset.ipAddress || undefined, actor: req.session?.username, message: msg });
    res.json({ ok: true, manufacturer: vendor, model: data.model, message: msg });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/import — CSV import: backdate createdAt from serial+date rows (assets admin)
router.post("/import", requireAssetsAdmin, async (req, res, next) => {
  try {
    const { rows, dryRun } = req.body as { rows?: unknown; dryRun?: boolean };
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError(400, "rows must be a non-empty array");

    const preview: Array<{ serialNumber: string; hostname: string | null; currentFirstSeen: string; importDate: string; willUpdate: boolean }> = [];
    let updated = 0;
    let notFound = 0;

    for (const row of rows as any[]) {
      const serial = String(row.serialNumber || "").trim();
      const rawDate = String(row.date || "").trim();
      if (!serial || !rawDate) continue;

      const importDate = new Date(rawDate);
      if (isNaN(importDate.getTime())) continue;

      const asset = await prisma.asset.findFirst({ where: { serialNumber: serial } });
      if (!asset) { notFound++; continue; }

      const willUpdate = importDate < asset.createdAt;
      preview.push({
        serialNumber: serial,
        hostname: asset.hostname,
        currentFirstSeen: asset.createdAt.toISOString(),
        importDate: importDate.toISOString(),
        willUpdate,
      });

      if (willUpdate && !dryRun) {
        await prisma.asset.update({ where: { id: asset.id }, data: { createdAt: importDate } });
        updated++;
      }
    }

    if (!dryRun && updated > 0) {
      logEvent({ action: "asset.import", resourceType: "asset", actor: req.session?.username, message: `CSV import: updated first-seen date for ${updated} asset(s)` });
    }

    res.json({ preview, updated, notFound, dryRun: !!dryRun });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/import-pdf — create/update assets from extracted PDF invoice data (assets admin)
router.post("/import-pdf", requireAssetsAdmin, async (req, res, next) => {
  try {
    const { assets: rows, dryRun } = req.body as { assets?: unknown; dryRun?: boolean };
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError(400, "assets must be a non-empty array");

    type PreviewRow = {
      action: "create" | "update";
      serialNumber: string | null;
      hostname: string | null;
      fields: Record<string, string>;
      existingHostname?: string | null;
    };
    const preview: PreviewRow[] = [];
    let created = 0;
    let updated = 0;

    for (const row of rows as any[]) {
      const serial = row.serialNumber ? String(row.serialNumber).trim() : null;
      const existing = serial ? await prisma.asset.findFirst({ where: { serialNumber: serial } }) : null;

      const updateData: Record<string, unknown> = {};
      const allowedFields = ["hostname", "ipAddress", "macAddress", "assetType", "status", "manufacturer", "model", "serialNumber", "location", "department", "assignedTo", "os", "notes", "assetTag"] as const;
      for (const f of allowedFields) {
        if (row[f] !== undefined && row[f] !== "") updateData[f] = String(row[f]).trim();
      }
      if (updateData.macAddress) updateData.macAddress = String(updateData.macAddress).toUpperCase().replace(/-/g, ":");

      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(updateData)) fields[k] = String(v);

      if (existing) {
        preview.push({ action: "update", serialNumber: serial, hostname: row.hostname || null, existingHostname: existing.hostname, fields });
        if (!dryRun) {
          const importUpdateData: Record<string, unknown> = { ...updateData };
          if (importUpdateData.status !== undefined) {
            importUpdateData.statusChangedAt = new Date();
            importUpdateData.statusChangedBy = req.session?.username ?? "manual";
          }
          await prisma.asset.update({ where: { id: existing.id }, data: importUpdateData as any });
          updated++;
        }
      } else {
        preview.push({ action: "create", serialNumber: serial, hostname: row.hostname || null, fields });
        if (!dryRun) {
          await prisma.asset.create({ data: { assetType: "other", status: "storage", statusChangedAt: new Date(), statusChangedBy: req.session?.username ?? "manual", ...updateData } as any });
          created++;
        }
      }
    }

    if (!dryRun && (created + updated) > 0) {
      logEvent({ action: "asset.import_pdf", resourceType: "asset", actor: req.session?.username, message: `PDF import: created ${created}, updated ${updated} asset(s)` });
    }

    res.json({ preview, created, updated, dryRun: !!dryRun });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id/macs/:mac — remove a MAC from an asset's history (network admin)
router.delete("/:id/macs/:mac", requireNetworkAdmin, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const normalized = String(req.params.mac || "").toUpperCase().replace(/-/g, ":");

    const existing = await prisma.asset.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Asset not found");

    const macs = Array.isArray(existing.macAddresses) ? (existing.macAddresses as any[]) : [];
    const filtered = macs.filter((m) => {
      const mac = String(m?.mac || "").toUpperCase().replace(/-/g, ":");
      return mac !== normalized;
    });

    if (filtered.length === macs.length) {
      throw new AppError(404, "MAC address not found on this asset");
    }

    let primary = existing.macAddress;
    if (primary && primary.toUpperCase().replace(/-/g, ":") === normalized) {
      const sorted = [...filtered].sort((a, b) => {
        const ta = a?.lastSeen ? new Date(a.lastSeen).getTime() : 0;
        const tb = b?.lastSeen ? new Date(b.lastSeen).getTime() : 0;
        return tb - ta;
      });
      primary = sorted[0]?.mac ? String(sorted[0].mac).toUpperCase().replace(/-/g, ":") : null;
    }

    const updated = await prisma.asset.update({
      where: { id },
      data: { macAddresses: filtered as any, macAddress: primary },
    });

    logEvent({
      action: "asset.mac_removed",
      resourceType: "asset",
      resourceId: id,
      resourceName: updated.hostname || updated.ipAddress || undefined,
      actor: req.session?.username,
      message: `Removed MAC ${normalized} from asset "${updated.hostname || updated.ipAddress || "unknown"}"`,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets — bulk delete (assets admin)
router.delete("/", requireAssetsAdmin, async (req, res, next) => {
  try {
    const { ids } = req.body as { ids?: unknown };
    if (!Array.isArray(ids) || ids.length === 0) throw new AppError(400, "ids must be a non-empty array");
    if (ids.some((id) => typeof id !== "string")) throw new AppError(400, "All ids must be strings");
    const { count } = await prisma.asset.deleteMany({ where: { id: { in: ids as string[] } } });
    logEvent({ action: "asset.bulk_deleted", resourceType: "asset", actor: req.session?.username, message: `Bulk deleted ${count} asset(s)` });
    res.json({ deleted: count });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id — delete (assets admin)
router.delete("/:id", requireAssetsAdmin, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.asset.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Asset not found");
    await prisma.asset.delete({ where: { id } });
    logEvent({ action: "asset.deleted", resourceType: "asset", resourceId: id, resourceName: existing.hostname || existing.ipAddress || undefined, actor: req.session?.username, message: `Asset "${existing.hostname || existing.ipAddress || "unknown"}" deleted` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
