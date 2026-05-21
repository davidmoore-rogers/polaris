/**
 * src/api/routes/monitorSettings.ts
 *
 * CRUD for the four-tier monitoring settings hierarchy:
 *
 *   asset overrides (columns on Asset)
 *     -> (assetType + integration) class override (MonitorClassOverride table)
 *     -> integration tier   (Integration.config.monitorSettings)
 *        OR manual tier     (Setting "manualMonitorSettings")
 *     -> hardcoded floor    (in monitoringService — not user-visible)
 *
 * Reads are open to any authenticated caller so the asset-modal tier-badge
 * UI works for everyone. Writes require assetsadmin (or admin).
 *
 * Every write invalidates the in-memory resolver cache in monitoringService
 * for the matching scope so the next monitor pass picks up the change
 * within one tick.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { invalidateMonitorSettingsCache } from "../../services/monitoringService.js";
import { requirePermission } from "../middleware/permissions.js";
import { logEvent } from "./events.js";
import { AppError } from "../../utils/errors.js";
import {
  type PollingMethod,
  type AssetSourceKind,
  assetSourceKindFromIntegrationType,
  isPollingMethodCompatible,
  pollingMethodLabel,
} from "../../utils/pollingCompatibility.js";
import { isKnownAssetType } from "../../utils/assetTypes.js";

const router = Router();

// Asset type validated against the AssetTypeDef registry so MonitorClassOverride
// rows can be scoped to operator-added custom types alongside the eight
// built-ins. isKnownAssetType reads the in-memory cache populated at boot;
// before the cache loads it falls back to accepting the eight built-in names.
const AssetTypeSchema = z.string().min(2).max(32).refine(
  (v) => isKnownAssetType(v),
  { message: "Unknown asset type. Add it under Assets → Manage asset types first." },
);

// Mirrors PollingMethod in src/utils/pollingCompatibility.ts. Source-kind
// compatibility is enforced at resolution time inside resolveMonitorSettings —
// not here — so a class-override that sets winrm on a fortinet integration is
// stored fine but silently ignored when resolving that integration's assets.
const PollingMethodEnum = z.enum(["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent"]);

// Tier-3 / "complete" settings: every cadence field present (no nulls). The
// per-stream polling fields are optional/nullable at every tier — null means
// "use the source default" (fortinet→rest_api, everything else→icmp). Stored
// alongside the cadence fields in Integration.config.monitorSettings (tier-3
// integration) or in the Setting "manualMonitorSettings" row (tier-3 manual).
//
// systemInfoIntervalSeconds note: required at the manual tier (orphan assets
// have no integration to inherit from), but nullable at the integration tier
// — null means "follow this integration's discovery pollInterval", which the
// resolver derives in loadIntegrationTierSettings. See the "integrationPoll-
// Interval" provenance label and the migrateSystemInfoCadenceLinkage startup
// job that retroactively nulls existing 600s defaults so installed fleets
// pick up the linkage on next deploy.
const TierSettingsSchema = z.object({
  intervalSeconds:            z.number().int().min(1).max(86400),
  failureThreshold:           z.number().int().min(1).max(100),
  probeTimeoutMs:             z.number().int().min(100).max(60000),
  // CPU/memory + temperature + system-info collectors. Range deliberately
  // wider than the response-time probe (1s..120s) — these endpoints can be
  // slow on busy gateways, and a too-tight value here false-fails the scrape.
  cpuMemoryTimeoutMs:         z.number().int().min(1000).max(120000).nullable().optional(),
  temperatureTimeoutMs:       z.number().int().min(1000).max(120000).nullable().optional(),
  systemInfoTimeoutMs:        z.number().int().min(1000).max(120000).nullable().optional(),
  cpuMemoryIntervalSeconds:   z.number().int().min(15).max(86400),
  temperatureIntervalSeconds: z.number().int().min(15).max(86400),
  systemInfoIntervalSeconds:  z.number().int().min(60).max(86400),
  // Phase 1 LLDP + Storage cadences/timeouts: persisted today, inert at
  // runtime (LLDP + Storage still ride systemInfo cadence). Phase 2 wires
  // the actual dispatch + queue carve-out. Tolerated but not required.
  lldpIntervalSeconds:        z.number().int().min(60).max(86400).nullable().optional(),
  lldpTimeoutMs:              z.number().int().min(100).max(120000).nullable().optional(),
  storageIntervalSeconds:     z.number().int().min(60).max(86400).nullable().optional(),
  storageTimeoutMs:           z.number().int().min(100).max(120000).nullable().optional(),
  // Retention used to live on this tier (sample/telemetry/systemInfo
  // RetentionDays). Phase 5 moved it to the global Setting("sampleRetention")
  // edited from Server Settings → Retention. The fields are still tolerated
  // on writes (z.unknown()) so old clients don't 400, but the values are
  // dropped before persistence — no consumer reads them.
  sampleRetentionDays:        z.unknown().optional(),
  telemetryRetentionDays:     z.unknown().optional(),
  systemInfoRetentionDays:    z.unknown().optional(),
  responseTimePolling:        PollingMethodEnum.nullable().optional(),
  cpuMemoryPolling:           PollingMethodEnum.nullable().optional(),
  temperaturePolling:         PollingMethodEnum.nullable().optional(),
  interfacesPolling:          PollingMethodEnum.nullable().optional(),
  lldpPolling:                PollingMethodEnum.nullable().optional(),
  storagePolling:             PollingMethodEnum.nullable().optional(),
  // Per-stream MIB IDs stored in the JSON blob ("std:<key>" | uploaded UUID | null)
  responseTimeMibId:          z.string().nullable().optional(),
  cpuMemoryMibId:             z.string().nullable().optional(),
  temperatureMibId:           z.string().nullable().optional(),
  interfacesMibId:            z.string().nullable().optional(),
  lldpMibId:                  z.string().nullable().optional(),
});

// Integration-tier variant: systemInfoIntervalSeconds becomes nullable.
// Null means "follow integration.pollInterval × 3600" — the resolver derives
// the cadence in loadIntegrationTierSettings. Manual tier stays required
// because orphan assets have no integration to inherit from.
const TierSettingsIntegrationSchema = TierSettingsSchema.extend({
  systemInfoIntervalSeconds: z.number().int().min(60).max(86400).nullable(),
});

// Override shape — every field optional/nullable, null = inherit from tier
// below. Used by the class-override CRUD endpoints.
const OverrideSettingsSchema = z.object({
  intervalSeconds:            z.number().int().min(1).max(86400).nullable().optional(),
  failureThreshold:           z.number().int().min(1).max(100).nullable().optional(),
  probeTimeoutMs:             z.number().int().min(100).max(60000).nullable().optional(),
  cpuMemoryTimeoutMs:         z.number().int().min(1000).max(120000).nullable().optional(),
  temperatureTimeoutMs:       z.number().int().min(1000).max(120000).nullable().optional(),
  systemInfoTimeoutMs:        z.number().int().min(1000).max(120000).nullable().optional(),
  cpuMemoryIntervalSeconds:   z.number().int().min(15).max(86400).nullable().optional(),
  temperatureIntervalSeconds: z.number().int().min(15).max(86400).nullable().optional(),
  systemInfoIntervalSeconds:  z.number().int().min(60).max(86400).nullable().optional(),
  // Phase 1 LLDP + Storage cadences/timeouts. Same Phase 2 plan as
  // TierSettingsSchema above — persisted, runtime-inert today.
  lldpIntervalSeconds:        z.number().int().min(60).max(86400).nullable().optional(),
  lldpTimeoutMs:              z.number().int().min(100).max(120000).nullable().optional(),
  storageIntervalSeconds:     z.number().int().min(60).max(86400).nullable().optional(),
  storageTimeoutMs:           z.number().int().min(100).max(120000).nullable().optional(),
  // Class-override retention is dead — see the comment on the matching
  // fields in TierSettingsSchema above. Tolerated on input, dropped before
  // persistence; retention now lives globally in Setting("sampleRetention").
  sampleRetentionDays:        z.unknown().optional(),
  telemetryRetentionDays:     z.unknown().optional(),
  systemInfoRetentionDays:    z.unknown().optional(),
  responseTimePolling:        PollingMethodEnum.nullable().optional(),
  cpuMemoryPolling:           PollingMethodEnum.nullable().optional(),
  temperaturePolling:         PollingMethodEnum.nullable().optional(),
  interfacesPolling:          PollingMethodEnum.nullable().optional(),
  lldpPolling:                PollingMethodEnum.nullable().optional(),
  storagePolling:             PollingMethodEnum.nullable().optional(),
  // Per-stream credential IDs (FK to Credential, null = inherit)
  responseTimeCredentialId:   z.string().uuid().nullable().optional(),
  cpuMemoryCredentialId:      z.string().uuid().nullable().optional(),
  temperatureCredentialId:    z.string().uuid().nullable().optional(),
  interfacesCredentialId:     z.string().uuid().nullable().optional(),
  lldpCredentialId:           z.string().uuid().nullable().optional(),
  // Per-stream MIB IDs ("std:<key>" | uploaded UUID | null = inherit)
  responseTimeMibId:          z.string().nullable().optional(),
  cpuMemoryMibId:             z.string().nullable().optional(),
  temperatureMibId:           z.string().nullable().optional(),
  interfacesMibId:            z.string().nullable().optional(),
  lldpMibId:                  z.string().nullable().optional(),
});

// Polling-method compatibility check shared by integration-tier and
// class-override writes. A tier whose source is fixed (any single integration
// or a class override scoped to one) cannot store a method that wouldn't
// apply on the assets it covers — the resolver would silently fall through
// and the operator would never see why their setting "didn't take." Manual
// tier accepts every method (it covers any source).
const POLLING_FIELDS = ["responseTimePolling", "cpuMemoryPolling", "temperaturePolling", "interfacesPolling", "lldpPolling", "storagePolling"] as const;
type PollingField = (typeof POLLING_FIELDS)[number];

function assertPollingCompatible(
  source: AssetSourceKind,
  input: Partial<Record<PollingField, PollingMethod | null | undefined>>,
): void {
  for (const field of POLLING_FIELDS) {
    const v = input[field];
    if (!v) continue;
    if (!isPollingMethodCompatible(source, v)) {
      throw new AppError(
        400,
        `${pollingMethodLabel(v)} polling is not supported for ${source} assets (field: ${field})`,
      );
    }
    // ICMP is only meaningful for the response-time probe — for telemetry /
    // interfaces / LLDP / storage / temperature there's no payload to gather
    // from an ICMP echo. Reject so an operator pick doesn't silently
    // fall through at resolution time.
    if (v === "icmp" && field !== "responseTimePolling") {
      throw new AppError(
        400,
        `ICMP polling is only valid for the response-time stream (field: ${field})`,
      );
    }
  }
}

const MANUAL_SETTING_KEY = "manualMonitorSettings";

// ─── Manual tier ────────────────────────────────────────────────────────────

/** Read the manual tier (settings for orphan / non-integration-discovered assets). */
router.get("/manual", requirePermission("assetMonitorSettings", "read"), async (_req, res, next) => {
  try {
    const row = await prisma.setting.findUnique({ where: { key: MANUAL_SETTING_KEY } });
    // null = not yet seeded; the UI shows the hardcoded-floor defaults until
    // an operator saves something.
    res.json(row?.value ?? null);
  } catch (err) { next(err); }
});

/**
 * Strip legacy retention keys from a tier-3 or class-override blob before
 * persistence. Retention moved to Setting("sampleRetention") in phase 5;
 * the schema still tolerates the keys on input so old clients don't 400,
 * but persistence drops them so the JSON stays clean.
 */
function stripLegacyRetention<T extends Record<string, unknown>>(input: T): Omit<T, "sampleRetentionDays" | "telemetryRetentionDays" | "systemInfoRetentionDays"> {
  const { sampleRetentionDays: _s, telemetryRetentionDays: _t, systemInfoRetentionDays: _i, ...rest } = input;
  void _s; void _t; void _i;
  return rest;
}

/** Write the manual tier. Affects every asset with discoveredByIntegrationId = null. */
router.put("/manual", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    const input = stripLegacyRetention(TierSettingsSchema.parse(req.body));
    await prisma.setting.upsert({
      where:  { key: MANUAL_SETTING_KEY },
      update: { value: input as any },
      create: { key: MANUAL_SETTING_KEY, value: input as any },
    });
    invalidateMonitorSettingsCache({ integrationId: null });
    logEvent({
      action: "monitor_settings.manual.updated",
      resourceType: "monitor_settings",
      resourceName: "Manual tier",
      actor: req.session?.username,
      message: "Manual monitoring settings updated",
      details: { settings: input },
    });
    res.json(input);
  } catch (err) { next(err); }
});

// ─── Integration tier ───────────────────────────────────────────────────────

/** Read the integration tier (settings stored in Integration.config.monitorSettings). */
router.get("/integration/:id", requirePermission("assetMonitorSettings", "read"), async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where:  { id: req.params.id as string },
      select: { id: true, name: true, type: true, config: true },
    });
    if (!integration) throw new AppError(404, "Integration not found");
    const cfg = (integration.config as Record<string, unknown> | null) ?? {};
    res.json({
      integrationId:   integration.id,
      integrationName: integration.name,
      integrationType: integration.type,
      // null = not yet seeded for this integration; UI displays defaults.
      settings:        (cfg.monitorSettings as unknown) ?? null,
    });
  } catch (err) { next(err); }
});

/** Write the integration tier. Affects every asset discovered by this integration. */
router.put("/integration/:id", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    const input = stripLegacyRetention(TierSettingsIntegrationSchema.parse(req.body));
    const integrationId = req.params.id as string;
    const integration = await prisma.integration.findUnique({
      where:  { id: integrationId },
      select: { id: true, name: true, type: true, config: true },
    });
    if (!integration) throw new AppError(404, "Integration not found");
    // Tier-3 integration polling methods must apply on the integration's
    // source kind — picking WinRM on a FortiManager tier silently drops to
    // the source default at resolve time, leaving the operator confused
    // about why their selection "didn't take."
    assertPollingCompatible(assetSourceKindFromIntegrationType(integration.type), input);
    const cfg = (integration.config as Record<string, unknown> | null) ?? {};
    cfg.monitorSettings = input;
    await prisma.integration.update({
      where: { id: integrationId },
      data:  { config: cfg as any },
    });
    invalidateMonitorSettingsCache({ integrationId });
    logEvent({
      action: "monitor_settings.integration.updated",
      resourceType: "integration",
      resourceId: integrationId,
      resourceName: integration.name,
      actor: req.session?.username,
      message: `Monitoring settings updated for integration "${integration.name}"`,
      details: { settings: input },
    });
    res.json(input);
  } catch (err) { next(err); }
});

// ─── Class overrides ────────────────────────────────────────────────────────

const ClassCreateSchema = z
  .object({
    integrationId: z.string().uuid().nullable(), // null = manual-tier override
    assetType:     AssetTypeSchema,
  })
  .merge(OverrideSettingsSchema);

const ClassUpdateSchema = OverrideSettingsSchema;

/**
 * List class overrides. Filterable by integrationId (use "null" string to
 * select manual-tier overrides) and assetType. Returns the integration name
 * + type alongside each row so the UI can render badges without a join.
 */
router.get("/class-overrides", requirePermission("assetMonitorSettings", "read"), async (req, res, next) => {
  try {
    const where: Record<string, unknown> = {};
    const integrationIdParam = req.query.integrationId;
    if (integrationIdParam === "null")          where.integrationId = null;
    else if (typeof integrationIdParam === "string") where.integrationId = integrationIdParam;
    if (typeof req.query.assetType === "string") where.assetType = req.query.assetType;

    const rows = await prisma.monitorClassOverride.findMany({
      where,
      include: { integration: { select: { id: true, name: true, type: true } } },
      orderBy: [{ assetType: "asc" }],
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/class-overrides", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    const input = ClassCreateSchema.parse(req.body);
    let sourceKind: AssetSourceKind = "manual";
    if (input.integrationId !== null) {
      const exists = await prisma.integration.findUnique({
        where:  { id: input.integrationId },
        select: { id: true, type: true },
      });
      if (!exists) throw new AppError(400, `Integration ${input.integrationId} not found`);
      sourceKind = assetSourceKindFromIntegrationType(exists.type);
    }
    // Class overrides scoped to a single integration must use polling methods
    // valid for that integration's source kind. Manual-tier overrides
    // (integrationId = null) cover any source so they accept any method.
    assertPollingCompatible(sourceKind, input);
    // Service-layer uniqueness for the manual-tier case (Postgres treats nulls
    // as distinct, so the @@unique alone won't catch it).
    const existing = await prisma.monitorClassOverride.findFirst({
      where: { integrationId: input.integrationId, assetType: input.assetType },
    });
    if (existing) {
      throw new AppError(
        409,
        `Class override for (${input.integrationId ?? "manual"}, ${input.assetType}) already exists`,
      );
    }

    const { integrationId, assetType, ...rest } = input;
    const settings = stripLegacyRetention(rest);
    const created = await prisma.monitorClassOverride.create({
      data:    { integrationId, assetType, ...settings },
      include: { integration: { select: { id: true, name: true, type: true } } },
    });
    invalidateMonitorSettingsCache({ integrationId, assetType });
    logEvent({
      action: "monitor_settings.class_override.created",
      resourceType: "monitor_class_override",
      resourceId: created.id,
      resourceName: `${assetType} @ ${created.integration?.name ?? "Manual"}`,
      actor: req.session?.username,
      message: `Class override created for ${assetType} under ${created.integration?.name ?? "Manual"}`,
      details: { settings },
    });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.put("/class-overrides/:id", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    const input = stripLegacyRetention(ClassUpdateSchema.parse(req.body));
    const id = req.params.id as string;
    const existing = await prisma.monitorClassOverride.findUnique({
      where:   { id },
      include: { integration: { select: { type: true } } },
    });
    if (!existing) throw new AppError(404, "Class override not found");
    // Same compatibility check as create — keep operators from saving a
    // method that wouldn't apply on the assets this row covers.
    const sourceKind: AssetSourceKind = existing.integration
      ? assetSourceKindFromIntegrationType(existing.integration.type)
      : "manual";
    assertPollingCompatible(sourceKind, input);
    const updated = await prisma.monitorClassOverride.update({
      where:   { id },
      data:    input,
      include: { integration: { select: { id: true, name: true, type: true } } },
    });
    invalidateMonitorSettingsCache({
      integrationId: existing.integrationId,
      assetType:     existing.assetType,
    });
    logEvent({
      action: "monitor_settings.class_override.updated",
      resourceType: "monitor_class_override",
      resourceId: updated.id,
      resourceName: `${updated.assetType} @ ${updated.integration?.name ?? "Manual"}`,
      actor: req.session?.username,
      message: `Class override updated for ${updated.assetType} under ${updated.integration?.name ?? "Manual"}`,
      details: { settings: input },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete("/class-overrides/:id", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.monitorClassOverride.findUnique({
      where:   { id },
      include: { integration: { select: { id: true, name: true } } },
    });
    if (!existing) throw new AppError(404, "Class override not found");
    await prisma.monitorClassOverride.delete({ where: { id } });
    invalidateMonitorSettingsCache({
      integrationId: existing.integrationId,
      assetType:     existing.assetType,
    });
    logEvent({
      action: "monitor_settings.class_override.deleted",
      resourceType: "monitor_class_override",
      resourceId: id,
      resourceName: `${existing.assetType} @ ${existing.integration?.name ?? "Manual"}`,
      actor: req.session?.username,
      message: `Class override deleted for ${existing.assetType} under ${existing.integration?.name ?? "Manual"}`,
    });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Asset-overrides reverse lookup ─────────────────────────────────────────
//
// Lists assets that have at least one per-asset monitor setting override
// (monitorIntervalSec / telemetryIntervalSec / systemInfoIntervalSec /
// probeTimeoutMs). Filterable by the same scope as a class override, so the
// "Asset Overrides" button on the integration/class modal can show "which
// assets are individually deviating from the settings inherited at this
// scope" — and the operator can click through to fix each one.

router.get("/asset-overrides", requirePermission("assetMonitorSettings", "read"), async (req, res, next) => {
  try {
    const integrationIdParam = req.query.integrationId;
    const assetType = typeof req.query.assetType === "string" ? req.query.assetType : undefined;

    const where: Record<string, unknown> = {
      OR: [
        { monitorIntervalSec:     { not: null } },
        { cpuMemoryIntervalSec:   { not: null } },
        { temperatureIntervalSec: { not: null } },
        { systemInfoIntervalSec:  { not: null } },
        { probeTimeoutMs:         { not: null } },
        { cpuMemoryTimeoutMs:     { not: null } },
        { temperatureTimeoutMs:   { not: null } },
        { systemInfoTimeoutMs:    { not: null } },
        { responseTimePolling:    { not: null } },
        { cpuMemoryPolling:       { not: null } },
        { temperaturePolling:     { not: null } },
        { interfacesPolling:      { not: null } },
        { lldpPolling:            { not: null } },
        { storagePolling:         { not: null } },
      ],
    };
    if (integrationIdParam === "null") where.discoveredByIntegrationId = null;
    else if (typeof integrationIdParam === "string") where.discoveredByIntegrationId = integrationIdParam;
    if (assetType) where.assetType = assetType;

    const assets = await prisma.asset.findMany({
      where,
      select: {
        id:                       true,
        hostname:                 true,
        ipAddress:                true,
        assetType:                true,
        monitorIntervalSec:       true,
        cpuMemoryIntervalSec:     true,
        temperatureIntervalSec:   true,
        systemInfoIntervalSec:    true,
        probeTimeoutMs:           true,
        cpuMemoryTimeoutMs:       true,
        temperatureTimeoutMs:     true,
        systemInfoTimeoutMs:      true,
        responseTimePolling:      true,
        cpuMemoryPolling:         true,
        temperaturePolling:       true,
        interfacesPolling:        true,
        lldpPolling:              true,
        storagePolling:           true,
        discoveredByIntegrationId: true,
      },
      orderBy: { hostname: "asc" },
      take:    500,
    });
    res.json(assets);
  } catch (err) { next(err); }
});

export default router;
