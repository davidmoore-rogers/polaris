/**
 * src/api/routes/assets.ts — Asset management CRUD
 * GET routes are available to all authenticated users.
 * POST / PUT / DELETE require assets admin role.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requirePermission, requireSessionOrTokenPermission } from "../middleware/permissions.js";
import { logEvent, buildChanges } from "./events.js";
import { assetMatchesIntegrationFilter } from "../../utils/integrationFilter.js";
import { getConfiguredResolver } from "../../services/dnsService.js";
import { lookupOui, lookupOuiOverride } from "../../services/ouiService.js";
import { clampAcquiredToLastSeen } from "../../utils/assetInvariants.js";
import { getIpHistory, getHistorySettings, updateHistorySettings, pruneOldHistory } from "../../services/assetIpHistoryService.js";
import { getSightingsForAsset, getSightingSettings, updateSightingSettings } from "../../services/assetSightingService.js";
import { quarantineAsset, releaseQuarantine, verifyAssetQuarantine } from "../../services/assetQuarantineService.js";
import { isValidIpAddress, cidrContains } from "../../utils/cidr.js";
import { isKnownAssetType } from "../../utils/assetTypes.js";
import { recomputeMonitorOverrideForAssets } from "../../services/monitorOverrideService.js";
import { projectAssetFromSources } from "../../utils/assetProjection.js";
import { shapeMacRows, MAC_ROW_SELECT, reconcileMacAddresses } from "../../utils/macAddresses.js";
import {
  probeAsset, recordProbeResult,
  collectTelemetry, recordTelemetryResult,
  collectTemperatures, recordTemperatureResult,
  collectSystemInfo, recordSystemInfoResult,
  snmpWalkRaw,
  resolveMonitorSettingsWithProvenance,
} from "../../services/monitoringService.js";
import { getCredential } from "../../services/credentialService.js";
import { resolveConnectionPath } from "../../services/connectionPathService.js";
import { propagateAfterStatusChange } from "../../services/dependencyTreeService.js";
import { pickSampleTierForAsset } from "../../services/sampleQueryRouter.js";
import {
  readMonitorHistory,
  readTelemetryHistory,
  readTemperatureHistory,
  readInterfaceHistory,
  readStorageHistory,
  readIpsecHistory,
} from "../../services/sampleHistoryService.js";
import {
  type PollingMethod,
  assetSourceKindFromIntegrationType,
  isPollingMethodCompatible,
  pollingMethodLabel,
} from "../../utils/pollingCompatibility.js";
import {
  buildInferredNeighborsForAsset,
  dedupeInferredNeighbors,
} from "../../services/peerInferredLldpService.js";

const router = Router();

// ─── associatedIps shape helper ──────────────────────────────────────────────
//
// `Asset.associatedIps` was a JSONB column until the side-table migration; the
// frontend (`public/js/assets.js`) and any external API consumer still expect
// the response to carry an `associatedIps: [...]` JSON array on the asset
// object. Rather than change the wire format, every place that reads asset
// rows + their `associatedIpRows` relation runs the rows through this helper
// to project them back into the original JSON shape.

interface AssociatedIpJson {
  ip: string;
  source: string;
  interfaceName?: string;
  mac?: string;
  ptrName?: string;
  ptrTtl?: number;
  ptrFetchedAt?: string;
  lastSeen?: string;
  firstSeen?: string;
}

interface AssociatedIpRow {
  ip: string;
  source: string;
  interfaceName: string | null;
  mac: string | null;
  ptrName: string | null;
  ptrTtl: number | null;
  ptrFetchedAt: Date | null;
  lastSeen: Date;
  firstSeen: Date;
}

function shapeAssociatedIps(rows: AssociatedIpRow[] | null | undefined): AssociatedIpJson[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const out: AssociatedIpJson = { ip: r.ip, source: r.source };
    if (r.interfaceName) out.interfaceName = r.interfaceName;
    if (r.mac)           out.mac           = r.mac;
    if (r.ptrName)       out.ptrName       = r.ptrName;
    if (r.ptrTtl != null) out.ptrTtl       = r.ptrTtl;
    if (r.ptrFetchedAt)   out.ptrFetchedAt = r.ptrFetchedAt.toISOString();
    out.lastSeen  = r.lastSeen.toISOString();
    out.firstSeen = r.firstSeen.toISOString();
    return out;
  });
}

const ASSOCIATED_IP_SELECT = {
  ip: true, source: true, interfaceName: true, mac: true,
  ptrName: true, ptrTtl: true, ptrFetchedAt: true,
  lastSeen: true, firstSeen: true,
} as const;

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

// Asset type is now a free-form string validated against the AssetTypeDef
// registry (eight built-ins + any operator-added custom types). The synchronous
// `isKnownAssetType` reads the in-memory cache populated at boot by
// assetTypeService.refreshCache(); until the cache loads it falls back to
// accepting the eight built-in names, which keeps early-boot writes legal.
const AssetTypeEnum = z.string().min(2).max(32).refine(
  (v) => isKnownAssetType(v),
  { message: "Unknown asset type. Add it under Assets → Manage asset types first." },
);

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

// Mirrors PollingMethod in src/utils/pollingCompatibility.ts. Source-kind
// compatibility is enforced at resolution time, not here — the resolver
// silently falls through to the next tier when a per-asset override doesn't
// apply to the asset's source. Includes "disabled" (universally allowed
// opt-out) and "agent" (Polaris Agent; allowed on AD/Entra/WinServer/Manual
// sources, ignored on fortimanager/fortigate).
const PollingMethodEnum = z.enum(["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent"]);

const UpdateAssetSchema = CreateAssetSchema.partial().extend({
  monitored:             z.boolean().optional(),
  monitorCredentialId:          z.string().uuid().nullable().optional(),
  responseTimeCredentialId:     z.string().uuid().nullable().optional(),
  cpuMemoryCredentialId:        z.string().uuid().nullable().optional(),
  temperatureCredentialId:      z.string().uuid().nullable().optional(),
  interfacesCredentialId:       z.string().uuid().nullable().optional(),
  lldpCredentialId:             z.string().uuid().nullable().optional(),
  // Per-stream MIB overrides ("std:<key>" | uploaded MIB UUID | null = inherit)
  responseTimeMibId:            z.string().nullable().optional(),
  cpuMemoryMibId:               z.string().nullable().optional(),
  temperatureMibId:             z.string().nullable().optional(),
  interfacesMibId:              z.string().nullable().optional(),
  lldpMibId:                    z.string().nullable().optional(),
  monitorIntervalSec:           z.number().int().min(5).max(86400).nullable().optional(),
  // Per-asset probe timeout override. 100..60000 ms; null inherits from the
  // resolved tier-3 setting. The frontend renders a soft warning at <500 ms.
  probeTimeoutMs:        z.number().int().min(100).max(60000).nullable().optional(),
  // Per-asset overrides for the heavy collectors. 1000..120000 ms; null = inherit.
  // Wider range than probeTimeoutMs — these scrapes pull dozens of OIDs or
  // multi-MB FortiOS payloads, and a too-tight ceiling false-fails the run.
  cpuMemoryTimeoutMs:    z.number().int().min(1000).max(120000).nullable().optional(),
  temperatureTimeoutMs:  z.number().int().min(1000).max(120000).nullable().optional(),
  systemInfoTimeoutMs:   z.number().int().min(1000).max(120000).nullable().optional(),
  // Per-stream polling-method overrides — top-tier override, falls through
  // to the class override / integration tier / source default. Compatibility
  // with the asset's source kind is enforced at PUT time below.
  responseTimePolling:   PollingMethodEnum.nullable().optional(),
  cpuMemoryPolling:      PollingMethodEnum.nullable().optional(),
  temperaturePolling:    PollingMethodEnum.nullable().optional(),
  interfacesPolling:     PollingMethodEnum.nullable().optional(),
  lldpPolling:           PollingMethodEnum.nullable().optional(),
  storagePolling:        PollingMethodEnum.nullable().optional(),
  // Per-asset cadence overrides for the System tab. Null falls back to the
  // resolved tier-3 cadence (cpuMemory / temperature / system-info).
  cpuMemoryIntervalSec:   z.number().int().min(15).max(86400).nullable().optional(),
  temperatureIntervalSec: z.number().int().min(15).max(86400).nullable().optional(),
  systemInfoIntervalSec:  z.number().int().min(60).max(86400).nullable().optional(),
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
 * Apply Asset.monitored side-effects on save. The polling-method resolver is
 * the source of truth for HOW the asset gets probed — we don't re-validate
 * polling/credential consistency at write-time; the dispatcher reports
 * errors clearly when a missing credential surfaces during a probe.
 */
function clampMonitoredState(data: Record<string, unknown>): void {
  const monitored = data.monitored === undefined ? undefined : Boolean(data.monitored);
  if (monitored === false) {
    data.consecutiveFailures = 0;
  } else if (monitored === true) {
    // Reset probe state so the pill always starts at Recovering on re-enable
    // rather than carrying over stale Down/Warning from the previous session.
    data.monitorStatus = "recovering";
    data.consecutiveFailures = 0;
    data.consecutiveSuccesses = 0;
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
router.get("/", requirePermission("assets", "read"), async (req, res, next) => {
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
          macAddressRows: { select: MAC_ROW_SELECT },
          associatedIpRows: { select: ASSOCIATED_IP_SELECT },
          serialNumber: true,
          manufacturer: true,
          model: true,
          os: true,
          osVersion: true,
          assignedTo: true,
          purchaseOrder: true,
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
          monitorStatus: true,
          lastMonitorAt: true,
          lastResponseTimeMs: true,
          discoveredByIntegrationId: true,
          dependencyLayer: true,
          dependencySuppressed: true,
          dependencyTestUntil: true,
        },
      }),
      prisma.asset.count({ where }),
    ]);
    const ipCtx = await buildIpContexts(assets.map((a) => a.ipAddress).filter(Boolean) as string[]);
    const enriched = assets.map(({ associatedIpRows, macAddressRows, ...a }) => ({
      ...a,
      associatedIps: shapeAssociatedIps(associatedIpRows),
      macAddresses: shapeMacRows(macAddressRows),
      ipContext: a.ipAddress ? (ipCtx.get(a.ipAddress) || null) : null,
    }));
    res.json({ assets: enriched, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/ip-history-settings — get history retention settings (all authenticated users)
// Must be defined before /:id to avoid route shadowing.
router.get("/ip-history-settings", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    res.json(await getHistorySettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/ip-history-settings — update retention settings (assets admin)
router.put("/ip-history-settings", requirePermission("assets", "write"), async (req, res, next) => {
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

// Note: the legacy GET/PUT /monitor-settings routes were retired with the
// move to the four-tier hierarchy. Operators now use:
//   - /api/v1/monitor-settings/manual                → global manual tier
//   - /api/v1/monitor-settings/integration/:id       → per-integration tier
//   - /api/v1/monitor-settings/class-overrides       → (class + integration)
//   - PUT /api/v1/assets/:id  with monitorIntervalSec / probeTimeoutMs / etc.
//                                                    → per-asset overrides
// See src/api/routes/monitorSettings.ts.

// POST /api/v1/assets/bulk-monitor — enable/disable monitoring on a set of assets.
// Body: { ids, monitored, monitorCredentialId?, monitorIntervalSec?, probeTimeoutMs? }.
// On enable: applies the same credential + cadence overrides uniformly. The
// polling method comes from the resolver (per-asset overrides set via PUT,
// class overrides, integration-tier setting, source default) — the bulk
// endpoint isn't the place to choose a method, since one selection rarely
// fits a heterogeneous batch. Operators picking a method per-asset use the
// asset edit modal's Monitoring tab.
// Returns per-id error list for any rejected rows.
router.post("/bulk-monitor", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const body = z.object({
      ids:                 z.array(z.string().uuid()).min(1),
      monitored:           z.boolean(),
      monitorCredentialId: z.string().uuid().nullable().optional(),
      monitorIntervalSec:  z.number().int().min(5).max(86400).nullable().optional(),
      probeTimeoutMs:      z.number().int().min(100).max(60000).nullable().optional(),
    }).parse(req.body);

    // Build the per-asset data shape ONCE — every selected asset gets the
    // same monitor config in a bulk operation. monitorOverride is NOT set
    // here because it depends on each asset's discoveredByIntegrationId +
    // assetType (per-asset-varying) — instead we recompute it in one SQL
    // pass against the touched ids after the updateMany lands.
    const data: Record<string, unknown> = {
      monitored: body.monitored,
    };
    if (body.monitorCredentialId !== undefined) data.monitorCredentialId = body.monitorCredentialId;
    if (body.monitorIntervalSec !== undefined)  data.monitorIntervalSec  = body.monitorIntervalSec;
    if (body.probeTimeoutMs !== undefined)      data.probeTimeoutMs      = body.probeTimeoutMs;
    clampMonitoredState(data);

    // Identify which of the requested ids actually exist so the response
    // can flag missing rows. One round-trip vs the previous N-asset loop.
    const found = await prisma.asset.findMany({
      where: { id: { in: body.ids } },
      select: { id: true },
    });
    const foundSet = new Set(found.map((a) => a.id));
    const errors: Array<{ id: string; error: string }> = body.ids
      .filter((id) => !foundSet.has(id))
      .map((id) => ({ id, error: "Asset not found" }));

    // Single bulk update — Postgres' `WHERE id = ANY(...)` planner walks
    // the (newly-added) primary key once and applies the uniform data
    // change to every matched row. Was 1000 sequential round-trips, is
    // now one statement.
    let updatedCount = 0;
    if (foundSet.size > 0) {
      const result = await prisma.asset.updateMany({
        where: { id: { in: [...foundSet] } },
        data: data as any,
      });
      updatedCount = result.count;
      // Recompute monitorOverride for every touched asset in one SQL UPDATE.
      // Each asset's override depends on its discoveredByIntegrationId +
      // assetType, so it has to be done per-asset against the integration's
      // per-class addAsMonitored. Assets without an integration link are
      // skipped by the WHERE clause and keep monitorOverride=false.
      await recomputeMonitorOverrideForAssets(prisma, [...foundSet]);
    }

    logEvent({
      action: body.monitored ? "monitor.bulk_enabled" : "monitor.bulk_disabled",
      resourceType: "asset",
      actor: req.session?.username,
      message: `Bulk ${body.monitored ? "enabled" : "disabled"} monitoring on ${updatedCount} asset(s)` + (errors.length ? `; ${errors.length} error(s)` : ""),
      details: errors.length ? { errors } : undefined,
    });
    res.json({ updated: updatedCount, errors });
  } catch (err) { next(err); }
});

// GET /api/v1/assets/:id — get single asset (all authenticated users)
router.get("/:id", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: req.params.id as string },
      include: {
        discoveredByIntegration:  { select: { id: true, name: true, type: true, config: true } },
        monitorCredential:        { select: { id: true, name: true, type: true } },
        responseTimeCredential:   { select: { id: true, name: true, type: true } },
        cpuMemoryCredential:      { select: { id: true, name: true, type: true } },
        temperatureCredential:    { select: { id: true, name: true, type: true } },
        interfacesCredential:     { select: { id: true, name: true, type: true } },
        lldpCredential:           { select: { id: true, name: true, type: true } },
        associatedIpRows:         { select: ASSOCIATED_IP_SELECT },
        macAddressRows:           { select: MAC_ROW_SELECT },
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
    // contains API tokens), so strip it after extracting the credential id
    // and the FMG `useProxy` toggle (the System tab badges need to know
    // whether REST API traffic rides FMG's `/sys/proxy/json` or hits the
    // FortiGate directly).
    let integrationMonitorCredential: { id: string; name: string; type: string } | null = null;
    let integrationUseProxy: boolean | null = null;
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
      // Only meaningful for FortiManager; standalone FortiGate is always direct.
      if (asset.discoveredByIntegration.type === "fortimanager") {
        integrationUseProxy = cfg.useProxy !== false;
      }
    }
    const { config: _omit, ...integrationLite } = (asset.discoveredByIntegration as { config?: unknown } | null) || {};
    const { associatedIpRows, macAddressRows, ...assetRest } = asset;
    const safeAsset = {
      ...assetRest,
      associatedIps: shapeAssociatedIps(associatedIpRows),
      macAddresses:  shapeMacRows(macAddressRows),
      discoveredByIntegration: asset.discoveredByIntegration
        ? { ...integrationLite, useProxy: integrationUseProxy }
        : null,
      integrationMonitorCredential,
    };

    res.json({ ...safeAsset, ipContext: ipCtx });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/effective-monitor-settings — fully-resolved monitor
// settings for one asset PLUS per-field tier provenance, so the asset edit
// modal can render "Asset / Class / Integration / Manual" badges next to
// each field. Read-open to any authenticated caller.
router.get("/:id/effective-monitor-settings", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: {
        id:                         true,
        assetType:                  true,
        discoveredByIntegrationId:  true,
        discoveredByIntegration:    { select: { name: true, type: true, pollInterval: true } },
        monitorIntervalSec:         true,
        cpuMemoryIntervalSec:       true,
        temperatureIntervalSec:     true,
        systemInfoIntervalSec:      true,
        probeTimeoutMs:             true,
        cpuMemoryTimeoutMs:         true,
        temperatureTimeoutMs:       true,
        systemInfoTimeoutMs:        true,
        responseTimePolling:        true,
        cpuMemoryPolling:           true,
        temperaturePolling:         true,
        interfacesPolling:          true,
        lldpPolling:                true,
        storagePolling:             true,
        responseTimeMibId:          true,
        cpuMemoryMibId:             true,
        temperatureMibId:           true,
        interfacesMibId:            true,
        lldpMibId:                  true,
        responseTimeCredentialId:   true,
        cpuMemoryCredentialId:      true,
        temperatureCredentialId:    true,
        interfacesCredentialId:     true,
        lldpCredentialId:           true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    const result = await resolveMonitorSettingsWithProvenance({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    // mibLookup: every non-null MIB UUID across the five streams, mapped to
    // its moduleName so the frontend's monitoring chips can append a "MIB:
    // <module>" segment without a second round-trip. Standard MIB ids (the
    // `std:<key>` namespace, owned entirely by the frontend) are skipped —
    // those resolve through `_SNMP_STANDARD_MIBS` in assets.js.
    const mibIds = new Set<string>();
    for (const id of [
      result.resolved.responseTimeMibId,
      result.resolved.cpuMemoryMibId,
      result.resolved.temperatureMibId,
      result.resolved.interfacesMibId,
      result.resolved.lldpMibId,
    ]) {
      if (typeof id === "string" && id && !id.startsWith("std:")) mibIds.add(id);
    }
    const mibLookup: Record<string, { moduleName: string }> = {};
    if (mibIds.size > 0) {
      const rows = await prisma.mibFile.findMany({
        where:  { id: { in: [...mibIds] } },
        select: { id: true, moduleName: true },
      });
      for (const r of rows) mibLookup[r.id] = { moduleName: r.moduleName };
    }
    // Surface the integration's name + pollInterval alongside the resolved
    // settings so the frontend can render the "integrationPollInterval"
    // provenance badge as `Inherit: 14400s (4h, from <integration> discovery
    // cycle)` without a second /integrations/:id round-trip.
    const integrationInfo = asset.discoveredByIntegration
      ? {
          id:           asset.discoveredByIntegrationId,
          name:         asset.discoveredByIntegration.name,
          type:         asset.discoveredByIntegration.type,
          pollInterval: asset.discoveredByIntegration.pollInterval,
        }
      : null;
    res.json({ ...result, mibLookup, integration: integrationInfo });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/ip-history — IP address history for an asset (all authenticated users)
router.get("/:id/ip-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string }, select: { id: true } });
    if (!asset) throw new AppError(404, "Asset not found");
    res.json(await getIpHistory(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/monitor-history?range=1h|24h|7d|30d OR ?from=ISO&to=ISO
router.get("/:id/monitor-history", requirePermission("assets", "read"), async (req, res, next) => {
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
    const pick = await pickSampleTierForAsset(id, "sample", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readMonitorHistory(id, since, until, pick.tier, fetchSince);
    res.json({
      range: rangeLabel,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
      stats: result.stats,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/:id/probe-now — run a one-off probe immediately (user or above).
// Triggers all three cadences (response-time, telemetry, system info) so the
// asset details panel refreshes everything at once instead of waiting for the
// scheduler to come around. Returns a per-stream status so the UI can tell
// the operator which streams refreshed and which failed (and why) — silent
// failures used to leave the System tab stale with no explanation.
router.post("/:id/probe-now", requirePermission("assetsProbe", "write"), async (req, res, next) => {
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
      // For AD, prefer the source's own observed.ouPath over the merged
      // learnedLocation field (which other integrations can overwrite). The
      // lookup is cheap — one row, indexed by (sourceKind, externalId)'s
      // assetId index — and only runs on AD-discovered assets.
      let adOuPath: string | null = null;
      if (filterAsset.discoveredByIntegration.type === "activedirectory") {
        const adSource = await prisma.assetSource.findFirst({
          where: { assetId: id, sourceKind: "ad" },
          select: { observed: true },
        });
        const obs = (adSource?.observed as Record<string, unknown> | null) || null;
        if (obs && typeof obs.ouPath === "string") adOuPath = obs.ouPath;
      }
      const filt = assetMatchesIntegrationFilter({ ...filterAsset, adOuPath }, filterAsset.discoveredByIntegration);
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
          telemetry:   { supported: true, collected: false, error: reason },
          temperature: { supported: true, collected: false, error: reason },
          systemInfo:  { supported: true, collected: false, error: reason },
        });
        return;
      }
    }

    // Keep flat response-time fields at the root for back-compat with anything
    // that still reads `success` / `responseTimeMs` directly.
    const probe = await probeAsset(id);
    await recordProbeResult(id, probe);

    // Telemetry (CPU/mem) and temperature dispatch independently — different
    // polling methods, credentials, MIBs, timeouts — so run them in parallel.
    // System-info is its own collector but also kicked off concurrently
    // because none of the three depend on each other's results. Each catch
    // returns a properly-typed CollectionResult so the union below has `data`
    // on every branch (TS narrowing was complaining otherwise).
    type TelResult  = Awaited<ReturnType<typeof collectTelemetry>>;
    type TempResult = Awaited<ReturnType<typeof collectTemperatures>>;
    type SysResult  = Awaited<ReturnType<typeof collectSystemInfo>>;
    const tr_p:    Promise<TelResult>  = collectTelemetry(id).catch((err: any): TelResult  => ({ supported: true, error: err?.message || "Telemetry collection failed" }));
    const tempR_p: Promise<TempResult> = collectTemperatures(id).catch((err: any): TempResult => ({ supported: true, error: err?.message || "Temperature collection failed" }));
    const sr_p:    Promise<SysResult>  = collectSystemInfo(id).catch((err: any): SysResult  => ({ supported: true, error: err?.message || "System info collection failed" }));
    const [tr, tempR, sr] = [await tr_p, await tempR_p, await sr_p];
    await Promise.all([
      recordTelemetryResult(id, tr),
      recordTemperatureResult(id, tempR),
      recordSystemInfoResult(id, sr),
    ]);
    const telemetry   = { supported: tr.supported,    collected: !!tr.data,                                       error: tr.error };
    // Temperature is "collected" when the device actually returned sensor
    // rows. An empty array (sensor-less device) is supported-but-empty —
    // surfaced as n/a rather than failure so the toast doesn't nag on devices
    // that simply don't publish temperature.
    const tempData    = Array.isArray(tempR.data) ? tempR.data : null;
    const temperature = { supported: tempR.supported, collected: !!tempData && tempData.length > 0,               error: tempR.error };
    const tempNoData  = !!(tempR.supported && tempData && tempData.length === 0);
    const systemInfo  = { supported: sr.supported,    collected: !!sr.data,                                       error: sr.error };

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
    streamSummary.push(`temperature ${temperature.collected ? "ok" : (tempNoData ? "n/a (no sensors)" : (temperature.supported ? "failed: " + (temperature.error || "no data") : "n/a"))}`);
    streamSummary.push(`interfaces ${systemInfo.collected ? "ok" : (systemInfo.supported ? "failed: " + (systemInfo.error || "no data") : "n/a")}`);
    const anyFail = !ok ||
      (telemetry.supported   && !telemetry.collected) ||
      (temperature.supported && !temperature.collected && !tempNoData) ||
      (systemInfo.supported  && !systemInfo.collected);
    logEvent({
      action: "asset.refresh",
      resourceType: "asset",
      resourceId: id,
      resourceName: asset?.hostname || asset?.ipAddress || undefined,
      actor: req.session?.username,
      level: anyFail ? "warning" : "info",
      message: `Refresh: ${label} — ${streamSummary.join("; ")}`,
      details: { probe, telemetry, temperature, systemInfo },
    });

    res.json({ ...probe, telemetry, temperature, systemInfo });
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

router.post("/:id/snmp-walk", requirePermission("assetsProbe", "write"), async (req, res, next) => {
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

/**
 * Extend `since` backwards by one bucket of lookback overflow so the chart
 * polyline has at least one sample BEFORE the visible window. The renderer
 * clips drawn content to `[since, until]` via SVG clipPath, so the extra
 * sample is hidden but its presence lets the line enter the chart from the
 * left edge instead of starting partway through. Stats stay scoped to the
 * visible window (filtered in the service). See the "Time-series chart
 * (SVG)" section of TEMPLATES.md.
 *
 *   - detail tier (bucketSeconds=0): 5-minute lookback — covers ~1-5 polls
 *     at 1m/2m/5m cadences without bloating the query.
 *   - hourly tier: one extra bucket (3600s).
 *   - daily tier:  one extra bucket (86400s).
 */
function extendSinceForLookback(since: Date, bucketSeconds: number): Date {
  const DETAIL_LOOKBACK_MS = 5 * 60 * 1000;
  const lookbackMs = bucketSeconds > 0 ? bucketSeconds * 1000 : DETAIL_LOOKBACK_MS;
  return new Date(+since - lookbackMs);
}

function bigIntToNumber(v: bigint | null | undefined): number | null {
  if (v == null) return null;
  return Number(v);
}

// GET /assets/:id/telemetry-history?range=...|from=...&to=... — CPU+memory time series
router.get("/:id/telemetry-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "telemetry", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readTelemetryHistory(id, since, until, pick.tier, fetchSince);
    res.json({
      range: rangeLabel,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
      stats: result.stats,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/system-info — latest interface + storage snapshot. Returns
// every interface row tied to the most-recent system-info scrape timestamp,
// plus the most-recent telemetry row. Used to populate the System tab grid
// without requiring the client to make three separate calls.
router.get("/:id/system-info", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: {
        id: true, monitored: true,
        lastTelemetryAt: true, lastSystemInfoAt: true,
        monitoredInterfaces: true,
        monitoredStorage: true,
        monitoredIpsecTunnels: true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    const [latestTelemetry, latestIfaceMeta, latestStorageMeta, latestTempMeta, latestIpsecMeta, lldpNeighbors, wirelessStations, inferredNeighbors] = await Promise.all([
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
      // Wireless stations connected to this AP (current-state, like LLDP).
      // Empty for non-AP assets — the table only carries rows when the
      // SNMP fapStationTable scrape ran on an `assetType="access_point"`
      // asset. matchedAsset cross-links to the connected endpoint when the
      // station's MAC resolved against the inventory.
      prisma.assetWirelessStation.findMany({
        where: { apAssetId: id },
        orderBy: [{ ssid: "asc" }, { staMacAddr: "asc" }],
        include: {
          matchedAsset: {
            select: { id: true, hostname: true, ipAddress: true, assetType: true },
          },
        },
      }),
      // Peer-inferred neighbors synthesized from Asset.fortinetTopology
      // (managed FortiAPs reported via FortiGate, FortiSwitch FortiLink
      // uplinks, etc.). Real LLDP rows take precedence on collision —
      // dedupe by (localIfName, matchedAssetId) below.
      buildInferredNeighborsForAsset(id),
    ]);
    const mergedNeighbors = [
      ...lldpNeighbors,
      ...dedupeInferredNeighbors(lldpNeighbors, inferredNeighbors),
    ];

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
      lastTelemetryAt: asset.lastTelemetryAt,
      lastTemperatureAt: latestTempMeta?.timestamp ?? null,
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
        nativeVlan:     i.nativeVlan  ?? null,
        taggedVlans:    i.taggedVlans ?? [],
        trunksAllVlans: i.trunksAllVlans === true,
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
      lldpNeighbors: mergedNeighbors.map((n) => ({
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
      wirelessStations: wirelessStations.map((w) => ({
        staMacAddr:     w.staMacAddr,
        staIpAddr:      w.staIpAddr,
        ssid:           w.ssid,
        radioId:        w.radioId,
        wlanId:         w.wlanId,
        band:           w.band,
        vlanId:         w.vlanId,
        bssid:          w.bssid,
        signalStrength: w.signalStrength,
        noise:          w.noise,
        bandwidthTx:    w.bandwidthTx,
        bandwidthRx:    w.bandwidthRx,
        idleSeconds:    w.idleSeconds,
        source:         w.source,
        firstSeen:      w.firstSeen,
        lastSeen:       w.lastSeen,
        matchedAsset:   w.matchedAsset
          ? {
              id:        w.matchedAsset.id,
              hostname:  w.matchedAsset.hostname,
              ipAddress: w.matchedAsset.ipAddress,
              assetType: w.matchedAsset.assetType,
            }
          : null,
      })),
      monitoredInterfaces:   (asset.monitoredInterfaces   ?? []) as string[],
      monitoredStorage:      (asset.monitoredStorage      ?? []) as string[],
      monitoredIpsecTunnels: (asset.monitoredIpsecTunnels ?? []) as string[],
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/custom-widgets — Custom MIB tab data (Slice 7). Resolves
// the asset's manufacturer profile, filters widgets by optional modelPattern,
// and returns each widget's definition plus its latest sample (kind = "scalar"
// returns the most recent point; kind = "line" / "table" returns a window of
// recent samples that the gauge / chart / table renderer consumes directly).
// Empty array when the manufacturer has no widgets or the polling stream is
// resolved to "disabled" — the frontend hides the tab in that case.
router.get("/:id/custom-widgets", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where:  { id },
      select: {
        id: true, monitored: true, manufacturer: true, model: true,
        customWidgetPolling: true, lastCustomWidgetAt: true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    // The DB-backed profile cache is keyed by canonical manufacturer.
    const { getProfileFor } = await import("../../services/manufacturerProfileService.js");
    const profile = getProfileFor(asset.manufacturer);
    if (!profile || profile.widgets.length === 0) {
      return res.json({
        manufacturer:    asset.manufacturer,
        profileId:       profile?.id ?? null,
        polling:         asset.customWidgetPolling ?? null,
        lastCustomWidgetAt: asset.lastCustomWidgetAt,
        widgets:         [],
      });
    }

    // Apply per-model gating. Empty modelPattern = applies to every asset
    // under the manufacturer; non-empty regex must match Asset.model.
    const modelStr = asset.model ?? "";
    const applicableWidgets = profile.widgets.filter((w) => {
      if (!w.modelPattern) return true;
      try { return new RegExp(w.modelPattern, "i").test(modelStr); }
      catch { return false; }
    });

    if (applicableWidgets.length === 0) {
      return res.json({
        manufacturer:    asset.manufacturer,
        profileId:       profile.id,
        polling:         asset.customWidgetPolling ?? null,
        lastCustomWidgetAt: asset.lastCustomWidgetAt,
        widgets:         [],
      });
    }

    // Bulk-fetch the last 60 samples per widget — line charts need a window;
    // gauges + tables grab the freshest. One query covering every applicable
    // widget id, then partition client-side.
    const ids = applicableWidgets.map((w) => w.id);
    const samples = await prisma.assetCustomWidgetSample.findMany({
      where: { assetId: id, widgetId: { in: ids } },
      orderBy: { timestamp: "desc" },
      take:    60 * ids.length,
      select:  { id: true, widgetId: true, timestamp: true, kind: true, value: true },
    });
    const byWidget = new Map<string, typeof samples>();
    for (const s of samples) {
      const arr = byWidget.get(s.widgetId) ?? [];
      if (arr.length < 60) arr.push(s);
      byWidget.set(s.widgetId, arr);
    }

    return res.json({
      manufacturer:    asset.manufacturer,
      profileId:       profile.id,
      polling:         asset.customWidgetPolling ?? null,
      lastCustomWidgetAt: asset.lastCustomWidgetAt,
      widgets: applicableWidgets.map((w) => {
        const window = byWidget.get(w.id) ?? [];
        // Reverse so caller gets oldest-first for charts.
        window.reverse();
        return {
          id:             w.id,
          name:           w.name,
          symbol:         w.symbol,
          mibId:          w.mibId,
          type:           w.type,
          widgetType:     w.widgetType,
          transform:      w.transform,
          displayOptions: w.displayOptions,
          order:          w.order,
          modelPattern:   w.modelPattern,
          samples:        window,
          latest:         window.length ? window[window.length - 1] : null,
        };
      }),
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/interface-history?ifName=...&range=... — per-interface counters
router.get("/:id/interface-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const ifName = req.query.ifName ? String(req.query.ifName) : null;
    if (!ifName) throw new AppError(400, "ifName query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "systemInfo", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);

    // Samples come from the tier-aware reader. LLDP neighbors and the
    // operator-typed comment override are stream-independent — both fetch
    // in parallel against the asset directly, not against the rollup
    // tables. The reader's meta carries the discovered alias/description
    // from the latest sample inside the requested window so the slide-over
    // header reflects what was configured during that window; the
    // operator-typed override (Polaris-local) takes precedence for the
    // resolved `description` field shown in the UI.
    const [history, override, neighbors, inferredAll] = await Promise.all([
      readInterfaceHistory(id, since, until, pick.tier, ifName, fetchSince),
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
      // Peer-inferred neighbors for the whole asset, filtered to this
      // interface below. Cheap enough at branch-class fleet sizes that
      // a per-interface query isn't worth the extra surface area on the
      // service.
      buildInferredNeighborsForAsset(id),
    ]);
    const inferredForIf = inferredAll.filter((n) => n.localIfName === ifName);
    const mergedNeighbors = [
      ...neighbors,
      ...dedupeInferredNeighbors(neighbors, inferredForIf),
    ];
    const overrideDescription = override?.description ?? null;
    res.json({
      range: rangeLabel,
      ifName,
      alias:       history.meta.alias,
      description: overrideDescription ?? history.meta.discoveredDescription,
      discoveredDescription: history.meta.discoveredDescription,
      overrideDescription,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: history.samples,
      lldpNeighbors: mergedNeighbors.map((n) => ({
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
router.put("/:id/interfaces/:ifName/comment", requirePermission("assets", "write"), async (req, res, next) => {
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
router.get("/:id/temperature-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const sensorName = req.query.sensorName ? String(req.query.sensorName) : null;
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "telemetry", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readTemperatureHistory(id, since, until, pick.tier, sensorName, fetchSince);
    res.json({
      range: rangeLabel,
      sensorName,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
      stats: result.stats,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/ipsec-history?tunnelName=...&range=... — per-tunnel state + bytes
router.get("/:id/ipsec-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const tunnelName = req.query.tunnelName ? String(req.query.tunnelName) : null;
    if (!tunnelName) throw new AppError(400, "tunnelName query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "systemInfo", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readIpsecHistory(id, since, until, pick.tier, tunnelName, fetchSince);
    res.json({
      range: rangeLabel,
      tunnelName,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/storage-history?mountPath=...&range=... — per-mountpoint usage
router.get("/:id/storage-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const mountPath = req.query.mountPath ? String(req.query.mountPath) : null;
    if (!mountPath) throw new AppError(400, "mountPath query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "systemInfo", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readStorageHistory(id, since, until, pick.tier, mountPath, fetchSince);
    res.json({
      range: rangeLabel,
      mountPath,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets — create (assets admin)
router.post("/", requirePermission("assets", "write"), async (req, res, next) => {
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
router.put("/:id", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.asset.findUnique({
      where:   { id },
      include: { discoveredByIntegration: { select: { type: true } } },
    });
    if (!existing) throw new AppError(404, "Asset not found");
    const input = UpdateAssetSchema.parse(req.body);
    // Per-asset polling overrides must be valid for the asset's source kind.
    // Falling through silently at the resolver would leave the operator
    // confused about why their selection didn't take.
    {
      const sourceKind = assetSourceKindFromIntegrationType(existing.discoveredByIntegration?.type ?? null);
      const fields: Array<["responseTimePolling" | "cpuMemoryPolling" | "temperaturePolling" | "interfacesPolling" | "lldpPolling" | "storagePolling", PollingMethod | null | undefined]> = [
        ["responseTimePolling", input.responseTimePolling],
        ["cpuMemoryPolling",    input.cpuMemoryPolling],
        ["temperaturePolling",  input.temperaturePolling],
        ["interfacesPolling",   input.interfacesPolling],
        ["lldpPolling",         input.lldpPolling],
        ["storagePolling",      input.storagePolling],
      ];
      for (const [name, value] of fields) {
        if (!value) continue;
        if (!isPollingMethodCompatible(sourceKind, value)) {
          throw new AppError(
            400,
            `${pollingMethodLabel(value)} polling is not supported for ${sourceKind} assets (field: ${name})`,
          );
        }
      }
    }
    // Lock assetType on Fortinet infrastructure discovered via an integration.
    // The next discovery cycle would re-stamp the asset anyway, so accepting
    // the change just to revert it is misleading.
    if (
      input.assetType !== undefined &&
      input.assetType !== existing.assetType &&
      existing.discoveredByIntegrationId &&
      (existing.assetType === "firewall" || existing.assetType === "switch" || existing.assetType === "access_point")
    ) {
      throw new AppError(400, `Asset type is locked — discovered as ${existing.assetType} by an integration`);
    }
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
    clampMonitoredState(data);
    clampAcquiredToLastSeen(data, existing);
    const asset = await prisma.asset.update({ where: { id }, data: data as any });
    // When the operator's `monitored` choice changes (or assetType changes,
    // which moves the asset into a different per-class block), recompute
    // monitorOverride against the discovering integration's addAsMonitored.
    // A single SQL UPDATE handles the JSON-path lookup in one round-trip.
    if (input.monitored !== undefined || input.assetType !== undefined) {
      await recomputeMonitorOverrideForAssets(prisma, [id]);
    }
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
router.post("/dns-lookup", requirePermission("assets", "write"), async (req, res, next) => {
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
    // Iterate every active asset_associated_ips row directly (the side table is
    // smaller than the asset table, so this is cheaper than the per-asset
    // findMany + array merge loop the JSONB version did). Per-row PTR refresh
    // hits an `update` only when something actually changed; ON CONFLICT
    // semantics aren't relevant here because each row already has a stable id.
    const assocRows = await prisma.assetAssociatedIp.findMany({
      where: { asset: { status: { notIn: ["decommissioned", "disabled"] } } },
      select: { id: true, ip: true, ptrName: true, ptrTtl: true, ptrFetchedAt: true },
    });

    let assocResolved = 0;
    let assocSkipped = 0;
    for (const row of assocRows) {
      if (!row.ip) continue;
      const fetchedAtIso = row.ptrFetchedAt ? row.ptrFetchedAt.toISOString() : null;
      if (!isPtrExpired(fetchedAtIso, row.ptrTtl, now)) { assocSkipped++; continue; }
      const ptrFetchedAt = new Date();
      try {
        const records = await resolver.reverse(row.ip);
        if (records.length > 0) {
          assocResolved++;
          await prisma.assetAssociatedIp.update({
            where: { id: row.id },
            data: { ptrName: records[0].name, ptrTtl: records[0].ttl, ptrFetchedAt },
          });
          continue;
        }
      } catch {}
      // Negative cache — preserve any existing ptrName, clear ttl, stamp fetchedAt
      await prisma.assetAssociatedIp.update({
        where: { id: row.id },
        data: { ptrTtl: null, ptrFetchedAt },
      });
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
router.post("/:id/dns-lookup", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: req.params.id as string },
      include: { associatedIpRows: { select: { id: true, ip: true, ptrName: true } } },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    const assocRows = asset.associatedIpRows;
    if (!asset.ipAddress && assocRows.length === 0) throw new AppError(400, "Asset has no IP address");

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

    // PTR for each associated IP — always re-query on single-asset lookup.
    // One DB write per row (small batches; this is a manual-action endpoint
    // so we're not in a hot path). $transaction packs the per-row updates
    // into a single round-trip so the cost stays low even for assets with
    // dozens of associated IPs.
    let assocResolved = 0;
    const assocUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const row of assocRows) {
      if (!row.ip) continue;
      const ptrFetchedAt = new Date();
      try {
        const records = await resolver.reverse(row.ip);
        if (records.length > 0) {
          assocResolved++;
          assocUpdates.push({ id: row.id, data: { ptrName: records[0].name, ptrTtl: records[0].ttl, ptrFetchedAt } });
          continue;
        }
      } catch {}
      assocUpdates.push({ id: row.id, data: { ptrTtl: null, ptrFetchedAt } });
    }
    if (assocUpdates.length > 0) {
      await prisma.$transaction(assocUpdates.map((u) =>
        prisma.assetAssociatedIp.update({ where: { id: u.id }, data: u.data }),
      ));
    }

    const updateData: Record<string, unknown> = {
      dnsName,
      dnsNameFetchedAt: fetchedAt,
      dnsNameTtl,
    };
    await prisma.asset.update({ where: { id: asset.id }, data: updateData });

    if (!dnsName && assocResolved === 0) {
      const testedIp = asset.ipAddress || assocRows[0]?.ip;
      return res.json({ ok: false, message: `No PTR records found for ${testedIp}${assocRows.length > 1 ? " or its associated IPs" : ""}` });
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
router.post("/:id/forward-lookup", requirePermission("assets", "write"), async (req, res, next) => {
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
router.post("/oui-lookup", requirePermission("assets", "write"), async (req, res, next) => {
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
router.post("/:id/oui-lookup", requirePermission("assets", "write"), async (req, res, next) => {
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
router.post("/import", requirePermission("assets", "write"), async (req, res, next) => {
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
router.post("/import-pdf", requirePermission("assets", "write"), async (req, res, next) => {
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
router.delete("/:id/macs/:mac", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const normalized = String(req.params.mac || "").toUpperCase().replace(/-/g, ":");

    const existing = await prisma.asset.findUnique({
      where: { id },
      include: { macAddressRows: { select: MAC_ROW_SELECT } },
    });
    if (!existing) throw new AppError(404, "Asset not found");

    const allRows = existing.macAddressRows;
    const target = allRows.find((m) => m.mac.toUpperCase().replace(/-/g, ":") === normalized);
    if (!target) {
      throw new AppError(404, "MAC address not found on this asset");
    }

    // Compute the new primary `Asset.macAddress` scalar after removal:
    // most-recently-seen surviving MAC, or null if the deleted MAC was the
    // last one. Side-table delete + scalar-column update run as a single
    // transaction so the asset never points at a MAC that no longer exists.
    let primary = existing.macAddress;
    if (primary && primary.toUpperCase().replace(/-/g, ":") === normalized) {
      const survivors = allRows.filter((m) => m.mac !== target.mac);
      survivors.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
      primary = survivors[0]?.mac ?? null;
    }

    const [, updated] = await prisma.$transaction([
      prisma.assetMacAddress.deleteMany({
        where: { assetId: id, mac: target.mac },
      }),
      prisma.asset.update({
        where: { id },
        data: { macAddress: primary },
      }),
    ]);

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
router.delete("/", requirePermission("assets", "write"), async (req, res, next) => {
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
router.delete("/:id", requirePermission("assets", "write"), async (req, res, next) => {
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
router.get("/sighting-settings", requirePermission("assetsQuarantine", "read"), async (_req, res, next) => {
  try {
    res.json(await getSightingSettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/sighting-settings — admin or assets admin
router.put("/sighting-settings", requirePermission("assetsQuarantine", "write"), async (req, res, next) => {
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
// Each sighting is decorated with subnet name + VLAN resolved from the stored
// IP against subnets discovered on the same FortiGate, so the Quarantine tab
// can show "what was seen and on which VLAN" without a second round-trip.
router.get("/:id/sightings", requirePermission("assetsQuarantine", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const exists = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new AppError(404, "Asset not found");
    const sightings = await getSightingsForAsset(id);

    const devices = Array.from(
      new Set(sightings.map((s) => s.fortigateDevice).filter(Boolean)),
    );
    const subnets = devices.length
      ? await prisma.subnet.findMany({
          where: { fortigateDevice: { in: devices } },
          select: { cidr: true, name: true, vlan: true, fortigateDevice: true },
        })
      : [];

    const enriched = sightings.map((s) => {
      let subnetName: string | null = null;
      let vlan: number | null = null;
      if (s.ipAddress) {
        const match = subnets.find(
          (sub) =>
            sub.fortigateDevice === s.fortigateDevice &&
            cidrContains(sub.cidr, `${s.ipAddress}/32`),
        );
        if (match) {
          subnetName = match.name ?? null;
          vlan = match.vlan ?? null;
        }
      }
      return { ...s, subnetName, vlan };
    });

    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/sources — per-discovery-source view of an asset
// (Phase 3a of the multi-source asset model). Returns every AssetSource row
// for this asset with the originating integration's name + type joined in,
// sorted by sourceKind in a stable presentation order. Drives the "Sources"
// tab on the asset details modal — operators can see what each integration
// independently said, side-by-side.
router.get("/:id/sources", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const exists = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new AppError(404, "Asset not found");

    const rows = await prisma.assetSource.findMany({
      where: { assetId: id },
      include: { integration: { select: { id: true, name: true, type: true } } },
      orderBy: [{ sourceKind: "asc" }, { lastSeen: "desc" }],
    });

    // Stable presentation order — identity-first, manual last.
    const ORDER: Record<string, number> = {
      "entra": 1,
      "intune": 2,
      "ad": 3,
      "fortigate-firewall": 4,
      "fortiswitch": 5,
      "fortiap": 6,
      "fortigate-endpoint": 7,
      "manual": 99,
    };
    rows.sort((a, b) => {
      const ai = ORDER[a.sourceKind] ?? 50;
      const bi = ORDER[b.sourceKind] ?? 50;
      if (ai !== bi) return ai - bi;
      return (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0);
    });

    // Collapse rows that are the "same source" but split across multiple
    // AssetSource rows because the device's identity key churned. The worst
    // offender is `fortigate-endpoint`, whose externalId is the endpoint MAC —
    // a MAC change spawns a fresh source row and leaves the old one behind, so
    // the same integration would render as several near-identical cards. We
    // key dedup on (sourceKind, integrationId) and keep the most recent row
    // (rows are already lastSeen-desc within each sourceKind from the sort
    // above). The serial/GUID-keyed kinds (fortigate-firewall/switch/ap, ad,
    // entra, intune) have stable externalIds and so never collapse. The
    // dropped MAC history is still visible in the Firewall Sightings and IP
    // History tables on the same Sources tab.
    const seen = new Set<string>();
    const deduped = rows.filter((r) => {
      const key = `${r.sourceKind} ${r.integrationId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json(
      deduped.map((r) => ({
        id: r.id,
        sourceKind: r.sourceKind,
        externalId: r.externalId,
        integration: r.integration ? { id: r.integration.id, name: r.integration.name, type: r.integration.type } : null,
        observed: r.observed,
        inferred: r.inferred,
        syncedAt: r.syncedAt,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/sources/:sourceId/split — admin recovery action
// (Phase 3a of the multi-source asset model). Detaches one AssetSource row
// from this asset and binds it to a freshly-created Asset, with the new
// Asset's discovery-owned fields seeded from the source's `observed` blob.
//
// Use case: a phase-1 backfill or hostname-collision conflict accept merged
// two devices into one Asset by mistake; the operator pulls the wrong source
// off and now has two correctly-separated Assets. Today's only fix without
// this endpoint is hand-editing the assetSources table.
//
// Refusal rules:
//   - Source not found, or doesn't belong to this asset → 404
//   - Source is the asset's only source — splitting would leave the original
//     Asset orphaned with no sources → 409. Operator should delete the
//     misclassified Asset instead and let the next discovery recreate it.
//   - Source is a "manual" source kind — that's a phase-1 backfill marker,
//     not a real discovery source; nothing useful to detach → 409.
//
// Asset-row FKs (monitoring samples, IP history, sightings, quarantine,
// conflicts) all stay on the *original* Asset.id. Only the AssetSource row
// moves; the new Asset starts clean (operator can configure monitoring etc.
// on it from scratch).
const splitSourceParamsSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
});
router.post("/:id/sources/:sourceId/split", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const { id, sourceId } = splitSourceParamsSchema.parse(req.params);
    const originalAsset = await prisma.asset.findUnique({ where: { id }, select: { id: true, hostname: true } });
    if (!originalAsset) throw new AppError(404, "Asset not found");

    const allSources = await prisma.assetSource.findMany({ where: { assetId: id } });
    const target = allSources.find((s) => s.id === sourceId);
    if (!target) throw new AppError(404, "Source not found on this asset");
    if (target.sourceKind === "manual") {
      throw new AppError(409, "Cannot split a manual source — it's a backfill marker, not a discovery source");
    }
    if (allSources.length <= 1) {
      throw new AppError(409, "Cannot split the asset's only source. Delete the asset instead and let discovery recreate it.");
    }

    // Project the discovery-owned fields from the moved source alone — that's
    // the new Asset's seed data.
    const { projected } = projectAssetFromSources([
      { sourceKind: target.sourceKind, inferred: target.inferred, observed: target.observed as Record<string, unknown> | null },
    ]);

    // assetType per source kind. Phase 4d: assetTag is no longer set here —
    // the AssetSource row that this split path detaches from the original
    // asset (and re-binds to the new asset just below) carries the
    // canonical identity link via (sourceKind, externalId). The legacy
    // entra:/ad:/fgt: prefixes were back-compat markers that re-discovery
    // already stopped consulting in Phase 2.
    let assetType: "firewall" | "switch" | "access_point" | "workstation" | "other" = "other";
    const tagSet = new Set<string>(["split-from-asset", "auto-discovered"]);
    if (target.sourceKind === "entra") {
      assetType = "workstation";
      tagSet.add("entraid");
    } else if (target.sourceKind === "intune") {
      assetType = "workstation";
      tagSet.add("entraid");
      tagSet.add("intune");
    } else if (target.sourceKind === "ad") {
      assetType = "workstation";
      tagSet.add("activedirectory");
    } else if (target.sourceKind === "fortigate-firewall") {
      assetType = "firewall";
      tagSet.add("fortigate");
    } else if (target.sourceKind === "fortiswitch") {
      assetType = "switch";
      tagSet.add("fortiswitch");
    } else if (target.sourceKind === "fortiap") {
      assetType = "access_point";
      tagSet.add("fortiap");
    }

    // Manufacturer fallback — projection only gives "Fortinet" for fortinet
    // sources; AD/Entra don't carry hardware vendor on their own.
    const manufacturer = projected.manufacturer ?? (assetType === "firewall" || assetType === "switch" || assetType === "access_point" ? "Fortinet" : null);

    const newAssetData: Record<string, unknown> = {
      hostname: projected.hostname,
      assetType,
      status: "active",
      statusChangedAt: new Date(),
      statusChangedBy: req.session?.username || "system",
      os: projected.os,
      osVersion: projected.osVersion,
      serialNumber: projected.serialNumber,
      manufacturer,
      model: projected.model,
      learnedLocation: projected.learnedLocation,
      ipAddress: projected.ipAddress,
      latitude: projected.latitude,
      longitude: projected.longitude,
      tags: Array.from(tagSet),
      notes: `Split from asset ${originalAsset.hostname || originalAsset.id} — ${target.sourceKind} source detached on ${new Date().toISOString()}`,
      ...(target.integrationId ? { discoveredByIntegrationId: target.integrationId } : {}),
      createdBy: req.session?.username || null,
    };

    // Two-step: create the new Asset, then re-bind the source row. Done in a
    // transaction so we never leave an orphan AssetSource pointing at a
    // never-created Asset on partial failure.
    const result = await prisma.$transaction(async (tx) => {
      const newAsset = await tx.asset.create({ data: newAssetData as any });
      await tx.assetSource.update({
        where: { id: target.id },
        data: { assetId: newAsset.id },
      });
      return { newAsset };
    });

    logEvent({
      action: "asset.split",
      resourceType: "asset",
      resourceId: id,
      resourceName: originalAsset.hostname || undefined,
      actor: req.session?.username,
      level: "info",
      message: `Split ${target.sourceKind} source (externalId ${target.externalId}) off asset ${originalAsset.hostname || id} → new asset ${result.newAsset.id}`,
      details: {
        originalAssetId: id,
        newAssetId: result.newAsset.id,
        sourceId: target.id,
        sourceKind: target.sourceKind,
        externalId: target.externalId,
      },
    });

    res.json({
      originalAssetId: id,
      newAssetId: result.newAsset.id,
      movedSourceId: target.id,
      newAsset: result.newAsset,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Dependency-aware monitoring suppression ────────────────────────────────
//
// Three endpoints over `AssetDependencyParent`:
//   GET    /:id/dependencies                — read effective + computed
//                                             parents, layer, suppressed flag
//   PUT    /:id/dependencies/override       — admin: replace source="override"
//                                             rows; empty array = explicit
//                                             "no parents" pin
//   DELETE /:id/dependencies/override       — admin: clear all overrides;
//                                             computed set takes effect
//
// Effective-parents resolution: if any source="override" rows exist for an
// asset, the override set is its effective parents and the computed set is
// ignored. Empty override set is a deliberate pin (asset opts out of
// suppression entirely) and is distinct from "no override at all" — we
// represent it by writing zero override rows but stamping a marker. To keep
// the data model simple we don't use a separate marker column; instead the
// override endpoint is the SOLE way to write "0 overrides" without computed
// fallback. So the resolution rule is "if the operator most recently called
// PUT /override, the override set wins (even if empty)". The DELETE endpoint
// reverts to computed.
//
// Cycles are rejected at write time: walking back through every proposed
// parent's existing parents must never reach the asset itself.

const dependencyOverrideBodySchema = z.object({
  parentAssetIds: z.array(z.string().min(1)).max(20),
});

router.get("/:id/dependencies", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: {
        id: true,
        hostname: true,
        assetType: true,
        monitorStatus: true,
        monitored: true,
        dependencyLayer: true,
        dependencySuppressed: true,
        dependencySuppressedAt: true,
        dependencyTestUntil: true,
        dependencyTestStartedBy: true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    const rows = await prisma.assetDependencyParent.findMany({
      where: { assetId: id },
      include: {
        parent: {
          select: {
            id: true,
            hostname: true,
            assetType: true,
            dependencyLayer: true,
            monitorStatus: true,
            monitored: true,
            dependencyTestUntil: true,
          },
        },
      },
      orderBy: [{ source: "asc" }, { createdAt: "asc" }],
    });

    function shape(r: (typeof rows)[number]) {
      return {
        id: r.id,
        parent: r.parent
          ? {
              id:                  r.parent.id,
              hostname:            r.parent.hostname,
              assetType:           r.parent.assetType,
              dependencyLayer:     r.parent.dependencyLayer,
              monitorStatus:       r.parent.monitorStatus,
              monitored:           r.parent.monitored,
              dependencyTestUntil: r.parent.dependencyTestUntil,
            }
          : null,
        source:      r.source,
        detectedVia: r.detectedVia,
      };
    }

    const computedParents = rows.filter(r => r.source === "computed").map(shape);
    const overrideParents = rows.filter(r => r.source === "override").map(shape);
    // When at least one override row exists, the override set is the effective
    // set (even if it ends up filtering down to the same parents as computed).
    const hasOverride = overrideParents.length > 0;
    const effectiveParents = hasOverride ? overrideParents : computedParents;

    // Direct children — every asset that has THIS asset as one of its
    // EFFECTIVE parents. We pull every asset_dependency_parents row pointing
    // at this id, then resolve each child's effective-parent rule (override
    // wins when present) to filter out children that pin this asset only via
    // their computed set when an override has since replaced it.
    const childRows = await prisma.assetDependencyParent.findMany({
      where: { parentAssetId: id },
      include: {
        asset: {
          select: {
            id: true,
            hostname: true,
            assetType: true,
            dependencyLayer: true,
            monitorStatus: true,
            monitored: true,
            dependencySuppressed: true,
            dependencyTestUntil: true,
          },
        },
      },
      orderBy: [{ source: "asc" }, { createdAt: "asc" }],
    });
    // For each candidate child, ask "does this child have any override row?"
    // — if yes, only the override row counts as binding; if no, only the
    // computed row counts. Same resolution rule as the parents view.
    const childIds = [...new Set(childRows.map(r => r.assetId))];
    const childOverrideMap = new Map<string, boolean>();
    if (childIds.length > 0) {
      const childOverrides = await prisma.assetDependencyParent.findMany({
        where: { assetId: { in: childIds }, source: "override" },
        select: { assetId: true },
      });
      for (const r of childOverrides) childOverrideMap.set(r.assetId, true);
    }
    const seenChildIds = new Set<string>();
    const children = [];
    for (const r of childRows) {
      const childHasOverride = childOverrideMap.get(r.assetId) === true;
      const isBinding = childHasOverride ? r.source === "override" : r.source === "computed";
      if (!isBinding) continue;
      if (seenChildIds.has(r.assetId)) continue; // dedupe if a child pins us via both computed AND override
      seenChildIds.add(r.assetId);
      children.push({
        id:                  r.asset.id,
        hostname:            r.asset.hostname,
        assetType:           r.asset.assetType,
        dependencyLayer:     r.asset.dependencyLayer,
        monitorStatus:       r.asset.monitorStatus,
        monitored:           r.asset.monitored,
        dependencySuppressed: r.asset.dependencySuppressed,
        dependencyTestUntil: r.asset.dependencyTestUntil,
        source:              r.source,
        detectedVia:         r.detectedVia,
      });
    }
    // Stable display order: type (firewall→switch→ap→other), then hostname.
    const TYPE_ORDER: Record<string, number> = { firewall: 1, switch: 2, access_point: 3 };
    children.sort((a, b) => {
      const ta = TYPE_ORDER[a.assetType] ?? 99;
      const tb = TYPE_ORDER[b.assetType] ?? 99;
      if (ta !== tb) return ta - tb;
      return (a.hostname || "").localeCompare(b.hostname || "");
    });

    // One additional layer down (grandchildren) so the asset details modal can
    // render firewall → switch → AP without click-through. Same binding rule
    // as direct children: a grandchild is bound to its parent via override
    // when any override exists for the grandchild, else via computed.
    const grandchildrenByParent = new Map<string, typeof children>();
    const childIdSet = children.map(c => c.id);
    if (childIdSet.length > 0) {
      const gcRows = await prisma.assetDependencyParent.findMany({
        where: { parentAssetId: { in: childIdSet } },
        include: {
          asset: {
            select: {
              id: true,
              hostname: true,
              assetType: true,
              dependencyLayer: true,
              monitorStatus: true,
              monitored: true,
              dependencySuppressed: true,
              dependencyTestUntil: true,
            },
          },
        },
        orderBy: [{ source: "asc" }, { createdAt: "asc" }],
      });
      const gcIds = [...new Set(gcRows.map(r => r.assetId))];
      const gcOverrideMap = new Map<string, boolean>();
      if (gcIds.length > 0) {
        const gcOverrides = await prisma.assetDependencyParent.findMany({
          where: { assetId: { in: gcIds }, source: "override" },
          select: { assetId: true },
        });
        for (const r of gcOverrides) gcOverrideMap.set(r.assetId, true);
      }
      // Dedupe per (parentId, childId) so an MCLAG pair doesn't render twice
      // under one parent.
      const seenGc = new Set<string>();
      for (const r of gcRows) {
        const gcHasOverride = gcOverrideMap.get(r.assetId) === true;
        const isBinding = gcHasOverride ? r.source === "override" : r.source === "computed";
        if (!isBinding) continue;
        const dedupeKey = r.parentAssetId + "|" + r.assetId;
        if (seenGc.has(dedupeKey)) continue;
        seenGc.add(dedupeKey);
        const list = grandchildrenByParent.get(r.parentAssetId) ?? [];
        list.push({
          id:                  r.asset.id,
          hostname:            r.asset.hostname,
          assetType:           r.asset.assetType,
          dependencyLayer:     r.asset.dependencyLayer,
          monitorStatus:       r.asset.monitorStatus,
          monitored:           r.asset.monitored,
          dependencySuppressed: r.asset.dependencySuppressed,
          dependencyTestUntil: r.asset.dependencyTestUntil,
          source:              r.source,
          detectedVia:         r.detectedVia,
        });
        grandchildrenByParent.set(r.parentAssetId, list);
      }
      for (const list of grandchildrenByParent.values()) {
        list.sort((a, b) => {
          const ta = TYPE_ORDER[a.assetType] ?? 99;
          const tb = TYPE_ORDER[b.assetType] ?? 99;
          if (ta !== tb) return ta - tb;
          return (a.hostname || "").localeCompare(b.hostname || "");
        });
      }
    }
    const childrenWithGrandchildren = children.map(c => ({
      ...c,
      grandchildren: grandchildrenByParent.get(c.id) ?? [],
    }));

    res.json({
      asset: {
        id:                      asset.id,
        hostname:                asset.hostname,
        assetType:               asset.assetType,
        monitorStatus:           asset.monitorStatus,
        monitored:               asset.monitored,
        dependencyLayer:         asset.dependencyLayer,
        dependencySuppressed:    asset.dependencySuppressed,
        dependencySuppressedAt:  asset.dependencySuppressedAt,
        dependencyTestUntil:     asset.dependencyTestUntil,
        dependencyTestStartedBy: asset.dependencyTestStartedBy,
      },
      effectiveParents,
      computedParents,
      overrideParents,
      hasOverride,
      children: childrenWithGrandchildren,
    });
  } catch (err) {
    next(err);
  }
});

router.put("/:id/dependencies/override", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const body = dependencyOverrideBodySchema.parse(req.body);

    const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true, hostname: true } });
    if (!asset) throw new AppError(404, "Asset not found");

    const proposedParentIds = [...new Set(body.parentAssetIds)];

    // Reject self-reference up front.
    if (proposedParentIds.includes(id)) {
      throw new AppError(400, "An asset cannot be its own dependency parent");
    }

    // Validate every proposed parent exists and is a Fortinet infra asset
    // (firewall / switch / access_point) — anything else doesn't belong in the
    // dependency tree.
    if (proposedParentIds.length > 0) {
      const proposed = await prisma.asset.findMany({
        where: { id: { in: proposedParentIds } },
        select: { id: true, assetType: true, hostname: true },
      });
      if (proposed.length !== proposedParentIds.length) {
        throw new AppError(400, "One or more proposed parent assets not found");
      }
      const wrongType = proposed.filter(p => !["firewall", "switch", "access_point"].includes(p.assetType));
      if (wrongType.length > 0) {
        throw new AppError(
          400,
          `Dependency parents must be firewall/switch/access_point: ${wrongType.map(p => p.hostname || p.id).join(", ")}`,
        );
      }

      // Cycle check: from each proposed parent, walk UP through that parent's
      // existing effective parents. If we ever reach `id`, the override would
      // form a cycle.
      const allEdges = await prisma.assetDependencyParent.findMany({
        select: { assetId: true, parentAssetId: true, source: true },
      });
      // Bucket override vs computed; the asset whose parents we walk uses its
      // own override set when present, otherwise the computed set — same as
      // the runtime resolver.
      const overrideByChild = new Map<string, string[]>();
      const computedByChild = new Map<string, string[]>();
      for (const e of allEdges) {
        const m = e.source === "override" ? overrideByChild : computedByChild;
        const cur = m.get(e.assetId);
        if (cur) cur.push(e.parentAssetId);
        else m.set(e.assetId, [e.parentAssetId]);
      }
      function effectiveParentsOf(child: string): string[] {
        const o = overrideByChild.get(child);
        if (o) return o;
        return computedByChild.get(child) ?? [];
      }
      const visited = new Set<string>();
      const queue = [...proposedParentIds];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur === id) {
          throw new AppError(400, "Proposed override would form a dependency cycle");
        }
        if (visited.has(cur)) continue;
        visited.add(cur);
        // Climb. NOTE: we walk current effective parents, treating this asset's
        // proposed override as not-yet-applied; since cur cannot equal `id`
        // (we just checked), we never need the proposed set itself in the walk.
        const climb = effectiveParentsOf(cur);
        for (const p of climb) queue.push(p);
      }
    }

    // Atomic replace: delete current override rows for this child, then insert
    // the new set. createMany skipDuplicates handles the case where one of the
    // proposed parents already shows up in the computed set.
    await prisma.$transaction(async (tx) => {
      await tx.assetDependencyParent.deleteMany({
        where: { assetId: id, source: "override" },
      });
      if (proposedParentIds.length > 0) {
        await tx.assetDependencyParent.createMany({
          data: proposedParentIds.map(parentId => ({
            assetId:       id,
            parentAssetId: parentId,
            source:        "override",
            detectedVia:   "manual",
          })),
          skipDuplicates: true,
        });
      }
    });

    logEvent({
      action:       "asset.dependency.override_set",
      resourceType: "asset",
      resourceId:   id,
      resourceName: asset.hostname || undefined,
      level:        "info",
      message:      `Dependency override set on ${asset.hostname || id} (${proposedParentIds.length} parent${proposedParentIds.length === 1 ? "" : "s"})`,
      details:      { parentAssetIds: proposedParentIds },
    });

    res.json({ ok: true, parentAssetIds: proposedParentIds });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/dependencies/override", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true, hostname: true } });
    if (!asset) throw new AppError(404, "Asset not found");

    const result = await prisma.assetDependencyParent.deleteMany({
      where: { assetId: id, source: "override" },
    });

    if (result.count > 0) {
      logEvent({
        action:       "asset.dependency.override_cleared",
        resourceType: "asset",
        resourceId:   id,
        resourceName: asset.hostname || undefined,
        level:        "info",
        message:      `Dependency override cleared on ${asset.hostname || id} — computed parents now apply`,
        details:      { removed: result.count },
      });
    }

    res.json({ ok: true, removed: result.count });
  } catch (err) {
    next(err);
  }
});

// ─── Dependency Test (admin-only simulation) ────────────────────────────────
//
// Admin-only "simulate this asset going down to see how children react."
// Sets Asset.dependencyTestUntil to a TTL deadline; the dependency reconciler
// then treats the asset as confirmed-down for child suppression evaluation.
// Real probes keep running and updating monitorStatus / lastResponseTimeMs
// normally — this is a what-if overlay, not a probe pause. Auto-expires at
// the deadline; reconciler clears the field and writes
// `asset.dependency_test.expired`. Manual clear via DELETE writes
// `asset.dependency_test.cleared`.
//
// Strictly admin-only — assets-admin and network-admin do NOT have access.
// The simulation can briefly mask a real outage (any monitored child of the
// test target gets marked dependencySuppressed even if it's also genuinely
// failing), so we keep the privilege narrow.

const dependencyTestSchema = z.object({
  durationMinutes: z.number().int().min(1).max(240).default(30),
});

router.post("/:id/dependency-test", requirePermission("assetsProbe", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { durationMinutes } = dependencyTestSchema.parse(req.body ?? {});

    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, hostname: true, assetType: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    // Only Fortinet infra assets sit in the dependency tree. Refusing the
    // call on workstations / printers / etc. surfaces the misconception
    // early instead of letting the operator wait for a no-op.
    if (!["firewall", "switch", "access_point"].includes(asset.assetType)) {
      throw new AppError(400, "Dependency Test only applies to firewall / switch / access_point assets");
    }

    const until = new Date(Date.now() + durationMinutes * 60_000);
    const startedBy = req.session?.username || "unknown";

    await prisma.asset.update({
      where: { id },
      data:  { dependencyTestUntil: until, dependencyTestStartedBy: startedBy },
    });

    // Fire the reconciler so children flip to dependencySuppressed within
    // this request rather than waiting up to 60 s for the next tick. Same
    // hook the probe-result path uses for genuine status changes.
    await propagateAfterStatusChange(id);

    logEvent({
      action:       "asset.dependency_test.started",
      resourceType: "asset",
      resourceId:   id,
      resourceName: asset.hostname || undefined,
      actor:        req.session?.username,
      level:        "info",
      message:      `Dependency Test started on ${asset.hostname || id} for ${durationMinutes} min (auto-expires ${until.toISOString()})`,
      details:      { durationMinutes, dependencyTestUntil: until },
    });

    res.json({ ok: true, dependencyTestUntil: until, dependencyTestStartedBy: startedBy });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/dependency-test", requirePermission("assetsProbe", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, hostname: true, dependencyTestUntil: true, dependencyTestStartedBy: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    if (!asset.dependencyTestUntil) {
      // Idempotent — already cleared. No event, no reconciler hit.
      return res.json({ ok: true, alreadyCleared: true });
    }

    await prisma.asset.update({
      where: { id },
      data:  { dependencyTestUntil: null, dependencyTestStartedBy: null },
    });
    await propagateAfterStatusChange(id);

    logEvent({
      action:       "asset.dependency_test.cleared",
      resourceType: "asset",
      resourceId:   id,
      resourceName: asset.hostname || undefined,
      actor:        req.session?.username,
      level:        "info",
      message:      `Dependency Test cleared on ${asset.hostname || id}`,
      details:      { startedBy: asset.dependencyTestStartedBy, scheduledUntil: asset.dependencyTestUntil },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/connection-path — endpoint → switch → … → FortiGate
//
// Returns the upward chain from this asset to its upstream FortiGate, used by
// the Device Map topology overlay to dim everything off-path. See
// connectionPathService for the resolution rules. Open to any authenticated
// caller (read-only; same scope as the existing /:id/dependencies endpoint).
router.get("/:id/connection-path", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const path = await resolveConnectionPath(id);
    if (!path) throw new AppError(404, "Asset not found");
    res.json(path);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/quarantine-status — current quarantine state + recorded targets
router.get("/:id/quarantine-status", requirePermission("assetsQuarantine", "read"), async (req, res, next) => {
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
router.post("/:id/quarantine", requireSessionOrTokenPermission("assetsQuarantine", "write", "assets:quarantine"), async (req, res, next) => {
  try {
    const Schema = z.object({ reason: z.string().max(500).optional() });
    const input = Schema.parse(req.body ?? {});
    const id = req.params.id as string;
    const actor = req.apiToken ? `api:${req.apiToken.name}` : `user:${req.session?.username || "unknown"}`;
    const result = await quarantineAsset({
      assetId: id,
      actor,
      reason: input.reason,
      tokenIntegrationIds: req.apiToken?.integrationIds,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id/quarantine — admin, assets admin, or token with assets:quarantine scope
router.delete("/:id/quarantine", requireSessionOrTokenPermission("assetsQuarantine", "write", "assets:quarantine"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const actor = req.apiToken ? `api:${req.apiToken.name}` : `user:${req.session?.username || "unknown"}`;
    const result = await releaseQuarantine({
      assetId: id,
      actor,
      tokenIntegrationIds: req.apiToken?.integrationIds,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/quarantine/verify — read-back drift check (admin, assets admin, or token)
router.post("/:id/quarantine/verify", requireSessionOrTokenPermission("assetsQuarantine", "write", "assets:quarantine"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const verifyResult = await verifyAssetQuarantine(id, req.apiToken?.integrationIds);
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
router.post("/bulk-quarantine", requireSessionOrTokenPermission("assetsQuarantine", "write", "assets:quarantine"), async (req, res, next) => {
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
        const r = await quarantineAsset({ assetId: id, actor, reason: input.reason, tokenIntegrationIds: req.apiToken?.integrationIds });
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
router.post("/bulk-quarantine/release", requireSessionOrTokenPermission("assetsQuarantine", "write", "assets:quarantine"), async (req, res, next) => {
  try {
    const Schema = z.object({ ids: z.array(z.string()).min(1) });
    const input = Schema.parse(req.body);
    const actor = req.apiToken ? `api:${req.apiToken.name}` : `user:${req.session?.username || "unknown"}`;
    const results: Array<{ id: string; ok: boolean; message: string }> = [];
    for (const id of input.ids) {
      try {
        const r = await releaseQuarantine({ assetId: id, actor, tokenIntegrationIds: req.apiToken?.integrationIds });
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

// ─── Polaris Agent — operator-facing routes ──────────────────────────────────
//
// Phase 2 surface: stubs the actual remote install (which lives in
// agentInstallService — Phase 4) by just creating the ManagedAgent row
// and minting a one-shot enrollment token. End-to-end testable with curl:
// hit POST /install to get a managedAgentId + check the row, then have
// the agent (or curl-as-agent) POST /api/v1/agents/enroll with the
// enrollment token to swap it for a bearer. Phase 4 wires the SSH/WinRM
// file upload + remote service start that automates the agent-side work.

const AgentInstallSchema = z.object({
  credentialId: z.string().uuid("credentialId must be a UUID"),
  osPlatform:   z.enum(["linux", "darwin", "windows"]),
  arch:         z.enum(["amd64", "arm64"]),
});

router.get("/:id/agent", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) return res.status(404).json({ error: "No agent installed for this asset" });
    // Strip secret-bearing fields before serializing.
    const {
      enrollmentTokenHash: _eh, enrollmentTokenPrefix: _ep,
      bearerHash: _bh,
      ...safe
    } = row;
    res.json(safe);
  } catch (err) { next(err); }
});

router.post("/:id/agent/install", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const body = AgentInstallSchema.parse(req.body);
    const actor = req.session?.username || "unknown";

    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { discoveredByIntegration: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    // Compatibility check: agent is incompatible with Fortinet appliance
    // sources. The Zod validator + the resolver would reject the polling
    // method itself, but install kickoff has its own check because the
    // operator might click Install before flipping any stream to "agent".
    const sourceKind = assetSourceKindFromIntegrationType(asset.discoveredByIntegration?.type ?? null);
    if (!isPollingMethodCompatible(sourceKind, "agent")) {
      throw new AppError(400,
        `Polaris Agent is not compatible with ${sourceKind} sources. Compatible: manual, activedirectory, entraid, windowsserver.`);
    }

    // Cred must be ssh (linux/darwin) or winrm (windows). The /install
    // body specifies osPlatform explicitly so we can validate up-front
    // even though the actual remote upload doesn't happen until Phase 4.
    const cred = await getCredential(body.credentialId).catch(() => null);
    if (!cred) throw new AppError(400, `Credential ${body.credentialId} not found`);
    const wantType = body.osPlatform === "windows" ? "winrm" : "ssh";
    if (cred.type !== wantType) {
      throw new AppError(400,
        `Credential type "${cred.type}" doesn't match osPlatform "${body.osPlatform}" — need "${wantType}"`);
    }

    // 409 if a row already exists. Operator uses /reinstall to wipe + retry.
    const existing = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (existing) {
      throw new AppError(409,
        `Agent already installed (status=${existing.installStatus}). Use reinstall to start over.`);
    }

    // Cert pin: we capture the SHA-256 of the running Polaris leaf cert
    // at this moment and bake it into the agent's config at install. If
    // HTTPS isn't running, there's no cert to pin and no encrypted
    // transport — refuse the install with a clear error rather than
    // silently issuing a bearer that the agent won't be able to use.
    const { getServerCertFingerprint } = await import("../../services/certInfo.js");
    const fingerprint = getServerCertFingerprint();
    if (!fingerprint) {
      throw new AppError(400,
        "HTTPS is not running on this Polaris server — agent install requires TLS for the cert pin. " +
        "Enable HTTPS in Server Settings → HTTPS first.");
    }

    // The remote agent must be able to call back to Polaris. agent.conf's
    // server_url gets stamped via inferOwnServerUrl() which prefers (in
    // order) POLARIS_PUBLIC_URL → the running cert's first DNS SAN →
    // the cert's CN → an IP SAN → POLARIS_PUBLIC_HOST → localhost. The
    // final localhost fallback only works for same-box installs; on
    // every remote install it produces an agent that connection-refuses
    // against its own loopback. Refuse early when ALL the above sources
    // fail for a remote-host install.
    if (!process.env.POLARIS_PUBLIC_URL && !process.env.POLARIS_PUBLIC_HOST) {
      const targetHost = asset.ipAddress || asset.dnsName || asset.hostname || "";
      const isSameBox = targetHost === "127.0.0.1" || targetHost === "::1" ||
                        targetHost === "localhost" || targetHost.toLowerCase() === "localhost.localdomain";
      if (!isSameBox) {
        // Check whether the cert can supply a hostname before bailing.
        const { getServerCertHostnames } = await import("../../services/certInfo.js");
        const hosts = getServerCertHostnames();
        const certHost = hosts?.dnsSans[0] || hosts?.cn || hosts?.ipSans[0] || null;
        if (!certHost || certHost === "localhost" || certHost === "127.0.0.1" || certHost === "::1") {
          throw new AppError(400,
            "Polaris doesn't know what URL to embed in the remote agent's agent.conf. " +
            "Set POLARIS_PUBLIC_URL in /opt/polaris/.env to your Polaris server's public URL " +
            "(e.g. https://polaris.example.com:3000) and restart Polaris, OR regenerate the " +
            "HTTPS cert under Server Settings → Certificates with a CN/SAN matching the " +
            "hostname remote hosts use to reach Polaris (the agent install path picks the " +
            "URL up from there automatically). Then retry the install.");
        }
      }
    }

    const row = await prisma.managedAgent.create({
      data: {
        assetId,
        osPlatform:            body.osPlatform,
        arch:                  body.arch,
        installedBy:           actor,
        installStatus:         "pending",
        serverCertFingerprint: fingerprint,
        installCredentialId:   body.credentialId,
      },
    });

    await logEvent({
      action:       "agent.install_kickoff",
      resourceType: "asset",
      resourceId:   assetId,
      actor,
      level:        "info",
      message:      `Polaris Agent install kicked off (${body.osPlatform}/${body.arch})`,
      details:      { managedAgentId: row.id, credentialId: body.credentialId },
    });

    // Fire the async install. The service mints its own enrollment token,
    // SFTPs the binary + agent.conf, runs the installer, and transitions
    // installStatus as it goes. The UI polls GET /:id/agent to watch
    // progress; failure lands as installStatus="failed" + installError.
    const { startInstall } = await import("../../services/agentInstallService.js");
    await startInstall({ managedAgentId: row.id, credentialId: body.credentialId });

    res.json({
      managedAgentId:        row.id,
      installStatus:         row.installStatus,
      serverCertFingerprint: fingerprint,
    });
  } catch (err) { next(err); }
});

router.post("/:id/agent/retry", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const actor = req.session?.username || "unknown";

    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) throw new AppError(404, "No agent row to retry for this asset");
    if (row.installStatus !== "failed") {
      throw new AppError(409,
        `Agent installStatus is "${row.installStatus}"; only failed installs can be retried.`);
    }
    if (!row.installCredentialId) {
      throw new AppError(400,
        "No install credential on file (credential was deleted). " +
        "Force-remove the agent and start a fresh install.");
    }

    // Make sure the credential still exists before we reset the row —
    // otherwise startInstall would flip us right back to "failed" with
    // a less actionable error.
    const cred = await getCredential(row.installCredentialId).catch(() => null);
    if (!cred) {
      throw new AppError(400,
        "Original install credential no longer exists. " +
        "Force-remove the agent and start a fresh install.");
    }

    await prisma.managedAgent.update({
      where: { id: row.id },
      data:  { installStatus: "pending", installError: null },
    });

    await logEvent({
      action:       "agent.install_retry",
      resourceType: "asset",
      resourceId:   assetId,
      actor,
      level:        "info",
      message:      `Polaris Agent install retried (${row.osPlatform}/${row.arch})`,
      details:      { managedAgentId: row.id, credentialId: row.installCredentialId },
    });

    const { startInstall } = await import("../../services/agentInstallService.js");
    await startInstall({ managedAgentId: row.id, credentialId: row.installCredentialId });

    res.json({
      managedAgentId: row.id,
      installStatus:  "pending",
    });
  } catch (err) { next(err); }
});

const AgentUpgradeSchema = z.object({
  credentialId: z.string().uuid().optional(),
});

router.post("/:id/agent/upgrade", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const body = AgentUpgradeSchema.parse(req.body ?? {});
    const actor = req.session?.username || "unknown";

    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) throw new AppError(404, "No agent installed for this asset");

    const { startUpgrade } = await import("../../services/agentInstallService.js");
    // startUpgrade does its own AppError on no-credential / already-current /
    // missing manifest; let those propagate to the global error handler so
    // the operator sees the message inline.
    const result = await startUpgrade({
      managedAgentId: row.id,
      credentialId:   body.credentialId,
      actor,
    });
    res.json({
      managedAgentId: row.id,
      fromVersion:    result.fromVersion,
      toVersion:      result.toVersion,
      installStatus:  "upgrading",
    });
  } catch (err) { next(err); }
});

router.delete("/:id/agent", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const actor = req.session?.username || "unknown";
    const force = String(req.query.force ?? "").toLowerCase() === "true";

    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) throw new AppError(404, "No agent installed for this asset");

    // Phase 1 of the two-phase DELETE: synchronous revoke. The bearer
    // stops working immediately regardless of whether the host can be
    // reached. Phase 4 will add the async remote-uninstall pass.
    const { revokeBearer } = await import("../../services/agentTokenService.js");
    await revokeBearer(row.id);

    if (force) {
      // Hard-delete the local row. Orphan binary remains on the host
      // (operator's choice when ?force=true); the bearer is dead so it
      // can't talk to Polaris. Also clear the *Polling fields back to
      // null so the periodic puller resumes per the source default —
      // mirrors what runUninstall does on the non-force path.
      await prisma.$transaction([
        prisma.managedAgent.delete({ where: { id: row.id } }),
        prisma.asset.update({
          where: { id: assetId },
          data: {
            responseTimePolling: null,
            cpuMemoryPolling:    null,
            temperaturePolling:  null,
            interfacesPolling:   null,
            lldpPolling:         null,
            storagePolling:      null,
          },
        }),
      ]);
      await logEvent({
        action:       "agent.force_removed",
        resourceType: "asset",
        resourceId:   assetId,
        actor,
        level:        "warning",
        message:      `Polaris Agent force-removed; bearer revoked, remote uninstall skipped`,
        details:      { managedAgentId: row.id },
      });
      res.json({ ok: true, forced: true });
      return;
    }

    // Default DELETE path: revoke + async remote uninstall using the
    // credential stored at install time. On success, startUninstall
    // hard-deletes the row and emits agent.uninstalled; on failure it
    // transitions to installStatus="uninstall_failed" and emits
    // agent.uninstall_failed (warning) — operator can retry or fall
    // back to ?force=true.
    //
    // Emit the bearer-revoke event before kicking off the remote work
    // so the audit trail captures the synchronous half regardless of
    // what happens to the remote side. Bearer is already dead.
    await logEvent({
      action:       "agent.revoked",
      resourceType: "asset",
      resourceId:   assetId,
      actor,
      level:        "warning",
      message:      "Polaris Agent bearer revoked",
      details:      { managedAgentId: row.id },
    });

    if (!row.installCredentialId) {
      // No credential on file (e.g. it was deleted; SetNull cascade
      // cleared the FK). Operator can either delete the credential
      // back into existence then DELETE again, or use ?force=true.
      // Leave the row in "revoked" — bearer is dead, host has an orphan
      // binary, but Polaris won't keep retrying with no credential.
      await prisma.managedAgent.update({
        where: { id: row.id },
        data: { installStatus: "revoked" },
      });
      res.json({
        ok: true,
        forced: false,
        installStatus: "revoked",
        warning: "No install credential on file — remote uninstall skipped. " +
                 "Use ?force=true to drop the local row entirely, or restore the credential and DELETE again.",
      });
      return;
    }

    const { startUninstall } = await import("../../services/agentInstallService.js");
    await startUninstall({ managedAgentId: row.id, credentialId: row.installCredentialId });

    res.json({ ok: true, forced: false, installStatus: "uninstalling" });
  } catch (err) { next(err); }
});

export default router;
