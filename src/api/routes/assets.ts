/**
 * src/api/routes/assets.ts — Asset management CRUD
 * GET routes are available to all authenticated users.
 * POST / PUT / DELETE require assets admin role.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requireAdmin, requireAssetsAdmin, requireNetworkAdmin, requireUserOrAbove, requireSessionOrTokenScope } from "../middleware/auth.js";
import { logEvent, buildChanges } from "./events.js";
import { assetMatchesIntegrationFilter } from "../../utils/integrationFilter.js";
import { getConfiguredResolver } from "../../services/dnsService.js";
import { lookupOui, lookupOuiOverride } from "../../services/ouiService.js";
import { clampAcquiredToLastSeen } from "../../utils/assetInvariants.js";
import { getIpHistory, getHistorySettings, updateHistorySettings, pruneOldHistory } from "../../services/assetIpHistoryService.js";
import { getSightingsForAsset, getSightingSettings, updateSightingSettings } from "../../services/assetSightingService.js";
import { quarantineAsset, releaseQuarantine, verifyAssetQuarantine } from "../../services/assetQuarantineService.js";
import { isValidIpAddress } from "../../utils/cidr.js";
import {
  getMonitorSettings, updateMonitorSettings,
  probeAsset, recordProbeResult,
  collectTelemetry, recordTelemetryResult,
  collectSystemInfo, recordSystemInfoResult,
  snmpWalkRaw,
} from "../../services/monitoringService.js";
import { getCredential } from "../../services/credentialService.js";

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const AssetTypeEnum = z.enum([
  "server", "switch", "router", "firewall",
  "workstation", "printer", "access_point", "other",
]);

const AssetStatusEnum = z.enum([
  "active", "maintenance", "decommissioned", "storage", "disabled", "quarantined",
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
const MonitorTransportEnum = z.enum(["rest", "snmp"]);

const UpdateAssetSchema = CreateAssetSchema.partial().extend({
  monitored:             z.boolean().optional(),
  monitorType:           MonitorTypeEnum.nullable().optional(),
  monitorCredentialId:   z.string().uuid().nullable().optional(),
  monitorIntervalSec:    z.number().int().min(5).max(86400).nullable().optional(),
  // Per-stream transport overrides for FMG/FortiGate-discovered firewalls.
  // null = inherit from the integration's matching toggle.
  monitorResponseTimeSource: MonitorTransportEnum.nullable().optional(),
  monitorTelemetrySource:    MonitorTransportEnum.nullable().optional(),
  monitorInterfacesSource:   MonitorTransportEnum.nullable().optional(),
  monitorLldpSource:         MonitorTransportEnum.nullable().optional(),
  // Per-asset cadence overrides for the System tab. Null falls back to
  // monitor.telemetryIntervalSeconds / systemInfoIntervalSeconds.
  telemetryIntervalSec:  z.number().int().min(15).max(86400).nullable().optional(),
  systemInfoIntervalSec: z.number().int().min(60).max(86400).nullable().optional(),
  // ifNames the operator pinned for fast-cadence polling on the System tab.
  // Cap at 64 so an accidental "select-all on a 200-port chassis" can't
  // saturate the device every probe interval.
  monitoredInterfaces:   z.array(z.string().min(1)).max(64).optional(),
  // hrStorage mountPaths pinned for fast-cadence polling. Same model + cap as
  // monitoredInterfaces — keeps a server with hundreds of mountpoints from
  // re-walking the full storage table once per minute by accident.
  monitoredStorage:      z.array(z.string().min(1)).max(64).optional(),
  // Phase-1 IPsec tunnel names pinned for fast-cadence polling. The full
  // /api/v2/monitor/vpn/ipsec endpoint can be slow on busy gateways so it's
  // skipped on the fast cadence by default; pinning issues a targeted scrape.
  monitoredIpsecTunnels: z.array(z.string().min(1)).max(64).optional(),
});

/**
 * Asserts the requested monitoring config is internally consistent.
 * Mutates `data` in place to clear conflicting columns so a stale FK
 * or stale type can't survive the save.
 */
function validateMonitorConfig(data: Record<string, unknown>, existing: { monitorType?: string | null; monitorCredentialId?: string | null }): void {
  const monitored = data.monitored === undefined ? undefined : Boolean(data.monitored);
  const monitorType =
    data.monitorType === undefined ? existing.monitorType : (data.monitorType as string | null);
  const monitorCredentialId =
    data.monitorCredentialId === undefined
      ? existing.monitorCredentialId
      : (data.monitorCredentialId as string | null);

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

// ─── ipContext helpers ──────────────────────────────────────────────────────
//
// Each asset row in the UI carries an `ipContext` so the table can render a
// "View Lease" button that jumps into the network slide-over at the asset's
// IP. The button needs to know which subnet contains the IP (subnetId/cidr);
// the active reservation summary (if any) is included for any future per-row
// indicators. One subnet load + one IN-list reservation query covers an entire
// page of assets.

interface IpContext {
  subnetId: string;
  subnetCidr: string;
  reservation: { id: string; createdBy: string | null; sourceType: string } | null;
}

async function buildIpContexts(ips: string[]): Promise<Map<string, IpContext>> {
  // Pre-filter in JS: drop empties and anything that isn't a parseable IP.
  // Postgres `inet` cast throws on bad input and we have no PG15-safe TRY_CAST,
  // so we keep bad strings out of the query entirely. Subnet cidrs are written
  // through cidr.ts validation, so we trust those.
  const distinct = Array.from(new Set(ips.filter((ip) => !!ip && isValidIpAddress(ip))));
  if (distinct.length === 0) return new Map();
  // Single round-trip: containment + reservation join in Postgres. `DISTINCT ON`
  // with `masklen DESC` picks the most-specific containing subnet per IP — the
  // routing-style answer when subnets nest.
  const rows = await prisma.$queryRaw<Array<{
    ip: string;
    subnet_id: string;
    subnet_cidr: string;
    reservation_id: string | null;
    reservation_created_by: string | null;
    reservation_source_type: string | null;
  }>>`
    WITH input_ips(ip) AS (SELECT unnest(${distinct}::text[]))
    SELECT DISTINCT ON (i.ip)
      i.ip                  AS ip,
      s.id                  AS subnet_id,
      s.cidr                AS subnet_cidr,
      r.id                  AS reservation_id,
      r."createdBy"         AS reservation_created_by,
      r."sourceType"::text  AS reservation_source_type
    FROM input_ips i
    JOIN subnets s
      ON s.status <> 'deprecated'
     AND s.cidr::cidr >>= i.ip::inet
    LEFT JOIN reservations r
      ON r."subnetId"  = s.id
     AND r."ipAddress" = i.ip
     AND r.status      = 'active'
    ORDER BY i.ip, masklen(s.cidr::cidr) DESC
  `;
  const out = new Map<string, IpContext>();
  for (const row of rows) {
    out.set(row.ip, {
      subnetId: row.subnet_id,
      subnetCidr: row.subnet_cidr,
      reservation: row.reservation_id
        ? { id: row.reservation_id, createdBy: row.reservation_created_by, sourceType: row.reservation_source_type as string }
        : null,
    });
  }
  return out;
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
    const ipCtx = await buildIpContexts(assets.map((a) => a.ipAddress).filter(Boolean) as string[]);
    const enriched = assets.map((a) => ({
      ...a,
      ipContext: a.ipAddress ? (ipCtx.get(a.ipAddress) || null) : null,
    }));
    res.json({ assets: enriched, total, limit, offset });
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
    const classGroup = z.object({
      intervalSeconds:           z.number().int().min(5).max(86400).optional(),
      failureThreshold:          z.number().int().min(1).max(100).optional(),
      sampleRetentionDays:       z.number().int().min(0).max(3650).optional(),
      telemetryIntervalSeconds:  z.number().int().min(15).max(86400).optional(),
      systemInfoIntervalSeconds: z.number().int().min(60).max(86400).optional(),
      telemetryRetentionDays:    z.number().int().min(0).max(3650).optional(),
      systemInfoRetentionDays:   z.number().int().min(0).max(3650).optional(),
    });
    const body = classGroup.extend({
      // Per-class overrides for Fortinet switches / APs. Each field falls
      // back to its top-level counterpart when omitted.
      fortiswitch: classGroup.optional(),
      fortiap:     classGroup.optional(),
    }).parse(req.body);
    const next = await updateMonitorSettings(body);
    logEvent({
      action: "monitor.settings.updated",
      actor: req.session?.username,
      message: `Monitor settings updated (probe ${next.intervalSeconds}s/threshold ${next.failureThreshold}/retain ${next.sampleRetentionDays}d, telemetry ${next.telemetryIntervalSeconds}s/retain ${next.telemetryRetentionDays}d, sysinfo ${next.systemInfoIntervalSeconds}s/retain ${next.systemInfoRetentionDays}d; fortiswitch probe ${next.fortiswitch.intervalSeconds}s/sysinfo ${next.fortiswitch.systemInfoIntervalSeconds}s; fortiap probe ${next.fortiap.intervalSeconds}s/sysinfo ${next.fortiap.systemInfoIntervalSeconds}s)`,
    });
    res.json(next);
  } catch (err) { next(err); }
});

// POST /api/v1/assets/bulk-monitor — enable/disable monitoring on a set of assets.
// Body: { ids, monitored, monitorType?, monitorCredentialId?, monitorIntervalSec? }.
// On enable: applies the same monitorType + credential to every selected asset.
// Discovery-stamped defaults (fortimanager / fortigate / activedirectory) are no
// longer "locked" — operators can bulk-flip integration-discovered firewalls or
// AD hosts to snmp/icmp/winrm/ssh from the toolbar; subsequent discovery runs
// preserve the override.
// Returns per-id error list for any rejected rows.
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
      select: { id: true, hostname: true, monitorType: true, monitorCredentialId: true },
    });
    const byId = new Map(assets.map((a) => [a.id, a]));
    const updated: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const id of body.ids) {
      const a = byId.get(id);
      if (!a) { errors.push({ id, error: "Asset not found" }); continue; }
      const data: Record<string, unknown> = { monitored: body.monitored };
      if (body.monitorType !== undefined) data.monitorType = body.monitorType;
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
        discoveredByIntegration: { select: { id: true, name: true, type: true, config: true } },
        monitorCredential:       { select: { id: true, name: true, type: true } },
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    const ipCtx = asset.ipAddress
      ? (await buildIpContexts([asset.ipAddress])).get(asset.ipAddress) || null
      : null;

    // Resolve the integration's response-time probe override so the details
    // panel can label the chart with the actual probe method (SNMP via the
    // override credential, vs. the default FortiOS REST API path). The
    // integration's full `config` is not safe to leak to the client (it
    // contains API tokens), so strip it after extracting the credential id.
    let integrationMonitorCredential: { id: string; name: string; type: string } | null = null;
    let integrationTransportSources: { responseTime: "rest" | "snmp"; telemetry: "rest" | "snmp"; interfaces: "rest" | "snmp"; lldp: "rest" | "snmp" } | null = null;
    if (asset.discoveredByIntegration) {
      const cfg = (asset.discoveredByIntegration.config as Record<string, unknown> | null) || {};
      const credId = typeof cfg.monitorCredentialId === "string" ? cfg.monitorCredentialId : null;
      if (credId) {
        const cred = await prisma.credential.findUnique({
          where: { id: credId },
          select: { id: true, name: true, type: true },
        });
        if (cred) integrationMonitorCredential = cred;
      }
      // Extract the integration's per-stream transport toggles so the asset
      // edit modal can show the actual default ("Integration default (REST)"
      // / "Integration default (SNMP)") in the dropdown.
      const norm = (v: unknown): "rest" | "snmp" => (v === "snmp" ? "snmp" : "rest");
      integrationTransportSources = {
        responseTime: norm(cfg.monitorResponseTimeSource),
        telemetry:    norm(cfg.monitorTelemetrySource),
        interfaces:   norm(cfg.monitorInterfacesSource),
        lldp:         norm(cfg.monitorLldpSource),
      };
    }
    const { config: _omit, ...integrationLite } = (asset.discoveredByIntegration as { config?: unknown } | null) || {};
    const safeAsset = {
      ...asset,
      discoveredByIntegration: asset.discoveredByIntegration ? integrationLite : null,
      integrationMonitorCredential,
      integrationTransportSources,
    };

    res.json({ ...safeAsset, ipContext: ipCtx });
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

// POST /api/v1/assets/:id/probe-now — run a one-off probe immediately (user or above).
// Triggers all three cadences (response-time, telemetry, system info) so the
// asset details panel refreshes everything at once instead of waiting for the
// scheduler to come around. Returns a per-stream status so the UI can tell
// the operator which streams refreshed and which failed (and why) — silent
// failures used to leave the System tab stale with no explanation.
router.post("/:id/probe-now", requireUserOrAbove, async (req, res, next) => {
  try {
    const id = req.params.id as string;

    // Honor the originating integration's deviceInclude/deviceExclude (or
    // ouInclude/ouExclude for AD). A refresh shouldn't pull data from a
    // device the next discovery sweep would skip — operators tighten these
    // filters precisely to keep the inventory off certain hosts. If the asset
    // is now out of scope we short-circuit before any probe traffic goes out.
    const filterAsset = await prisma.asset.findUnique({
      where: { id },
      select: {
        hostname: true,
        ipAddress: true,
        learnedLocation: true,
        discoveredByIntegration: { select: { id: true, type: true, config: true, name: true } },
      },
    });
    if (!filterAsset) throw new AppError(404, "Asset not found");
    if (filterAsset.discoveredByIntegration) {
      const filt = assetMatchesIntegrationFilter(filterAsset, filterAsset.discoveredByIntegration);
      if (!filt.included) {
        const reason = filt.reason || "Excluded by integration filter";
        const label = filterAsset.hostname || filterAsset.ipAddress || id;
        logEvent({
          action: "asset.refresh",
          resourceType: "asset",
          resourceId: id,
          resourceName: filterAsset.hostname || filterAsset.ipAddress || undefined,
          actor: req.session?.username,
          level: "warning",
          message: `Refresh blocked: ${label} — ${reason}`,
          details: { integrationId: filterAsset.discoveredByIntegration.id, integrationType: filterAsset.discoveredByIntegration.type, reason },
        });
        res.status(409).json({
          success: false,
          responseTimeMs: 0,
          error: reason,
          telemetry:  { supported: true, collected: false, error: reason },
          systemInfo: { supported: true, collected: false, error: reason },
        });
        return;
      }
    }

    // Keep flat response-time fields at the root for back-compat with anything
    // that still reads `success` / `responseTimeMs` directly.
    const probe = await probeAsset(id);
    await recordProbeResult(id, probe);

    let telemetry: { supported: boolean; collected: boolean; error?: string };
    try {
      const tr = await collectTelemetry(id);
      await recordTelemetryResult(id, tr);
      telemetry = { supported: tr.supported, collected: !!tr.data, error: tr.error };
    } catch (err: any) {
      telemetry = { supported: true, collected: false, error: err?.message || "Telemetry collection failed" };
    }

    let systemInfo: { supported: boolean; collected: boolean; error?: string };
    try {
      const sr = await collectSystemInfo(id);
      await recordSystemInfoResult(id, sr);
      systemInfo = { supported: sr.supported, collected: !!sr.data, error: sr.error };
    } catch (err: any) {
      systemInfo = { supported: true, collected: false, error: err?.message || "System info collection failed" };
    }

    // Audit the manual refresh. The periodic monitorAssets job only writes
    // events on up/down transitions; this endpoint is operator-initiated, so
    // each click should leave a trace regardless of status change.
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { hostname: true, ipAddress: true },
    });
    const label = asset?.hostname || asset?.ipAddress || id;
    const ok = probe.success;
    const streamSummary: string[] = [];
    streamSummary.push(`probe ${ok ? probe.responseTimeMs + " ms" : "failed: " + (probe.error || "unknown")}`);
    streamSummary.push(`telemetry ${telemetry.collected ? "ok" : (telemetry.supported ? "failed: " + (telemetry.error || "no data") : "n/a")}`);
    streamSummary.push(`interfaces ${systemInfo.collected ? "ok" : (systemInfo.supported ? "failed: " + (systemInfo.error || "no data") : "n/a")}`);
    const anyFail = !ok || (telemetry.supported && !telemetry.collected) || (systemInfo.supported && !systemInfo.collected);
    logEvent({
      action: "asset.refresh",
      resourceType: "asset",
      resourceId: id,
      resourceName: asset?.hostname || asset?.ipAddress || undefined,
      actor: req.session?.username,
      level: anyFail ? "warning" : "info",
      message: `Refresh: ${label} — ${streamSummary.join("; ")}`,
      details: { probe, telemetry, systemInfo },
    });

    res.json({ ...probe, telemetry, systemInfo });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/:id/snmp-walk — operator-driven SNMP walk used by the
// asset details "SNMP Walk" tab. Admin-only because the response includes raw
// device data that the integration filter doesn't touch (e.g. tunnel names,
// configured users) — read-only but high-fidelity. Walks `oid` against the
// asset's `ipAddress` using the supplied credentialId (any stored SNMP
// credential, not necessarily the asset's monitor credential), capped at
// `maxRows` (1..5000, default 500).
const SnmpWalkSchema = z.object({
  credentialId: z.string().uuid("credentialId must be a UUID"),
  oid:          z.string().regex(/^\d+(\.\d+)*$/, "OID must be numeric (e.g. 1.3.6.1.2.1.1)").optional().default("1.3.6.1.2.1.1"),
  maxRows:      z.number().int().min(1).max(5000).optional().default(500),
});

router.post("/:id/snmp-walk", requireAdmin, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const parsed = SnmpWalkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map(e => e.message).join("; "));
    }
    const { credentialId, oid, maxRows } = parsed.data;

    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, hostname: true, ipAddress: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    if (!asset.ipAddress) throw new AppError(400, "Asset has no IP address to walk");

    const cred = await getCredential(credentialId, { revealSecrets: true });
    if (cred.type !== "snmp") {
      throw new AppError(400, `Credential "${cred.name}" is type "${cred.type}", expected "snmp"`);
    }

    const label = asset.hostname || asset.ipAddress;
    try {
      const result = await snmpWalkRaw(asset.ipAddress, cred.config as Record<string, unknown>, oid, maxRows);
      logEvent({
        action: "asset.snmp_walk",
        resourceType: "asset",
        resourceId: id,
        resourceName: asset.hostname || asset.ipAddress || undefined,
        actor: req.session?.username,
        level: "info",
        message: `SNMP walk: ${label} — ${oid} → ${result.rows.length} row(s)${result.truncated ? " (truncated)" : ""}`,
        details: { oid, credentialName: cred.name, rows: result.rows.length, truncated: result.truncated, durationMs: result.durationMs },
      });
      res.json({ ...result, oid, host: asset.ipAddress });
    } catch (err: any) {
      const message = err?.message || "SNMP walk failed";
      logEvent({
        action: "asset.snmp_walk",
        resourceType: "asset",
        resourceId: id,
        resourceName: asset.hostname || asset.ipAddress || undefined,
        actor: req.session?.username,
        level: "warning",
        message: `SNMP walk failed: ${label} — ${oid} — ${message}`,
        details: { oid, credentialName: cred.name, error: message },
      });
      throw new AppError(502, message);
    }
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
      select: {
        id: true, monitored: true, monitorType: true,
        lastTelemetryAt: true, lastSystemInfoAt: true,
        monitoredInterfaces: true,
        monitoredStorage: true,
        monitoredIpsecTunnels: true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    const [latestTelemetry, latestIfaceMeta, latestStorageMeta, latestTempMeta, latestIpsecMeta, lldpNeighbors] = await Promise.all([
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
      prisma.assetTemperatureSample.findFirst({
        where: { assetId: id },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
      prisma.assetIpsecTunnelSample.findFirst({
        where: { assetId: id },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
      // LLDP neighbors are current-state (one row per neighbor) rather than
      // a time-series, so we just return the entire set on every call. The
      // matched-asset relation lets the UI link from a neighbor row directly
      // to that asset's details modal.
      prisma.assetLldpNeighbor.findMany({
        where: { assetId: id },
        orderBy: [{ localIfName: "asc" }, { systemName: "asc" }],
        include: {
          matchedAsset: {
            select: { id: true, hostname: true, ipAddress: true, assetType: true },
          },
        },
      }),
    ]);

    // Prefer the full system-info pass timestamp so the table renders every
    // interface — the fast cadence only writes pinned ones, and ordering by
    // raw timestamp would otherwise hide unpinned interfaces.
    const ifaceTimestamp = asset.lastSystemInfoAt ?? latestIfaceMeta?.timestamp ?? null;
    const interfaces = ifaceTimestamp
      ? await prisma.assetInterfaceSample.findMany({
          where: { assetId: id, timestamp: ifaceTimestamp },
          orderBy: { ifName: "asc" },
        })
      : [];
    const storage = latestStorageMeta
      ? await prisma.assetStorageSample.findMany({
          where: { assetId: id, timestamp: latestStorageMeta.timestamp },
          orderBy: { mountPath: "asc" },
        })
      : [];
    const temperatures = latestTempMeta
      ? await prisma.assetTemperatureSample.findMany({
          where: { assetId: id, timestamp: latestTempMeta.timestamp },
          orderBy: { sensorName: "asc" },
        })
      : [];
    const ipsecTunnels = latestIpsecMeta
      ? await prisma.assetIpsecTunnelSample.findMany({
          where: { assetId: id, timestamp: latestIpsecMeta.timestamp },
          orderBy: { tunnelName: "asc" },
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
        inErrors:    bigIntToNumber(i.inErrors),
        outErrors:   bigIntToNumber(i.outErrors),
        ifType:      i.ifType   ?? null,
        ifParent:    i.ifParent ?? null,
        vlanId:      i.vlanId   ?? null,
        alias:       i.alias       ?? null,
        description: i.description ?? null,
      })),
      storage: storage.map((s) => ({
        timestamp:  s.timestamp,
        mountPath:  s.mountPath,
        totalBytes: bigIntToNumber(s.totalBytes),
        usedBytes:  bigIntToNumber(s.usedBytes),
      })),
      temperatures: temperatures.map((t) => ({
        timestamp:  t.timestamp,
        sensorName: t.sensorName,
        celsius:    t.celsius,
      })),
      ipsecTunnels: ipsecTunnels.map((t) => ({
        timestamp:       t.timestamp,
        tunnelName:      t.tunnelName,
        parentInterface: t.parentInterface,
        remoteGateway:   t.remoteGateway,
        status:          t.status,
        incomingBytes:   bigIntToNumber(t.incomingBytes),
        outgoingBytes:   bigIntToNumber(t.outgoingBytes),
        proxyIdCount:    t.proxyIdCount,
      })),
      lldpNeighbors: lldpNeighbors.map((n) => ({
        localIfName:        n.localIfName,
        chassisIdSubtype:   n.chassisIdSubtype,
        chassisId:          n.chassisId,
        portIdSubtype:      n.portIdSubtype,
        portId:             n.portId,
        portDescription:    n.portDescription,
        systemName:         n.systemName,
        systemDescription:  n.systemDescription,
        managementIp:       n.managementIp,
        capabilities:       n.capabilities,
        source:             n.source,
        firstSeen:          n.firstSeen,
        lastSeen:           n.lastSeen,
        matchedAsset:       n.matchedAsset
          ? {
              id:        n.matchedAsset.id,
              hostname:  n.matchedAsset.hostname,
              ipAddress: n.matchedAsset.ipAddress,
              assetType: n.matchedAsset.assetType,
            }
          : null,
      })),
      monitoredInterfaces:   (asset.monitoredInterfaces   ?? []) as string[],
      monitoredStorage:      (asset.monitoredStorage      ?? []) as string[],
      monitoredIpsecTunnels: (asset.monitoredIpsecTunnels ?? []) as string[],
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
    const [samples, override, neighbors] = await Promise.all([
      prisma.assetInterfaceSample.findMany({
        where: { assetId: id, ifName, timestamp: { gte: since, lte: until } },
        orderBy: { timestamp: "asc" },
      }),
      prisma.assetInterfaceOverride.findUnique({
        where: { assetId_ifName: { assetId: id, ifName } },
      }),
      // LLDP neighbors on this exact local interface — usually 0 or 1 row,
      // sometimes >1 on shared media or stacked switches reporting two
      // chassis IDs. Returned with the matched-asset cross-link so the
      // slide-over can surface a "Go to <hostname>" button.
      prisma.assetLldpNeighbor.findMany({
        where: { assetId: id, localIfName: ifName },
        orderBy: { systemName: "asc" },
        include: {
          matchedAsset: {
            select: { id: true, hostname: true, ipAddress: true, assetType: true },
          },
        },
      }),
    ]);
    // The slide-over header shows the alias label and operator comment from the
    // most recent sample so the panel reflects the current configured values
    // even when the operator is looking at an older time window. The Polaris
    // operator-typed comment override (AssetInterfaceOverride.description) wins
    // over the discovered FortiOS CMDB description; the discovered value is
    // returned as `discoveredDescription` so the UI can show it as a hint.
    const latest = samples.length > 0 ? samples[samples.length - 1] : null;
    const discoveredDescription = latest?.description ?? null;
    const overrideDescription = override?.description ?? null;
    res.json({
      range: rangeLabel,
      ifName,
      alias:       latest?.alias       ?? null,
      description: overrideDescription ?? discoveredDescription,
      discoveredDescription,
      overrideDescription,
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
        inErrors:    bigIntToNumber(s.inErrors),
        outErrors:   bigIntToNumber(s.outErrors),
      })),
      lldpNeighbors: neighbors.map((n) => ({
        chassisIdSubtype:  n.chassisIdSubtype,
        chassisId:         n.chassisId,
        portIdSubtype:     n.portIdSubtype,
        portId:            n.portId,
        portDescription:   n.portDescription,
        systemName:        n.systemName,
        systemDescription: n.systemDescription,
        managementIp:      n.managementIp,
        capabilities:      n.capabilities,
        source:            n.source,
        firstSeen:         n.firstSeen,
        lastSeen:          n.lastSeen,
        matchedAsset:      n.matchedAsset
          ? {
              id:        n.matchedAsset.id,
              hostname:  n.matchedAsset.hostname,
              ipAddress: n.matchedAsset.ipAddress,
              assetType: n.matchedAsset.assetType,
            }
          : null,
      })),
    });
  } catch (err) { next(err); }
});

// PUT /assets/:id/interfaces/:ifName/comment — operator-typed override for the
// interface's "Interface Comments" text box. Polaris-local only — never pushed
// back to the device. Empty string or null clears the override (the discovered
// FortiOS CMDB description shows through again).
const InterfaceCommentSchema = z.object({
  description: z.string().max(255, "Interface Comments may be at most 255 characters").nullable().optional(),
});
router.put("/:id/interfaces/:ifName/comment", requireAssetsAdmin, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const ifName = String(req.params.ifName || "");
    if (!ifName) throw new AppError(400, "ifName path parameter is required");

    const parsed = InterfaceCommentSchema.parse(req.body || {});
    const raw = parsed.description == null ? "" : String(parsed.description);
    const trimmed = raw.trim();
    const actor = req.session?.username;

    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, hostname: true, ipAddress: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    if (trimmed.length === 0) {
      // Clear override — fall back to discovered description
      await prisma.assetInterfaceOverride.deleteMany({ where: { assetId: id, ifName } });
    } else {
      await prisma.assetInterfaceOverride.upsert({
        where: { assetId_ifName: { assetId: id, ifName } },
        create: { assetId: id, ifName, description: trimmed, updatedBy: actor },
        update: { description: trimmed, updatedBy: actor },
      });
    }

    logEvent({
      action: "asset.interface.comment_updated",
      resourceType: "asset",
      resourceId: id,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor,
      level: "info",
      message: trimmed.length === 0
        ? `Cleared interface comment override on ${asset.hostname || asset.ipAddress || id} / ${ifName}`
        : `Updated interface comment override on ${asset.hostname || asset.ipAddress || id} / ${ifName}`,
      details: { ifName, length: trimmed.length },
    });

    res.json({ ok: true, ifName, description: trimmed.length === 0 ? null : trimmed });
  } catch (err) { next(err); }
});

// GET /assets/:id/temperature-history?range=... [&sensorName=...] — per-sensor temperatures
router.get("/:id/temperature-history", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const sensorName = req.query.sensorName ? String(req.query.sensorName) : null;
    const { since, until, rangeLabel } = resolveRange(req);
    const samples = await prisma.assetTemperatureSample.findMany({
      where: { assetId: id, timestamp: { gte: since, lte: until }, ...(sensorName ? { sensorName } : {}) },
      orderBy: { timestamp: "asc" },
    });
    const cs = samples.map((s) => s.celsius).filter((x): x is number => typeof x === "number");
    res.json({
      range: rangeLabel,
      sensorName,
      since,
      until,
      samples: samples.map((s) => ({
        timestamp:  s.timestamp,
        sensorName: s.sensorName,
        celsius:    s.celsius,
      })),
      stats: {
        total:      samples.length,
        avgCelsius: cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : null,
        maxCelsius: cs.length ? Math.max(...cs) : null,
        minCelsius: cs.length ? Math.min(...cs) : null,
      },
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/ipsec-history?tunnelName=...&range=... — per-tunnel state + bytes
router.get("/:id/ipsec-history", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const tunnelName = req.query.tunnelName ? String(req.query.tunnelName) : null;
    if (!tunnelName) throw new AppError(400, "tunnelName query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const samples = await prisma.assetIpsecTunnelSample.findMany({
      where: { assetId: id, tunnelName, timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    res.json({
      range: rangeLabel,
      tunnelName,
      since,
      until,
      samples: samples.map((s) => ({
        timestamp:     s.timestamp,
        status:        s.status,
        remoteGateway: s.remoteGateway,
        incomingBytes: bigIntToNumber(s.incomingBytes),
        outgoingBytes: bigIntToNumber(s.outgoingBytes),
        proxyIdCount:  s.proxyIdCount,
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
    // Quarantine status is owned by the dedicated quarantine endpoints —
    // setting it via the generic asset PUT would skip the FortiGate push
    // (or skip the device-side unpush on release), creating divergence
    // between Polaris's view and the FortiGate's enforcement state.
    if (input.status === "quarantined" && existing.status !== "quarantined") {
      throw new AppError(400, "Use POST /assets/:id/quarantine to quarantine an asset");
    }
    if (input.status !== undefined && input.status !== "quarantined" && existing.status === "quarantined") {
      throw new AppError(400, "Use DELETE /assets/:id/quarantine to release the quarantine before changing status");
    }
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
    // Refuse to bulk-delete any quarantined asset — the operator must release
    // the quarantine first so the device-side targets get cleaned up.
    const quarantined = await prisma.asset.findMany({
      where: { id: { in: ids as string[] }, status: "quarantined" },
      select: { id: true, hostname: true, ipAddress: true },
    });
    if (quarantined.length > 0) {
      const names = quarantined.map((a) => a.hostname || a.ipAddress || a.id).slice(0, 5);
      const more = quarantined.length > 5 ? ` (+${quarantined.length - 5} more)` : "";
      throw new AppError(409, `Cannot delete quarantined asset(s): ${names.join(", ")}${more}. Release the quarantine first.`);
    }
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
    if (existing.status === "quarantined") {
      throw new AppError(409, `Cannot delete quarantined asset "${existing.hostname || existing.ipAddress || id}". Release the quarantine first.`);
    }
    await prisma.asset.delete({ where: { id } });
    logEvent({ action: "asset.deleted", resourceType: "asset", resourceId: id, resourceName: existing.hostname || existing.ipAddress || undefined, actor: req.session?.username, message: `Asset "${existing.hostname || existing.ipAddress || "unknown"}" deleted` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── Quarantine + sightings ─────────────────────────────────────────────

// GET /api/v1/assets/sighting-settings — current settings
router.get("/sighting-settings", async (_req, res, next) => {
  try {
    res.json(await getSightingSettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/sighting-settings — admin or assets admin
router.put("/sighting-settings", requireAssetsAdmin, async (req, res, next) => {
  try {
    const Schema = z.object({ sightingMaxAgeDays: z.number().int().min(0).max(3650) });
    const input = Schema.parse(req.body);
    await updateSightingSettings(input);
    logEvent({
      action: "asset.sighting_settings_updated",
      actor: req.session?.username,
      message: `Quarantine sighting max-age set to ${input.sightingMaxAgeDays} day(s)`,
    });
    res.json(input);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/sightings — DHCP sighting history (any auth user)
router.get("/:id/sightings", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const exists = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new AppError(404, "Asset not found");
    res.json(await getSightingsForAsset(id));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/quarantine-status — current quarantine state + recorded targets
router.get("/:id/quarantine-status", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        statusBeforeQuarantine: true,
        quarantineReason: true,
        quarantinedAt: true,
        quarantinedBy: true,
        quarantineTargets: true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    res.json(asset);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/quarantine — admin, assets admin, or token with assets:quarantine scope
router.post("/:id/quarantine", requireSessionOrTokenScope(["admin", "assetsadmin"], "assets:quarantine"), async (req, res, next) => {
  try {
    const Schema = z.object({ reason: z.string().max(500).optional() });
    const input = Schema.parse(req.body ?? {});
    const id = req.params.id as string;
    const actor = req.apiToken ? `api:${req.apiToken.name}` : `user:${req.session?.username || "unknown"}`;
    const result = await quarantineAsset({
      assetId: id,
      actor,
      reason: input.reason,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id/quarantine — admin, assets admin, or token with assets:quarantine scope
router.delete("/:id/quarantine", requireSessionOrTokenScope(["admin", "assetsadmin"], "assets:quarantine"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const actor = req.apiToken ? `api:${req.apiToken.name}` : `user:${req.session?.username || "unknown"}`;
    const result = await releaseQuarantine({
      assetId: id,
      actor,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/quarantine/verify — read-back drift check (admin, assets admin, or token)
router.post("/:id/quarantine/verify", requireSessionOrTokenScope(["admin", "assetsadmin"], "assets:quarantine"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const verifyResult = await verifyAssetQuarantine(id);
    if (verifyResult.driftDetected) {
      // Persist the drift flip + log the event so the operator has an audit trail.
      await prisma.asset.update({
        where: { id },
        data: { quarantineTargets: verifyResult.targets as any },
      });
      const asset = await prisma.asset.findUnique({ where: { id }, select: { hostname: true, ipAddress: true } });
      const actor = req.apiToken ? req.apiToken.name : req.session?.username;
      logEvent({
        action: "asset.quarantine.drift_detected",
        resourceType: "asset",
        resourceId: id,
        resourceName: asset?.hostname || asset?.ipAddress || undefined,
        actor,
        level: "warning",
        message: `Quarantine drift detected on ${asset?.hostname || id} — one or more FortiGate targets are missing or incomplete`,
        details: { targets: verifyResult.targets },
      });
    }
    res.json(verifyResult);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/bulk-quarantine — admin, assets admin, or token with assets:quarantine scope
router.post("/bulk-quarantine", requireSessionOrTokenScope(["admin", "assetsadmin"], "assets:quarantine"), async (req, res, next) => {
  try {
    const Schema = z.object({
      ids: z.array(z.string()).min(1),
      reason: z.string().max(500).optional(),
    });
    const input = Schema.parse(req.body);
    const actor = req.apiToken ? `api:${req.apiToken.name}` : `user:${req.session?.username || "unknown"}`;
    const results: Array<{ id: string; ok: boolean; message: string; succeededCount?: number; failedCount?: number }> = [];
    for (const id of input.ids) {
      try {
        const r = await quarantineAsset({ assetId: id, actor, reason: input.reason });
        results.push({ id, ok: true, message: r.message, succeededCount: r.succeededCount, failedCount: r.failedCount });
      } catch (err: any) {
        results.push({ id, ok: false, message: err?.message || "Quarantine failed" });
      }
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/bulk-quarantine/release — admin, assets admin, or token with assets:quarantine scope
router.post("/bulk-quarantine/release", requireSessionOrTokenScope(["admin", "assetsadmin"], "assets:quarantine"), async (req, res, next) => {
  try {
    const Schema = z.object({ ids: z.array(z.string()).min(1) });
    const input = Schema.parse(req.body);
    const actor = req.apiToken ? `api:${req.apiToken.name}` : `user:${req.session?.username || "unknown"}`;
    const results: Array<{ id: string; ok: boolean; message: string }> = [];
    for (const id of input.ids) {
      try {
        const r = await releaseQuarantine({ assetId: id, actor });
        results.push({ id, ok: true, message: r.message });
      } catch (err: any) {
        results.push({ id, ok: false, message: err?.message || "Release failed" });
      }
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

export default router;
