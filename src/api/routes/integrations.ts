/**
 * src/api/routes/integrations.ts — Integration CRUD + connection testing
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requireNetworkAdmin } from "../middleware/auth.js";
import * as fortimanager from "../../services/fortimanagerService.js";
import * as fortigate from "../../services/fortigateService.js";
import * as windowsServer from "../../services/windowsServerService.js";
import * as entraId from "../../services/entraIdService.js";
import * as activeDirectory from "../../services/activeDirectoryService.js";
import { isValidIpAddress, ipInCidr, normalizeCidr, cidrContains, cidrOverlaps } from "../../utils/cidr.js";
import type { DiscoveredSubnet, DiscoveryResult, DiscoveredDevice, DiscoveredInterfaceIp, DiscoveredDhcpEntry, DiscoveredInventoryDevice, DiscoveredVip, DiscoveryProgressCallback } from "../../services/fortimanagerService.js";
import { logEvent } from "./events.js";
import { getConfiguredResolver } from "../../services/dnsService.js";
import { lookupOui, lookupOuiOverride } from "../../services/ouiService.js";
import { clampAcquiredToLastSeen } from "../../utils/assetInvariants.js";
import { recordSample, getBaselines, type Baseline } from "../../services/discoveryDurationService.js";
import { getAdMonitorProtocol } from "../../services/monitoringService.js";
import * as autoMonitor from "../../services/autoMonitorInterfacesService.js";
import * as sightings from "../../services/assetSightingService.js";
import { quarantineAsset, verifyAssetQuarantine } from "../../services/assetQuarantineService.js";

const router = Router();

// Track in-flight DHCP discovery per integration — abort previous if re-saved.
// Carries per-run timing so we can detect "taking longer than normal" and
// emit `integration.discover.slow` events without double-firing.
interface ActiveDiscoveryEntry {
  controller: AbortController;
  name: string;
  type: string;                           // e.g. "fortimanager", "fortigate"
  startedAt: number;                      // Date.now() at run start
  activeDevices: Set<string>;             // FMG: currently-running FortiGate names
  deviceStartedAt: Map<string, number>;   // FMG: per-FortiGate start timestamps
  slowAlerted: boolean;                   // overall-run slow event already emitted
  slowAlertedDevices: Set<string>;        // per-FortiGate slow event already emitted
}
const activeDiscovery = new Map<string, ActiveDiscoveryEntry>();

// Safely stringify a proxy-query response, converting v8 string-limit and oversized
// payloads into a helpful 413 instead of an opaque 500.
const PROXY_RESPONSE_MAX_BYTES = 25 * 1024 * 1024;
function sendProxyJson(res: import("express").Response, result: unknown): void {
  let body: string;
  try {
    body = JSON.stringify(result);
  } catch (e) {
    if (e instanceof RangeError) {
      throw new AppError(413, "Response too large to return — narrow the query with filter= or format= parameters");
    }
    throw e;
  }
  if (body.length > PROXY_RESPONSE_MAX_BYTES) {
    const mb = (body.length / 1024 / 1024).toFixed(1);
    throw new AppError(413, `Response is ${mb} MB — narrow the query with filter= or format= parameters`);
  }
  res.type("application/json").send(body);
}

function inferAssetTypeFromOs(os: string | null | undefined): "workstation" | "server" | "other" {
  if (!os) return "other";
  const lower = os.toLowerCase();
  if (
    lower.includes("server") ||
    lower.includes("centos") ||
    lower.includes("red hat") ||
    lower.includes("rhel") ||
    lower.includes("rocky linux") ||
    lower.includes("almalinux") ||
    lower.includes("oracle linux") ||
    lower.includes("freebsd") ||
    lower.includes("openbsd") ||
    lower.includes("netbsd") ||
    lower.includes("esxi") ||
    lower.includes("vmware")
  ) return "server";
  if (
    /windows\s+(10|11|7|8|xp|vista)/i.test(os) ||
    lower.includes("macos") ||
    lower.includes("mac os x") ||
    lower.includes("os x") ||
    lower.includes("linux mint") ||
    lower.includes("ubuntu") ||
    lower.includes("fedora") ||
    lower.includes("debian") ||
    lower.includes("arch linux") ||
    lower.includes("manjaro") ||
    lower.includes("pop!_os") ||
    lower.includes("elementary os") ||
    lower.includes("zorin os")
  ) return "workstation";
  return "other";
}

// Pre-compile every wildcard pattern in fortigate/switch/ap autoMonitor blocks
// so a syntactically broken pattern fails the save with a clear label instead
// of throwing later inside the apply pass. Idempotent on configs without any
// wildcard selections.
function validateAutoMonitorPatterns(cfg: any): void {
  if (!cfg || typeof cfg !== "object") return;
  const labels: Record<string, string> = {
    fortigateMonitor:   "FortiGate auto-monitor",
    fortiswitchMonitor: "FortiSwitch auto-monitor",
    fortiapMonitor:     "FortiAP auto-monitor",
  };
  for (const field of Object.keys(labels)) {
    const sel = cfg[field]?.autoMonitorInterfaces;
    if (!sel || sel.mode !== "wildcard" || !Array.isArray(sel.patterns)) continue;
    for (const pat of sel.patterns) {
      try {
        autoMonitor.compileWildcard(pat);
      } catch (err: any) {
        throw new AppError(400, `${labels[field]} — invalid pattern "${pat}": ${err?.message || "compile failed"}`);
      }
    }
  }
}

// All integration routes require network admin or admin
router.use(requireNetworkAdmin);

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

// "Auto-Monitor Interfaces" selection persisted on each *Monitor block. null
// = disabled (default). Three modes; the apply pass is strictly additive
// (never strips Asset.monitoredInterfaces). `.strict()` on each branch makes
// `{mode:"names", onlyUp:true}` and similar mistakes a 400 instead of a
// silently-stripped field.
const AutoMonitorByNamesSchema = z.object({
  mode:  z.literal("names"),
  names: z.array(z.string().trim().min(1)).min(1, "Pick at least one interface name").max(200, "Too many names — pick at most 200"),
}).strict();
const AutoMonitorByWildcardSchema = z.object({
  mode:     z.literal("wildcard"),
  patterns: z.array(z.string().trim().min(1)).min(1, "Add at least one pattern").max(50, "Too many patterns — keep it under 50"),
  onlyUp:   z.boolean().optional().default(false),
}).strict();
const AutoMonitorByTypeSchema = z.object({
  mode:   z.literal("type"),
  types:  z.array(z.enum(["physical", "aggregate", "vlan", "loopback", "tunnel"])).min(1),
  onlyUp: z.boolean().optional().default(true),
}).strict();
const AutoMonitorInterfacesSchema = z.discriminatedUnion("mode", [
  AutoMonitorByNamesSchema,
  AutoMonitorByWildcardSchema,
  AutoMonitorByTypeSchema,
]).nullable().optional().default(null);

// Per-integration switch/AP monitor stamping. When `enabled` is true,
// discovery sets each newly-found FortiSwitch/FortiAP's monitorType to
// "snmp" with the chosen credential — but only when the asset has no
// operator override. `addAsMonitored` controls whether `monitored=true`
// is also stamped on those new assets; without it they're created with
// monitorType configured but `monitored=false`, so operators can opt in
// asset-by-asset later. `addAsMonitored` requires `enabled` to be true
// (a switch/AP can't be monitored without a monitorType).
const FortinetClassMonitorSchema = z.object({
  enabled:               z.boolean().optional().default(false),
  snmpCredentialId:      z.string().uuid().nullable().optional(),
  addAsMonitored:        z.boolean().optional().default(false),
  autoMonitorInterfaces: AutoMonitorInterfacesSchema,
}).optional().default({ enabled: false, snmpCredentialId: null, addAsMonitored: false, autoMonitorInterfaces: null });

// FortiGate-class equivalent. FortiGates always get a monitorType stamped
// at discovery (the integration's native type), so this block only carries
// the `addAsMonitored` flag — no credential/enabled toggle needed.
const FortiGateClassMonitorSchema = z.object({
  addAsMonitored:        z.boolean().optional().default(false),
  autoMonitorInterfaces: AutoMonitorInterfacesSchema,
}).optional().default({ addAsMonitored: false, autoMonitorInterfaces: null });

// Per-stream transport toggle. Default "rest" preserves the legacy behaviour
// (FortiOS REST for everything). Setting to "snmp" reroutes that stream
// through the integration's `monitorCredentialId` (or the asset's own
// `monitorCredentialId` when set, which wins). Only consulted when the asset's
// `monitorType` resolves to fortimanager or fortigate.
const MonitorTransportSchema = z.enum(["rest", "snmp"]).optional().default("rest");

const FortiManagerConfigSchema = z.object({
  host:      z.string().optional().default(""),
  port:      z.number().int().min(1).max(65535).optional().default(443),
  apiUser:   z.string().optional().default(""),
  apiToken:  z.string().optional().default(""),
  adom:      z.string().optional().default("root"),
  verifySsl: z.boolean().optional().default(false),
  mgmtInterface: z.string().optional().default(""),
  interfaceInclude: z.array(z.string()).optional().default([]),
  interfaceExclude: z.array(z.string()).optional().default([]),
  dhcpInclude:   z.array(z.string()).optional().default([]),
  dhcpExclude:   z.array(z.string()).optional().default([]),
  inventoryExcludeInterfaces: z.array(z.string()).optional().default([]),
  inventoryIncludeInterfaces: z.array(z.string()).optional().default([]),
  deviceInclude: z.array(z.string()).optional().default([]),
  deviceExclude: z.array(z.string()).optional().default([]),
  discoveryParallelism: z.number().int().min(1).max(20).optional().default(5),
  useProxy: z.boolean().optional().default(true),
  fortigateApiUser:  z.string().optional().default(""),
  fortigateApiToken: z.string().optional().default(""),
  fortigateVerifySsl: z.boolean().optional().default(false),
  // Optional: stored SNMP credential used by any per-stream transport toggle
  // below set to "snmp". Without a credential, "snmp" toggles surface the
  // configuration error in the System tab refresh toast.
  monitorCredentialId: z.string().uuid().nullable().optional(),
  // Per-stream transport toggles. Default "rest" preserves the legacy path
  // (FortiOS REST) for response-time, telemetry (CPU/mem/temperature), and
  // interfaces. "snmp" reroutes that stream through monitorCredentialId.
  // IPsec stays on REST regardless — SNMP has no equivalent.
  monitorResponseTimeSource: MonitorTransportSchema,
  monitorTelemetrySource:    MonitorTransportSchema,
  monitorInterfacesSource:   MonitorTransportSchema,
  // LLDP runs on the system-info cadence. Decoupled from the interfaces
  // toggle because the FortiOS LLDP REST endpoint and SNMP LLDP-MIB don't
  // always agree on coverage — branch-class FortiGates sometimes 404 the
  // REST endpoint while still publishing LLDP-MIB, and vice-versa.
  monitorLldpSource:         MonitorTransportSchema,
  // Per-class auto-monitor settings for assets discovered through this
  // integration. fortigateMonitor only carries `addAsMonitored` since
  // FortiGates always get a monitorType stamped at discovery; the switch /
  // AP blocks also carry the SNMP-direct-polling toggle + credential.
  fortigateMonitor:   FortiGateClassMonitorSchema,
  fortiswitchMonitor: FortinetClassMonitorSchema,
  fortiapMonitor:     FortinetClassMonitorSchema,
  // When true, manual reservations created on subnets discovered by this
  // integration are pushed to the FortiGate at create time. Transport follows
  // useProxy: true → write via FMG /sys/proxy/json; false → write direct to
  // each FortiGate's REST API using fortigateApiUser/fortigateApiToken. The
  // push is verified by reading the entry back; any failure aborts the
  // reservation create entirely (no row persisted).
  pushReservations: z.boolean().optional().default(false),
  // When true, quarantining an asset will push MAC-based address-group
  // entries to every FortiGate seen by this integration that has sighted the
  // asset within the sightingMaxAgeDays window. Default false; operators must
  // opt in explicitly because quarantine push requires write access to the
  // FortiGate's address-group configuration.
  pushQuarantine: z.boolean().optional().default(false),
});

const FortiGateConfigSchema = z.object({
  host:      z.string().optional().default(""),
  port:      z.number().int().min(1).max(65535).optional().default(443),
  apiUser:   z.string().optional().default(""),
  apiToken:  z.string().optional().default(""),
  vdom:      z.string().optional().default("root"),
  verifySsl: z.boolean().optional().default(false),
  mgmtInterface: z.string().optional().default(""),
  dhcpInclude:   z.array(z.string()).optional().default([]),
  dhcpExclude:   z.array(z.string()).optional().default([]),
  inventoryExcludeInterfaces: z.array(z.string()).optional().default([]),
  inventoryIncludeInterfaces: z.array(z.string()).optional().default([]),
  monitorCredentialId: z.string().uuid().nullable().optional(),
  monitorResponseTimeSource: MonitorTransportSchema,
  monitorTelemetrySource:    MonitorTransportSchema,
  monitorInterfacesSource:   MonitorTransportSchema,
  monitorLldpSource:         MonitorTransportSchema,
  fortigateMonitor:   FortiGateClassMonitorSchema,
  fortiswitchMonitor: FortinetClassMonitorSchema,
  fortiapMonitor:     FortinetClassMonitorSchema,
});

const WindowsServerConfigSchema = z.object({
  host:      z.string().optional().default(""),
  port:      z.number().int().min(1).max(65535).optional().default(5985),
  username:  z.string().optional().default(""),
  password:  z.string().optional().default(""),
  useSsl:    z.boolean().optional().default(false),
  domain:    z.string().optional().default(""),
  dhcpInclude: z.array(z.string()).optional().default([]),
  dhcpExclude: z.array(z.string()).optional().default([]),
});

const EntraIdConfigSchema = z.object({
  tenantId:      z.string().optional().default(""),
  clientId:      z.string().optional().default(""),
  clientSecret:  z.string().optional().default(""),
  enableIntune:  z.boolean().optional().default(false),
  deviceInclude: z.array(z.string()).optional().default([]),
  deviceExclude: z.array(z.string()).optional().default([]),
});

const ActiveDirectoryConfigSchema = z.object({
  host:            z.string().optional().default(""),
  port:            z.number().int().min(1).max(65535).optional().default(636),
  useLdaps:        z.boolean().optional().default(true),
  verifyTls:       z.boolean().optional().default(false),
  bindDn:          z.string().optional().default(""),
  bindPassword:    z.string().optional().default(""),
  baseDn:          z.string().optional().default(""),
  searchScope:     z.enum(["sub", "one"]).optional().default("sub"),
  ouInclude:       z.array(z.string()).optional().default([]),
  ouExclude:       z.array(z.string()).optional().default([]),
  includeDisabled: z.boolean().optional().default(true),
});

const CreateIntegrationSchema = z.discriminatedUnion("type", [
  z.object({
    type:         z.literal("fortimanager"),
    name:         z.string().min(1, "Name is required"),
    config:       FortiManagerConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(12),
  }),
  z.object({
    type:         z.literal("fortigate"),
    name:         z.string().min(1, "Name is required"),
    config:       FortiGateConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(12),
  }),
  z.object({
    type:         z.literal("windowsserver"),
    name:         z.string().min(1, "Name is required"),
    config:       WindowsServerConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(4),
  }),
  z.object({
    type:         z.literal("entraid"),
    name:         z.string().min(1, "Name is required"),
    config:       EntraIdConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(12),
  }),
  z.object({
    type:         z.literal("activedirectory"),
    name:         z.string().min(1, "Name is required"),
    config:       ActiveDirectoryConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(12),
  }),
]);

const UpdateIntegrationSchema = z.object({
  name:         z.string().min(1).optional(),
  config:       z.record(z.unknown()).optional(),
  enabled:      z.boolean().optional(),
  autoDiscover: z.boolean().optional(),
  pollInterval: z.number().int().min(1).max(24).optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/integrations
router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const [integrations, total] = await Promise.all([
      prisma.integration.findMany({
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.integration.count(),
    ]);
    // Strip passwords from the response
    const safe = integrations.map(stripSecret);
    res.json({ integrations: safe, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/integrations/discoveries — active background discoveries.
// Also runs slow-detection inline so the UI sees amber within one poll cycle
// of a run exceeding its baseline, without waiting for the 30s background job.
router.get("/discoveries", async (req, res) => {
  await checkForSlowRuns().catch(() => {});
  const now = Date.now();
  const running = Array.from(activeDiscovery.entries()).map(([id, entry]) => ({
    id,
    name: entry.name,
    type: entry.type,
    startedAt: entry.startedAt,
    elapsedMs: now - entry.startedAt,
    activeDevices: [...entry.activeDevices],
    slow: entry.slowAlerted,
    slowDevices: [...entry.slowAlertedDevices],
  }));
  res.json({ discoveries: running });
});

// DELETE /api/v1/integrations/:id/discover — abort an in-flight discovery
router.delete("/:id/discover", (req, res) => {
  const entry = activeDiscovery.get(req.params.id);
  if (!entry) { res.status(404).json({ message: "No active discovery for this integration" }); return; }
  entry.controller.abort();
  activeDiscovery.delete(req.params.id);
  res.status(204).send();
});

// GET /api/v1/integrations/:id
router.get("/:id", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");
    res.json(stripSecret(integration));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations
router.post("/", async (req, res, next) => {
  try {
    const input = CreateIntegrationSchema.parse(req.body);
    if (input.type === "fortimanager" || input.type === "fortigate") {
      const cfg = input.config as any;
      // Validate the FortiGate response-time SNMP override credential.
      const credId = cfg.monitorCredentialId;
      if (credId) {
        const cred = await prisma.credential.findUnique({ where: { id: credId } });
        if (!cred) throw new AppError(400, "Selected monitor credential not found");
        if (cred.type !== "snmp") throw new AppError(400, "Monitor credential override must be SNMP");
      }
      // Any per-stream toggle set to "snmp" requires an SNMP credential at
      // the integration level. Per-asset overrides can still bring their own.
      const snmpStreams: string[] = [];
      if (cfg.monitorResponseTimeSource === "snmp") snmpStreams.push("Response time");
      if (cfg.monitorTelemetrySource    === "snmp") snmpStreams.push("Telemetry");
      if (cfg.monitorInterfacesSource   === "snmp") snmpStreams.push("Interfaces");
      if (cfg.monitorLldpSource         === "snmp") snmpStreams.push("LLDP");
      if (snmpStreams.length > 0 && !credId) {
        throw new AppError(400, `Select an SNMP credential to route ${snmpStreams.join(", ")} via SNMP`);
      }
      // Validate the per-class FortiSwitch / FortiAP monitor credentials.
      // Direct-polling SNMP requires a credential; ICMP fallback (when
      // addAsMonitored=true and direct polling is off) doesn't.
      for (const [field, label] of [
        ["fortiswitchMonitor", "FortiSwitch monitor credential"],
        ["fortiapMonitor",     "FortiAP monitor credential"],
      ] as const) {
        const block = cfg[field];
        const cId = block?.snmpCredentialId;
        if (block?.enabled && !cId) throw new AppError(400, `${label} must be selected when direct polling is enabled`);
        if (cId) {
          const cred = await prisma.credential.findUnique({ where: { id: cId } });
          if (!cred) throw new AppError(400, `${label} not found`);
          if (cred.type !== "snmp") throw new AppError(400, `${label} must be SNMP`);
        }
      }
      // Pre-compile any wildcard patterns so a bad pattern is rejected with a
      // clear message instead of failing later in the apply pass.
      validateAutoMonitorPatterns(cfg);
    }
    const integration = await prisma.integration.create({
      data: {
        type: input.type,
        name: input.name,
        config: input.config as any,
        enabled: input.enabled,
        autoDiscover: input.autoDiscover ?? true,
        pollInterval: input.pollInterval,
      },
    });

    logEvent({ action: "integration.created", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: req.session?.username, message: `Integration "${input.name}" (${input.type}) created` });

    const response: Record<string, unknown> = stripSecret(integration);

    // Auto-register FortiManager/FortiGate IP as asset/reservation
    if ((input.type === "fortimanager" || input.type === "fortigate") && input.config.host) {
      const registration = await registerFortinetHost(input.type, input.config.host, input.name, false);
      if (registration?.conflicts?.length) {
        response.conflicts = registration.conflicts;
      }
    }

    // Skip auto-discovery on create — require a successful test first
    const canDiscover = false;

    if (canDiscover) {
      activeDiscovery.get(integration.id)?.controller.abort();
      const ac = new AbortController();
      activeDiscovery.set(integration.id, {
        controller: ac,
        name: input.name,
        type: input.type,
        startedAt: Date.now(),
        activeDevices: new Set(),
        deviceStartedAt: new Map(),
        slowAlerted: false,
        slowAlertedDevices: new Set(),
      });
      logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: req.session?.username, message: `DHCP discovery started for "${input.name}"` });
      try {
        let discoveryResult: DiscoveryResult;
        if (input.type === "windowsserver") {
          const subnets = await windowsServer.discoverDhcpScopes(input.config as any, ac.signal);
          // Windows Server stamps subnets with config.host as their fortigateDevice,
          // so the "known roster" is just the DHCP server host itself.
          const wsHost = (input.config as any).host as string;
          discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames: wsHost ? [wsHost] : [], fortiSwitches: [], fortiAps: [], vips: [], switchInventoriedDevices: [], apInventoriedDevices: [] };
        } else if (input.type === "fortigate") {
          discoveryResult = await fortigate.discoverDhcpSubnets(input.config as any, ac.signal);
        } else {
          discoveryResult = await fortimanager.discoverDhcpSubnets(input.config as any, ac.signal);
        }
        const syncResult = await syncDhcpSubnets(integration.id, input.name, input.type, discoveryResult, req.session?.username, "full");
        response.dhcpDiscovery = syncResult;
        logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: req.session?.username, message: `DHCP discovery completed for "${input.name}" — ${syncResult.created.length} created, ${syncResult.updated.length} updated, ${syncResult.skipped.length} skipped` });
      } catch (err: any) {
        if (err.name !== "AbortError") {
          response.dhcpDiscoveryError = err.message || "DHCP discovery failed";
          logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: req.session?.username, level: "error", message: `DHCP discovery failed for "${input.name}": ${err.message || "Unknown error"}` });
        }
      } finally {
        activeDiscovery.delete(integration.id);
      }
    }

    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/integrations/:id
router.put("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError(404, "Integration not found");

    const input = UpdateIntegrationSchema.parse(req.body);
    const currentConfig = existing.config as Record<string, unknown>;

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.autoDiscover !== undefined) data.autoDiscover = input.autoDiscover;
    if (input.pollInterval !== undefined) data.pollInterval = input.pollInterval;
    if (input.config) {
      // Merge config — preserve secrets if not re-submitted
      const newConfig = { ...currentConfig, ...input.config };
      if (!input.config.apiToken) {
        newConfig.apiToken = currentConfig.apiToken;
      }
      if (!input.config.fortigateApiToken) {
        newConfig.fortigateApiToken = currentConfig.fortigateApiToken;
      }
      if (!input.config.password) {
        newConfig.password = currentConfig.password;
      }
      if (!input.config.clientSecret) {
        newConfig.clientSecret = currentConfig.clientSecret;
      }
      if (!input.config.bindPassword) {
        newConfig.bindPassword = currentConfig.bindPassword;
      }
      // Validate the optional FMG/FortiGate response-time SNMP override.
      // Empty string and null both mean "clear" — normalize to null so the
      // probe path sees a consistent "not set" signal.
      if (existing.type === "fortimanager" || existing.type === "fortigate") {
        const credId = newConfig.monitorCredentialId;
        if (credId === "" || credId == null) {
          newConfig.monitorCredentialId = null;
        } else if (typeof credId === "string") {
          const cred = await prisma.credential.findUnique({ where: { id: credId } });
          if (!cred) throw new AppError(400, "Selected monitor credential not found");
          if (cred.type !== "snmp") throw new AppError(400, "Monitor credential override must be SNMP");
        }
        // Match the POST validation: any toggle set to "snmp" requires a credential.
        const snmpStreams: string[] = [];
        if (newConfig.monitorResponseTimeSource === "snmp") snmpStreams.push("Response time");
        if (newConfig.monitorTelemetrySource    === "snmp") snmpStreams.push("Telemetry");
        if (newConfig.monitorInterfacesSource   === "snmp") snmpStreams.push("Interfaces");
        if (newConfig.monitorLldpSource         === "snmp") snmpStreams.push("LLDP");
        if (snmpStreams.length > 0 && !newConfig.monitorCredentialId) {
          throw new AppError(400, `Select an SNMP credential to route ${snmpStreams.join(", ")} via SNMP`);
        }
        // Per-class FortiSwitch / FortiAP monitor credentials. Same rules as
        // POST: the credential must exist and must be of type "snmp".
        for (const [field, label] of [
          ["fortiswitchMonitor", "FortiSwitch monitor credential"],
          ["fortiapMonitor",     "FortiAP monitor credential"],
        ] as const) {
          const block = (newConfig as any)[field];
          if (!block) continue;
          // Normalize empty-string credentialIds to null for consistency with the probe path.
          if (block.snmpCredentialId === "") block.snmpCredentialId = null;
          if (block.enabled && !block.snmpCredentialId) throw new AppError(400, `${label} must be selected when direct polling is enabled`);
          if (block.snmpCredentialId) {
            const cred = await prisma.credential.findUnique({ where: { id: block.snmpCredentialId } });
            if (!cred) throw new AppError(400, `${label} not found`);
            if (cred.type !== "snmp") throw new AppError(400, `${label} must be SNMP`);
          }
        }
        validateAutoMonitorPatterns(newConfig);
      }
      data.config = newConfig;
    }

    const updated = await prisma.integration.update({
      where: { id: req.params.id },
      data,
    });

    logEvent({ action: "integration.updated", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: req.session?.username, message: `Integration "${updated.name}" updated` });

    const finalConfig = (updated.config as Record<string, unknown>) || {};
    const response: Record<string, unknown> = stripSecret(updated);

    // Auto-register FortiManager/FortiGate IP as asset/reservation
    if ((existing.type === "fortimanager" || existing.type === "fortigate") && finalConfig.host && typeof finalConfig.host === "string") {
      const registration = await registerFortinetHost(existing.type, finalConfig.host, updated.name, false);
      if (registration?.conflicts?.length) {
        response.conflicts = registration.conflicts;
      }
    }

    // Discovery is NOT auto-triggered on save — the operator starts it
    // explicitly from the Discover button, or the scheduler picks it up on
    // the next polling tick. Previously Save kicked off a run, which made
    // editing noisy (a filter tweak would block the next discovery slot
    // with a full run the operator didn't ask for).

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/integrations/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError(404, "Integration not found");
    await prisma.integration.delete({ where: { id: req.params.id } });
    logEvent({ action: "integration.deleted", resourceType: "integration", resourceId: req.params.id, resourceName: existing.name, actor: req.session?.username, message: `Integration "${existing.name}" deleted` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/test
router.post("/:id/test", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");

    const config = integration.config as Record<string, unknown>;
    let result: { ok: boolean; message: string; version?: string };

    logEvent({ action: "integration.test.started", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: req.session?.username, message: `Connection test started for "${integration.name}"` });

    if (integration.type === "fortimanager") {
      result = await fortimanager.testConnection(config as any);
    } else if (integration.type === "fortigate") {
      result = await fortigate.testConnection(config as any);
    } else if (integration.type === "windowsserver") {
      result = await windowsServer.testConnection(config as any);
    } else if (integration.type === "entraid") {
      result = await entraId.testConnection(config as any);
    } else if (integration.type === "activedirectory") {
      result = await activeDirectory.testConnection(config as any);
    } else {
      result = { ok: false, message: `Unknown integration type: ${integration.type}` };
    }

    // Save test result
    await prisma.integration.update({
      where: { id: req.params.id },
      data: { lastTestAt: new Date(), lastTestOk: result.ok },
    });

    logEvent({ action: "integration.test.completed", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: req.session?.username, level: result.ok ? "info" : "warning", message: `Connection test ${result.ok ? "succeeded" : "failed"} for "${integration.name}": ${result.message}` });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/test/fortigate-sample — direct-transport sanity check
// Pulls the FMG device list, picks a random managed FortiGate, and runs a
// FortiGate connection test against it using the stored direct-mode creds.
// Only valid for type=fortimanager integrations with useProxy=false; the
// client only invokes it after the main /:id/test call has succeeded.
router.post("/:id/test/fortigate-sample", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) throw new AppError(404, "Integration not found");
    if (integration.type !== "fortimanager") throw new AppError(400, "FortiGate sample test is only valid for FortiManager integrations");

    const cfg = integration.config as Record<string, unknown>;
    if (cfg.useProxy !== false) throw new AppError(400, "FortiGate sample test is only valid when the FMG proxy is disabled");

    const fgResult = await fortimanager.testRandomFortiGate(cfg as any);
    const message = fgResult.ok
      ? `Randomly selected FortiGate "${fgResult.deviceName}" reachable${fgResult.version ? ` (FortiOS ${fgResult.version})` : ""}`
      : `Randomly selected FortiGate "${fgResult.deviceName}" failed: ${fgResult.message}`;

    // If the random FortiGate can't be reached, the direct-transport path
    // won't work — discovery would fail. Flip lastTestOk so the Discover
    // button reflects the real readiness, and stamp the timestamp.
    if (!fgResult.ok) {
      await prisma.integration.update({
        where: { id: req.params.id },
        data: { lastTestAt: new Date(), lastTestOk: false },
      }).catch(() => {});
    }

    logEvent({ action: "integration.test.fortigate-sample", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: req.session?.username, level: fgResult.ok ? "info" : "warning", message: `FortiGate sample test ${fgResult.ok ? "succeeded" : "failed"} for "${integration.name}" on ${fgResult.deviceName}: ${fgResult.message}` });

    res.json({ ok: fgResult.ok, message, deviceName: fgResult.deviceName });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/test/fortigate-sample — pre-save variant of the above.
// Used by the edit modal so the random-FortiGate check runs against the
// unsaved form config. If an existingId is supplied, blank secrets are
// merged from the stored config (same rule as /test).
router.post("/test/fortigate-sample", async (req, res, next) => {
  try {
    const input = CreateIntegrationSchema.parse(req.body);
    if (input.type !== "fortimanager") throw new AppError(400, "FortiGate sample test is only valid for FortiManager integrations");
    const cfg = input.config as Record<string, unknown>;
    if (cfg.useProxy !== false) throw new AppError(400, "FortiGate sample test is only valid when the FMG proxy is disabled");

    const existingId = typeof req.body?.id === "string" ? req.body.id : null;
    if (existingId) {
      const existing = await prisma.integration.findUnique({ where: { id: existingId } });
      if (existing) {
        const stored = existing.config as Record<string, unknown>;
        if (!cfg.apiToken || typeof cfg.apiToken !== "string") cfg.apiToken = stored.apiToken;
        if (!cfg.fortigateApiToken || typeof cfg.fortigateApiToken !== "string") cfg.fortigateApiToken = stored.fortigateApiToken;
      }
    }

    const fgResult = await fortimanager.testRandomFortiGate(cfg as any);
    const message = fgResult.ok
      ? `Randomly selected FortiGate "${fgResult.deviceName}" reachable${fgResult.version ? ` (FortiOS ${fgResult.version})` : ""}`
      : `Randomly selected FortiGate "${fgResult.deviceName}" failed: ${fgResult.message}`;

    if (existingId && !fgResult.ok) {
      await prisma.integration.update({
        where: { id: existingId },
        data: { lastTestAt: new Date(), lastTestOk: false },
      }).catch(() => {});
    }

    res.json({ ok: fgResult.ok, message, deviceName: fgResult.deviceName });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/query — proxy a manual API call to a FortiManager or FortiGate
router.post("/:id/query", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) throw new AppError(404, "Integration not found");

    if (integration.type === "fortimanager") {
      // Two transports under one endpoint:
      //  - mode "fmg" (default): JSON-RPC to FortiManager
      //  - mode "fortigate": REST direct to a managed FortiGate, using the
      //    integration's stored direct-mode credentials. FMG is still consulted
      //    to resolve the gate's real management-interface IP.
      const mode = (req.body && typeof req.body === "object" && (req.body as any).mode) || "fmg";

      if (mode === "fortigate") {
        const { deviceName, method, path, query } = z.object({
          mode: z.literal("fortigate"),
          deviceName: z.string().min(1),
          method: z.enum(["GET", "POST"]).optional().default("GET"),
          path: z.string().min(1),
          query: z.record(z.string()).optional(),
        }).parse(req.body);
        const result = await fortimanager.proxyQueryViaFortigate(
          integration.config as any,
          deviceName,
          method,
          path,
          query,
        );
        sendProxyJson(res, result);
        return;
      }

      const { method, params } = z.object({
        mode: z.literal("fmg").optional(),
        method: z.string().min(1),
        params: z.array(z.unknown()),
      }).parse(req.body);
      const result = await fortimanager.proxyQuery(integration.config as any, method, params);
      sendProxyJson(res, result);
      return;
    }

    if (integration.type === "fortigate") {
      const { method, path, query } = z.object({
        method: z.enum(["GET", "POST"]).optional().default("GET"),
        path: z.string().min(1),
        query: z.record(z.string()).optional(),
      }).parse(req.body);
      const result = await fortigate.proxyQuery(integration.config as any, method, path, query);
      sendProxyJson(res, result);
      return;
    }

    if (integration.type === "entraid") {
      const { path, query } = z.object({
        path: z.string().min(1),
        query: z.record(z.string()).optional(),
      }).parse(req.body);
      const result = await entraId.proxyQuery(integration.config as any, path, query);
      sendProxyJson(res, result);
      return;
    }

    if (integration.type === "activedirectory") {
      const body = z.object({
        filter:     z.string().optional(),
        baseDn:     z.string().optional(),
        scope:      z.enum(["sub", "one", "base"]).optional(),
        attributes: z.array(z.string()).optional(),
        sizeLimit:  z.number().int().min(1).max(500).optional(),
      }).parse(req.body);
      const result = await activeDirectory.proxyQuery(integration.config as any, body);
      sendProxyJson(res, result);
      return;
    }

    throw new AppError(400, "API query is not supported for this integration type");
  } catch (err) {
    next(err);
  }
});

// ─── Auto-Monitor Interfaces ─────────────────────────────────────────────────
// Three endpoints power the "Auto-Monitor Interfaces" card on the integration
// modal's Monitoring tab subtabs:
//   - GET  ../interface-aggregate?class=...     → "By name" checklist source
//   - POST ../interface-aggregate/preview       → live preview while editing
//   - POST ../interface-aggregate/apply         → "Save and apply now" trigger
//
// The selection itself is persisted on Integration.config under
// fortigateMonitor / fortiswitchMonitor / fortiapMonitor as
// `autoMonitorInterfaces` and validated by the existing PUT handler.

const ClassQuerySchema = z.enum(["fortigate", "fortiswitch", "fortiap"]);

// Mirrors AutoMonitorInterfacesSchema from the top of the file but accepts a
// client-supplied selection that hasn't been persisted yet (the live preview
// fires on every keystroke before Save). Same shape, same validation rules.
const PreviewBodySchema = z.object({
  class:     ClassQuerySchema,
  selection: z.discriminatedUnion("mode", [
    z.object({
      mode:  z.literal("names"),
      names: z.array(z.string().trim().min(1)).min(1).max(200),
    }).strict(),
    z.object({
      mode:     z.literal("wildcard"),
      patterns: z.array(z.string().trim().min(1)).min(1).max(50),
      onlyUp:   z.boolean().optional().default(false),
    }).strict(),
    z.object({
      mode:   z.literal("type"),
      types:  z.array(z.enum(["physical", "aggregate", "vlan", "loopback", "tunnel"])).min(1),
      onlyUp: z.boolean().optional().default(true),
    }).strict(),
  ]).nullable(),
});

router.get("/:id/interface-aggregate", async (req, res, next) => {
  try {
    const klass = ClassQuerySchema.parse(req.query.class);
    const integ = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integ) throw new AppError(404, "Integration not found");
    const rows = await autoMonitor.getInterfaceAggregate(req.params.id, klass);
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/interface-aggregate/preview", async (req, res, next) => {
  try {
    const body = PreviewBodySchema.parse(req.body);
    const integ = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integ) throw new AppError(404, "Integration not found");
    // Cross-check wildcard patterns syntactically here too — the resolver
    // would throw on the first call inside previewAutoMonitorForClass, but
    // doing it up front means a clearer 400 in the editor.
    if (body.selection?.mode === "wildcard") {
      for (const pat of body.selection.patterns) autoMonitor.compileWildcard(pat);
    }
    const result = await autoMonitor.previewAutoMonitorForClass(req.params.id, body.class, body.selection);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/interface-aggregate/apply", async (req, res, next) => {
  try {
    const klass = ClassQuerySchema.parse(req.body?.class);
    const integ = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integ) throw new AppError(404, "Integration not found");
    const cfg = (integ.config ?? {}) as Record<string, any>;
    const blockKey = klass === "fortigate" ? "fortigateMonitor"
                    : klass === "fortiswitch" ? "fortiswitchMonitor"
                    : "fortiapMonitor";
    const selection = (cfg[blockKey]?.autoMonitorInterfaces ?? null) as autoMonitor.AutoMonitorSelection;
    const result = await autoMonitor.applyAutoMonitorForClass(req.params.id, klass, selection, (req as any).session?.username);
    if (result.interfacesAdded > 0) {
      logEvent({
        action:       "integration.auto_monitor_interfaces.applied",
        resourceType: "integration",
        resourceId:   integ.id,
        resourceName: integ.name,
        actor:        (req as any).session?.username,
        message:      `Auto-monitor interfaces applied for "${integ.name}" (${klass}) — ${result.devices} device(s), ${result.interfacesAdded} interface(s) added`,
        details:      { class: klass, devices: result.devices, interfacesAdded: result.interfacesAdded },
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/register — overwrite selected fields on conflicting reservation
router.post("/:id/register", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");

    const config = integration.config as Record<string, unknown>;
    if (!config.host || typeof config.host !== "string") {
      throw new AppError(400, "Integration has no host configured");
    }

    // fields: which proposed fields to apply to the existing reservation
    const fields: string[] = Array.isArray(req.body?.fields) ? req.body.fields : [];
    const result = await registerFortinetHost(integration.type, config.host as string, integration.name, true, fields);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Shared discovery trigger (used by route handler + scheduler) ─────────────

export function isDiscoveryRunning(integrationId: string): boolean {
  return activeDiscovery.has(integrationId);
}

/**
 * Iterate all in-flight discoveries; for each, compare elapsed time against
 * the rolling baseline from `discoveryDurationService`. If a run exceeds its
 * threshold and hasn't been flagged yet, emit a single
 * `integration.discover.slow` event (per run, per FortiGate). Deduplicated
 * via `slowAlerted` / `slowAlertedDevices` on the activeDiscovery entry —
 * those flags are cleared when the run completes (or the device finishes).
 *
 * Called by the 30s background job and inline on the /discoveries poll, so
 * the UI flips to amber promptly without waiting on the slower timer.
 */
export async function checkForSlowRuns(): Promise<void> {
  if (activeDiscovery.size === 0) return;

  // Gather all (integration, device) unit keys we need baselines for.
  const unitKeys: string[] = [];
  for (const [id, entry] of activeDiscovery.entries()) {
    if (!entry.slowAlerted) unitKeys.push(id);
    if (entry.type === "fortimanager") {
      for (const dev of entry.deviceStartedAt.keys()) {
        if (!entry.slowAlertedDevices.has(dev)) unitKeys.push(`${id}:${dev}`);
      }
    }
  }
  if (unitKeys.length === 0) return;

  let baselines: Map<string, Baseline | null>;
  try {
    baselines = await getBaselines(unitKeys);
  } catch {
    return;
  }

  const now = Date.now();
  for (const [id, entry] of activeDiscovery.entries()) {
    // Overall-run threshold — applies to every integration type.
    if (!entry.slowAlerted) {
      const bl = baselines.get(id) ?? null;
      const elapsed = now - entry.startedAt;
      if (bl && elapsed > bl.thresholdMs) {
        entry.slowAlerted = true;
        logEvent({
          action: "integration.discover.slow",
          resourceType: "integration",
          resourceId: id,
          resourceName: entry.name,
          level: "warning",
          message: `Discovery for "${entry.name}" is running longer than normal — ${fmtSec(elapsed)} elapsed vs typical ${fmtSec(bl.avgMs)} (threshold ${fmtSec(bl.thresholdMs)}, ${bl.sampleCount} samples)`,
          details: {
            scope: "integration",
            integrationId: id,
            elapsedMs: elapsed,
            avgMs: bl.avgMs,
            stddevMs: bl.stddevMs,
            thresholdMs: bl.thresholdMs,
            sampleCount: bl.sampleCount,
          },
        });
      }
    }

    // Per-FortiGate threshold — FMG only.
    if (entry.type === "fortimanager") {
      for (const [dev, devStart] of entry.deviceStartedAt.entries()) {
        if (entry.slowAlertedDevices.has(dev)) continue;
        const key = `${id}:${dev}`;
        const bl = baselines.get(key) ?? null;
        const elapsed = now - devStart;
        if (bl && elapsed > bl.thresholdMs) {
          entry.slowAlertedDevices.add(dev);
          logEvent({
            action: "integration.discover.slow",
            resourceType: "integration",
            resourceId: id,
            resourceName: entry.name,
            level: "warning",
            message: `Discovery on FortiGate "${dev}" via "${entry.name}" is running longer than normal — ${fmtSec(elapsed)} elapsed vs typical ${fmtSec(bl.avgMs)} (threshold ${fmtSec(bl.thresholdMs)}, ${bl.sampleCount} samples)`,
            details: {
              scope: "fortigate",
              integrationId: id,
              device: dev,
              elapsedMs: elapsed,
              avgMs: bl.avgMs,
              stddevMs: bl.stddevMs,
              thresholdMs: bl.thresholdMs,
              sampleCount: bl.sampleCount,
            },
          });
        }
      }
    }
  }
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/**
 * Validates the integration, registers it in activeDiscovery, and fires the
 * discovery pipeline detached (returns before it completes). Throws AppError
 * on validation failure so callers can handle it appropriately.
 *
 * actor: the username triggering the run, or "auto-discovery" for scheduled runs.
 */
export async function triggerDiscovery(integrationId: string, actor: string): Promise<void> {
  const integration = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!integration) throw new AppError(404, "Integration not found");
  if (!integration.lastTestOk) throw new AppError(400, "Run a successful connection test before discovering");

  const config = integration.config as Record<string, unknown>;
  if (integration.type === "entraid") {
    if (!config.tenantId) throw new AppError(400, "Integration has no tenant ID configured");
    if (!config.clientId) throw new AppError(400, "Integration has no client ID configured");
    if (!config.clientSecret) throw new AppError(400, "Integration has no client secret configured");
  } else {
    if (!config.host) throw new AppError(400, "Integration has no host configured");
    if (integration.type === "fortimanager" && !config.apiToken) throw new AppError(400, "Integration has no API token configured");
    if (integration.type === "fortigate" && !config.apiToken) throw new AppError(400, "Integration has no API token configured");
    if (integration.type === "windowsserver" && !config.username) throw new AppError(400, "Integration has no username configured");
    if (integration.type === "activedirectory") {
      if (!config.bindDn) throw new AppError(400, "Integration has no bind DN configured");
      if (!config.bindPassword) throw new AppError(400, "Integration has no bind password configured");
      if (!config.baseDn) throw new AppError(400, "Integration has no base DN configured");
    }
  }

  activeDiscovery.get(integrationId)?.controller.abort();
  const ac = new AbortController();
  const integrationName = integration.name;
  const integrationType = integration.type;
  const runStartedAt = Date.now();
  activeDiscovery.set(integrationId, {
    controller: ac,
    name: integrationName,
    type: integrationType,
    startedAt: runStartedAt,
    activeDevices: new Set(),
    deviceStartedAt: new Map(),
    slowAlerted: false,
    slowAlertedDevices: new Set(),
  });

  await prisma.integration.update({ where: { id: integrationId }, data: { lastDiscoveryAt: new Date() } });

  const label = actor === "auto-discovery" ? "Scheduled" : "Manual";
  const kindLabel = (integration.type === "entraid" || integration.type === "activedirectory") ? "device discovery" : "DHCP discovery";
  logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, message: `${label} ${kindLabel} started for "${integrationName}"` });

  const onProgress: DiscoveryProgressCallback = (step, level, message, device) => {
    logEvent({ action: `integration.${step}`, resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
    if (device) {
      const entry = activeDiscovery.get(integrationId);
      if (entry) {
        // Any terminal per-device event clears the device from the active
        // set. `discover.device.complete` is the happy path; `.skip` and
        // the error-level `discover.device` event both also end per-device
        // work and must release the slot — otherwise devices that time out
        // or error accumulate in activeDevices and the UI shows far more
        // gates "in flight" than the concurrency cap actually allows.
        const isTerminal =
          step === "discover.device.complete" ||
          step === "discover.device.skip" ||
          (step === "discover.device" && level === "error");
        if (isTerminal) {
          const start = entry.deviceStartedAt.get(device);
          entry.deviceStartedAt.delete(device);
          entry.activeDevices.delete(device);
          entry.slowAlertedDevices.delete(device);
          // Only record a timing sample for successful completions — skips
          // and failures shouldn't influence the slow-run baseline.
          if (step === "discover.device.complete" && start !== undefined) {
            const unitKey = `${integrationId}:${device}`;
            recordSample(unitKey, Date.now() - start).catch(() => {});
          }
        } else if (step === "discover.device.start") {
          entry.deviceStartedAt.set(device, Date.now());
          entry.activeDevices.add(device);
        }
      }
    }
  };

  (async () => {
    try {
      let discoveryResult: DiscoveryResult;

      // Accumulate per-device sync totals for the completion log
      const syncTotals = { created: [] as string[], updated: [] as string[], skipped: [] as string[], deprecated: [] as string[], decommissionedSwitches: [] as string[], decommissionedAps: [] as string[] };

      // Per-device callback: sync each FortiGate's data as it arrives (phases 1, 3–9).
      // Phase 2 (stale deprecation) runs separately at the end once all devices are known.
      const onDeviceComplete = async (deviceResult: DiscoveryResult) => {
        const r = await syncDhcpSubnets(integrationId, integrationName, integration.type, deviceResult, actor, "skip-deprecation");
        syncTotals.created.push(...r.created);
        syncTotals.updated.push(...r.updated);
        syncTotals.skipped.push(...r.skipped);
      };

      if (integration.type === "entraid") {
        // Entra ID discovery produces assets only — no subnets, reservations, or VIPs.
        const result = await entraId.discoverDevices(config as any, ac.signal, onProgress);
        if (!ac.signal.aborted) {
          const r = await syncEntraDevices(integrationId, integrationName, result, actor);
          syncTotals.created.push(...r.created);
          syncTotals.updated.push(...r.updated);
          syncTotals.skipped.push(...r.skipped);
        }
      } else if (integration.type === "activedirectory") {
        // Active Directory discovery produces assets only — no subnets, reservations, or VIPs.
        const result = await activeDirectory.discoverDevices(config as any, ac.signal, onProgress);
        if (!ac.signal.aborted) {
          const r = await syncActiveDirectoryDevices(integrationId, integrationName, result, actor);
          syncTotals.created.push(...r.created);
          syncTotals.updated.push(...r.updated);
          syncTotals.skipped.push(...r.skipped);
        }
      } else if (integration.type === "windowsserver") {
        const subnets = await windowsServer.discoverDhcpScopes(config as any, ac.signal);
        const wsHost = (config as any).host as string;
        discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames: wsHost ? [wsHost] : [], fortiSwitches: [], fortiAps: [], vips: [], switchInventoriedDevices: [], apInventoriedDevices: [] };
        // Windows Server is a single host — no per-device iteration, sync the full result normally
        const r = await syncDhcpSubnets(integrationId, integrationName, integration.type, discoveryResult, actor);
        syncTotals.created.push(...r.created);
        syncTotals.updated.push(...r.updated);
        syncTotals.skipped.push(...r.skipped);
        syncTotals.deprecated.push(...r.deprecated);
      } else if (integration.type === "fortigate") {
        // Single FortiGate — no per-device iteration, sync the full result in one pass
        discoveryResult = await fortigate.discoverDhcpSubnets(config as any, ac.signal, onProgress);
        if (!ac.signal.aborted) {
          const r = await syncDhcpSubnets(integrationId, integrationName, integration.type, discoveryResult, actor);
          syncTotals.created.push(...r.created);
          syncTotals.updated.push(...r.updated);
          syncTotals.skipped.push(...r.skipped);
          syncTotals.deprecated.push(...r.deprecated);
          syncTotals.decommissionedSwitches.push(...(r.decommissionedSwitches || []));
          syncTotals.decommissionedAps.push(...(r.decommissionedAps || []));
        }
      } else {
        // FortiManager: onDeviceComplete fires after each managed FortiGate is queried,
        // syncing subnets/assets/reservations incrementally.
        discoveryResult = await fortimanager.discoverDhcpSubnets(config as any, ac.signal, onProgress, integration.pollInterval ?? 24, onDeviceComplete);
        // Skip Phase 2 (stale deprecation) if the run was aborted — an aborted
        // run shouldn't take destructive actions, even though the FMG device
        // roster used for deprecation is captured up front (not per-device).
        if (!ac.signal.aborted) {
          // Run deprecation + DNS/OUI lookups once, now that all devices have been synced.
          const r = await syncDhcpSubnets(integrationId, integrationName, integration.type, discoveryResult, actor, "finalize");
          syncTotals.deprecated.push(...r.deprecated);
          syncTotals.decommissionedSwitches.push(...(r.decommissionedSwitches || []));
          syncTotals.decommissionedAps.push(...(r.decommissionedAps || []));
        }
      }

      // ── ORIGINAL BATCH SYNC (commented out — replaced by per-device callback above) ──
      // const syncResult = await syncDhcpSubnets(integrationId, integrationName, integration.type, discoveryResult, actor);

      const assetsOnly = integration.type === "entraid" || integration.type === "activedirectory";
      if (ac.signal.aborted) {
        const abortSuffix = assetsOnly ? "" : " (stale-subnet deprecation skipped)";
        logEvent({ action: "integration.discover.aborted", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "warning", message: `${label} ${kindLabel} aborted for "${integrationName}" — ${syncTotals.created.length} created, ${syncTotals.updated.length} updated, ${syncTotals.skipped.length} skipped${abortSuffix}` });
      } else {
        const deprecatedSuffix = assetsOnly ? "" : `, ${syncTotals.deprecated.length} deprecated`;
        const decomSwSuffix = syncTotals.decommissionedSwitches.length > 0 ? `, ${syncTotals.decommissionedSwitches.length} FortiSwitch(es) decommissioned` : "";
        const decomApSuffix = syncTotals.decommissionedAps.length      > 0 ? `, ${syncTotals.decommissionedAps.length} FortiAP(s) decommissioned`      : "";
        logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, message: `${label} ${kindLabel} completed for "${integrationName}" — ${syncTotals.created.length} created, ${syncTotals.updated.length} updated, ${syncTotals.skipped.length} skipped${deprecatedSuffix}${decomSwSuffix}${decomApSuffix}` });
        // Record overall duration sample for slow-run detection. Aborts and
        // errors are intentionally not recorded — a failed run would poison
        // the rolling average used to compute the "slow" threshold.
        recordSample(integrationId, Date.now() - runStartedAt).catch(() => {});
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "error", message: `${label} ${kindLabel} failed for "${integrationName}": ${err.message || "Unknown error"}` });
      }
    } finally {
      activeDiscovery.delete(integrationId);
    }
  })();
}

// POST /api/v1/integrations/:id/discover — manually trigger DHCP discovery
router.post("/:id/discover", async (req, res, next) => {
  try {
    await triggerDiscovery(req.params.id, req.session?.username ?? "");
    res.status(202).json({ message: "Discovery started" });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/test — test without saving (for the create form)
router.post("/test", async (req, res, next) => {
  try {
    const input = CreateIntegrationSchema.parse(req.body);
    let result: { ok: boolean; message: string; version?: string };

    // If an existing integration id is provided, merge unmasked secrets
    // from the stored config when the form fields were left blank.
    const existingId = typeof req.body?.id === "string" ? req.body.id : null;
    if (existingId) {
      const existing = await prisma.integration.findUnique({ where: { id: existingId } });
      if (existing) {
        const stored = existing.config as Record<string, unknown>;
        const cfg = input.config as Record<string, unknown>;
        if ((input.type === "fortimanager" || input.type === "fortigate") && (!cfg.apiToken || typeof cfg.apiToken !== "string")) {
          cfg.apiToken = stored.apiToken;
        }
        if (input.type === "fortimanager" && (!cfg.fortigateApiToken || typeof cfg.fortigateApiToken !== "string")) {
          cfg.fortigateApiToken = stored.fortigateApiToken;
        }
        if (input.type === "windowsserver" && (!cfg.password || typeof cfg.password !== "string")) {
          cfg.password = stored.password;
        }
        if (input.type === "entraid" && (!cfg.clientSecret || typeof cfg.clientSecret !== "string")) {
          cfg.clientSecret = stored.clientSecret;
        }
        if (input.type === "activedirectory" && (!cfg.bindPassword || typeof cfg.bindPassword !== "string")) {
          cfg.bindPassword = stored.bindPassword;
        }
      }
    }

    if (input.type === "fortimanager") {
      result = await fortimanager.testConnection(input.config);
    } else if (input.type === "fortigate") {
      result = await fortigate.testConnection(input.config);
    } else if (input.type === "windowsserver") {
      result = await windowsServer.testConnection(input.config);
    } else if (input.type === "entraid") {
      result = await entraId.testConnection(input.config);
    } else if (input.type === "activedirectory") {
      result = await activeDirectory.testConnection(input.config);
    } else {
      result = { ok: false, message: `Unknown integration type: ${(input as any).type}` };
    }

    // If this test was tied to an existing integration and passed, stamp the
    // card's last-tested fields so the UI and the discovery gate see the
    // success. We only persist on success — a failing draft-form test should
    // not tear down a previously-working integration's "ok" status.
    if (existingId && result.ok) {
      await prisma.integration.update({
        where: { id: existingId },
        data: { lastTestAt: new Date(), lastTestOk: true },
      }).catch(() => {});
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  if (!isValidIpAddress(ip)) return false;
  const parts = ip.split(".").map(Number);
  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

interface ConflictEntry {
  type: "reservation";
  existing: Record<string, unknown>;
  proposed: Record<string, unknown>;
}

/**
 * Register a FortiManager or FortiGate host IP as a subnet reservation and asset.
 * If force=false, returns conflicts instead of overwriting.
 * If force=true, overwrites selected fields on the existing reservation.
 */
async function registerFortinetHost(integrationType: string, host: string, integrationName: string, force: boolean, fields: string[] = []) {
  if (!isValidIpAddress(host)) return { conflicts: [], created: [] };

  const subnets = await prisma.subnet.findMany();
  const matchingSubnet = subnets.find((s) => ipInCidr(host, s.cidr));

  if (!matchingSubnet && !isPrivateIp(host)) return { conflicts: [], created: [] };

  const conflicts: ConflictEntry[] = [];
  const created: string[] = [];
  const hostname = integrationName.toLowerCase().replace(/\s+/g, "-");
  const isFortiGate = integrationType === "fortigate";
  const productLabel = isFortiGate ? "FortiGate" : "FortiManager";
  const assetType: "firewall" | "server" = isFortiGate ? "firewall" : "server";

  // ── Reservation ──
  const proposedReservation = {
    ipAddress: host,
    hostname,
    owner: "network-team",
    projectRef: `${productLabel} Integration`,
    notes: `Auto-registered from ${productLabel} integration: ${integrationName}`,
    status: "active" as const,
    sourceType: (isFortiGate ? "fortigate" : "fortimanager") as "fortigate" | "fortimanager",
  };

  if (matchingSubnet) {
    const existingRes = await prisma.reservation.findFirst({
      where: { subnetId: matchingSubnet.id, ipAddress: host, status: "active" },
    });

    if (existingRes) {
      if (force) {
        // Only overwrite the fields the admin selected
        const updateData: Record<string, unknown> = {};
        const allowedFields = ["hostname", "owner", "projectRef", "notes", "status"];
        for (const f of fields) {
          if (allowedFields.includes(f) && f in proposedReservation) {
            updateData[f] = (proposedReservation as Record<string, unknown>)[f];
          }
        }
        if (Object.keys(updateData).length > 0) {
          await prisma.reservation.update({
            where: { id: existingRes.id },
            data: updateData,
          });
        }
        created.push("reservation");
      } else {
        conflicts.push({
          type: "reservation",
          existing: {
            id: existingRes.id,
            ipAddress: existingRes.ipAddress,
            hostname: existingRes.hostname,
            owner: existingRes.owner,
            projectRef: existingRes.projectRef,
            notes: existingRes.notes,
            status: existingRes.status,
            subnetCidr: matchingSubnet.cidr,
          },
          proposed: { ...proposedReservation, subnetCidr: matchingSubnet.cidr },
        });
      }
    } else {
      await prisma.reservation.create({
        data: { subnetId: matchingSubnet.id, ...proposedReservation },
      });
      created.push("reservation");
    }
  }

  // ── Asset (always create — multiple assets may share an IP) ──
  const proposedAsset = {
    ipAddress: host,
    hostname,
    assetType,
    status: "active" as const,
    manufacturer: "Fortinet",
    model: productLabel,
    department: "Network Security",
    notes: `Auto-registered from ${productLabel} integration: ${integrationName}`,
    tags: [integrationType, "auto-registered"],
  };

  await prisma.asset.create({ data: proposedAsset });
  created.push("asset");

  return { conflicts, created };
}

// ─── Conflict detection helper ────────────────────────────────────────────────

interface ProposedReservationData {
  hostname?: string | null;
  owner?: string | null;
  projectRef?: string | null;
  notes?: string | null;
  sourceType: string;
}

async function upsertConflict(
  reservationId: string,
  integrationId: string,
  proposed: ProposedReservationData,
  existing: { hostname?: string | null; owner?: string | null; projectRef?: string | null; notes?: string | null },
): Promise<void> {
  const conflictFields: string[] = [];
  if ((proposed.hostname ?? null) !== (existing.hostname ?? null)) conflictFields.push("hostname");
  if ((proposed.owner ?? null) !== (existing.owner ?? null)) conflictFields.push("owner");
  if ((proposed.projectRef ?? null) !== (existing.projectRef ?? null)) conflictFields.push("projectRef");
  if (conflictFields.length === 0) return;

  const existingConflict = await prisma.conflict.findFirst({
    where: { reservationId, status: "pending" },
  });

  const conflictData = {
    integrationId,
    proposedHostname: proposed.hostname ?? null,
    proposedOwner: proposed.owner ?? null,
    proposedProjectRef: proposed.projectRef ?? null,
    proposedNotes: proposed.notes ?? null,
    proposedSourceType: proposed.sourceType,
    conflictFields,
  };

  if (existingConflict) {
    await prisma.conflict.update({ where: { id: existingConflict.id }, data: conflictData });
  } else {
    await prisma.conflict.create({ data: { reservationId, ...conflictData } });
  }
}

// ─── Batch helper ────────────────────────────────────────────────────────────
// Runs promises in chunks to avoid overwhelming the connection pool
const BATCH_SIZE = 50;
async function batchSettled<T>(items: T[], fn: (item: T) => Promise<any>): Promise<PromiseSettledResult<any>[]> {
  const results: PromiseSettledResult<any>[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const batch = await Promise.allSettled(chunk.map(fn));
    results.push(...batch);
  }
  return results;
}

// ─── Asset index — multi-key lookup for MAC, serial, hostname, IP ───────────
class AssetIndex {
  private byId = new Map<string, any>();
  private byMac = new Map<string, any>();       // normalized MAC → asset
  private bySerial = new Map<string, any>();
  private byHostname = new Map<string, any>();   // lowercase hostname → asset
  private byIp = new Map<string, any>();

  constructor(assets: any[]) {
    for (const a of assets) this.add(a);
  }

  add(a: any) {
    this.byId.set(a.id, a);
    if (a.macAddress) this.byMac.set(a.macAddress.toUpperCase(), a);
    if (Array.isArray(a.macAddresses)) {
      for (const m of a.macAddresses as any[]) {
        if (m.mac) this.byMac.set(m.mac.toUpperCase(), a);
      }
    }
    if (a.serialNumber) this.bySerial.set(a.serialNumber, a);
    if (a.hostname) this.byHostname.set(a.hostname.toLowerCase(), a);
    if (a.ipAddress) this.byIp.set(a.ipAddress, a);
  }

  /** Update indexes after modifying an asset in-place */
  reindex(a: any) { this.add(a); }

  findBySerial(serial: string) { return this.bySerial.get(serial); }

  findByMac(mac: string) { return this.byMac.get(mac.toUpperCase()); }

  /**
   * Broad match: MAC → hostname → IP.
   * Pass `{ allowIpFallback: false }` for ephemeral-identity sources (DHCP leases)
   * where IP recycling would otherwise staple a new MAC onto an unrelated asset.
   */
  findByEntry(mac?: string, hostname?: string, ip?: string, opts: { allowIpFallback?: boolean } = {}): any | undefined {
    const { allowIpFallback = true } = opts;
    if (mac) {
      const norm = mac.toUpperCase().replace(/-/g, ":");
      const hit = this.byMac.get(norm);
      if (hit) return hit;
    }
    if (hostname) {
      const hit = this.byHostname.get(hostname.toLowerCase());
      if (hit) return hit;
    }
    if (ip && allowIpFallback) {
      const hit = this.byIp.get(ip);
      if (hit) return hit;
    }
    return undefined;
  }

  all(): any[] { return [...this.byId.values()]; }
}

/**
 * Sync discovered DHCP subnets into the database.
 * Creates new subnets or updates existing ones with integration/device info.
 * Also creates FortiGate assets and interface IP reservations.
 *
 * Performance: pre-loads all data in 4 parallel queries and builds in-memory
 * indexes for O(1) lookups, avoiding N+1 query patterns. Writes are batched
 * in chunks of 50 via Promise.allSettled for throughput.
 */
// "full"               — run all 9 phases (original batch behaviour, kept for reference)
// "skip-deprecation"   — run phases 1, 3–7 only (used in per-device syncs; no deprecation or DNS/OUI)
// "deprecation-only"   — run only phase 2 (legacy; prefer "finalize")
// "finalize"           — run phase 2 + phases 8–9; called once after all per-device syncs complete
type SyncMode = "full" | "skip-deprecation" | "deprecation-only" | "finalize";

async function syncDhcpSubnets(integrationId: string, integrationName: string, integrationType: string, result: DiscoveryResult, actor?: string, mode: SyncMode = "full") {
  const syncLog = (level: "info" | "error", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const integrationLabel =
    integrationType === "windowsserver" ? "Windows Server" :
    integrationType === "fortigate" ? "FortiGate" :
    "FortiManager";
  const projectRefLabel = `${integrationLabel} Integration`;
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const assetNames: string[] = [];
  const reservationNames: string[] = [];
  const vipNames: string[] = [];
  const dhcpLeases: string[] = [];
  const dhcpReservations: string[] = [];
  const inventoryAssets: string[] = [];
  const deprecated: string[] = [];
  const decommissionedSwitches: string[] = [];
  const decommissionedAps: string[] = [];
  let dnsResolved = 0;
  let ouiResolved = 0;
  let ouiOverridden = 0;
  const now = new Date().toISOString();

  // Per-class auto-monitor settings (FortiGate / FortiSwitch / FortiAP).
  // Read from the integration's config so the discovery sync knows whether
  // to stamp monitorType/monitorCredentialId/monitored on each freshly-
  // discovered asset. FMG and standalone FortiGate share the same config
  // keys; other integration types simply have no fortigateMonitor /
  // fortiswitchMonitor / fortiapMonitor entry, in which case the helpers
  // below resolve to "do nothing".
  type ClassMonCfg = { enabled: boolean; snmpCredentialId: string | null; addAsMonitored: boolean };
  let switchMonitorCfg: ClassMonCfg = { enabled: false, snmpCredentialId: null, addAsMonitored: false };
  let apMonitorCfg:     ClassMonCfg = { enabled: false, snmpCredentialId: null, addAsMonitored: false };
  let fortigateAddAsMonitored = false;
  if (integrationType === "fortimanager" || integrationType === "fortigate") {
    const integ = await prisma.integration.findUnique({ where: { id: integrationId }, select: { config: true } });
    const cfg = (integ?.config as Record<string, unknown>) || {};
    const sw = (cfg.fortiswitchMonitor as Record<string, unknown> | undefined) || {};
    const ap = (cfg.fortiapMonitor     as Record<string, unknown> | undefined) || {};
    const fg = (cfg.fortigateMonitor   as Record<string, unknown> | undefined) || {};
    switchMonitorCfg = {
      enabled: sw.enabled === true,
      snmpCredentialId: typeof sw.snmpCredentialId === "string" ? sw.snmpCredentialId : null,
      addAsMonitored: sw.addAsMonitored === true,
    };
    apMonitorCfg = {
      enabled: ap.enabled === true,
      snmpCredentialId: typeof ap.snmpCredentialId === "string" ? ap.snmpCredentialId : null,
      addAsMonitored: ap.addAsMonitored === true,
    };
    fortigateAddAsMonitored = fg.addAsMonitored === true;
  }

  // Sighting sets for the FortiSwitch / FortiAP decommission sweep below.
  // Populated unconditionally so the pass works in both per-device sync
  // mode (full / skip-deprecation) and the post-pass finalize mode, which
  // gets the *aggregated* discoveryResult and runs the deprecation step.
  const seenSwitchSerials   = new Set<string>();
  const seenSwitchHostnames = new Set<string>();
  const seenApSerials       = new Set<string>();
  const seenApHostnames     = new Set<string>();
  for (const sw of result.fortiSwitches || []) {
    if (sw.serial) seenSwitchSerials.add(sw.serial);
    if (sw.name)   seenSwitchHostnames.add(sw.name);
  }
  for (const ap of result.fortiAps || []) {
    if (ap.serial) seenApSerials.add(ap.serial);
    if (ap.name)   seenApHostnames.add(ap.name);
  }
  const switchInventoriedDevices = new Set<string>(result.switchInventoriedDevices || []);
  const apInventoriedDevices     = new Set<string>(result.apInventoriedDevices     || []);

  // ── Pre-load all data in parallel (4 queries total) ──
  const [blocks, allSubnetsRaw, allReservationsRaw, allAssetsRaw] = await Promise.all([
    prisma.ipBlock.findMany(),
    prisma.subnet.findMany(),
    prisma.reservation.findMany({ where: { status: "active" } }),
    prisma.asset.findMany(),
  ]);

  // ── Build in-memory indexes ──

  // Subnets by CIDR (non-deprecated only) and by blockId
  const subnetByCidr = new Map<string, any>();
  const siblingsByBlockId = new Map<string, any[]>();
  const allSubnets = [...allSubnetsRaw]; // mutable copy — we push newly created subnets here
  for (const s of allSubnets) {
    if (s.status !== "deprecated") {
      subnetByCidr.set(s.cidr, s);
      const siblings = siblingsByBlockId.get(s.blockId) || [];
      siblings.push(s);
      siblingsByBlockId.set(s.blockId, siblings);
    }
  }

  // Active reservations: key = "subnetId|ipAddress"
  const reservationKey = (subnetId: string, ip: string) => `${subnetId}|${ip}`;
  const activeResMap = new Map<string, any>();
  for (const r of allReservationsRaw) {
    if (r.ipAddress) activeResMap.set(reservationKey(r.subnetId, r.ipAddress), r);
    else activeResMap.set(`${r.subnetId}|__full__`, r);
  }

  // Asset index with multi-key lookups
  const assetIdx = new AssetIndex(allAssetsRaw);

  // Blocks sorted by prefix length descending (most specific first) for matching
  const blocksSorted = [...blocks].sort((a, b) => {
    const pa = parseInt(a.cidr.split("/")[1], 10);
    const pb = parseInt(b.cidr.split("/")[1], 10);
    return pb - pa;
  });

  // Helper: find the most specific block that contains a CIDR
  function findParentBlock(cidr: string) {
    return blocksSorted.find((b) => cidrContains(b.cidr, cidr));
  }

  // Helper: find which subnet contains an IP
  function findSubnetForIp(ip: string) {
    return allSubnets.find((s) => s.status !== "deprecated" && ipInCidr(ip, s.cidr));
  }

  // Roster of FortiGates currently configured in the upstream (FortiManager or
  // the standalone FortiGate itself), regardless of online status or include/
  // exclude filter. Phase 2 deprecates subnets whose owning device is NOT in
  // this set — meaning the device was deleted from the upstream. Offline
  // devices remain in the roster, so their subnets are left alone.
  const knownDeviceNames = new Set(result.knownDeviceNames);

  if (mode === "full" || mode === "skip-deprecation") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 1 — Sync subnets (in-memory lookups, individual creates)
  // ══════════════════════════════════════════════════════════════════════════════

  // Collect subnet updates to batch
  const subnetUpdates: Array<{ id: string; data: any }> = [];

  for (const entry of result.subnets) {
    let cidr: string;
    try {
      cidr = normalizeCidr(entry.cidr);
    } catch {
      skipped.push(`${entry.cidr} (invalid CIDR)`);
      continue;
    }

    // Check if a non-deprecated subnet with this CIDR already exists (in-memory)
    const existing = subnetByCidr.get(cidr);
    if (existing) {
      subnetUpdates.push({
        id: existing.id,
        data: {
          discoveredBy: integrationId,
          fortigateDevice: entry.fortigateDevice,
          ...(entry.vlan != null ? { vlan: entry.vlan } : {}),
        },
      });
      updated.push(cidr);
      continue;
    }

    // Find the most specific parent block
    const matchingBlock = findParentBlock(cidr);
    if (!matchingBlock) {
      skipped.push(`${cidr} (no matching parent block)`);
      continue;
    }

    // Check for overlaps with non-deprecated siblings (in-memory)
    const siblings = siblingsByBlockId.get(matchingBlock.id) || [];
    const overlap = siblings.find((s: any) => cidrOverlaps(s.cidr, cidr));
    if (overlap) {
      skipped.push(`${cidr} (overlaps ${overlap.cidr})`);
      continue;
    }

    // Create the subnet
    try {
      const newSubnet = await prisma.subnet.create({
        data: {
          blockId: matchingBlock.id,
          cidr,
          name: `DHCP: ${entry.name} (${entry.fortigateDevice})`,
          purpose: `Discovered from ${integrationLabel} DHCP`,
          status: "available",
          discoveredBy: integrationId,
          fortigateDevice: entry.fortigateDevice,
          tags: ["dhcp-discovered", integrationType],
          ...(entry.vlan != null ? { vlan: entry.vlan } : {}),
        },
      });
      // Update in-memory state so later phases can find this subnet
      allSubnets.push(newSubnet);
      subnetByCidr.set(cidr, newSubnet);
      const blockSiblings = siblingsByBlockId.get(matchingBlock.id) || [];
      blockSiblings.push(newSubnet);
      siblingsByBlockId.set(matchingBlock.id, blockSiblings);
      created.push(cidr);
    } catch (err: any) {
      skipped.push(`${cidr} (create failed)`);
      syncLog("error", `Failed to create subnet ${cidr}: ${err.message || "Unknown error"}`);
    }
  }

  // Batch-execute subnet updates (discoveredBy/fortigateDevice)
  if (subnetUpdates.length > 0) {
    await batchSettled(subnetUpdates, (u) =>
      prisma.subnet.update({ where: { id: u.id }, data: u.data })
    );
  }
  } // end Phases 1 (full | skip-deprecation)

  if (mode !== "skip-deprecation") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 2 — Deprecate stale subnets (single updateMany)
  // ══════════════════════════════════════════════════════════════════════════════

  if (knownDeviceNames.size > 0) {
    // Find stale subnets in-memory first (for the return value)
    const staleSubnets = allSubnets.filter(
      (s) => s.discoveredBy === integrationId && s.status !== "deprecated" &&
             s.fortigateDevice && !knownDeviceNames.has(s.fortigateDevice)
    );
    if (staleSubnets.length > 0) {
      const staleIds = staleSubnets.map((s) => s.id);
      await prisma.subnet.updateMany({
        where: { id: { in: staleIds } },
        data: { status: "deprecated" },
      });
      for (const s of staleSubnets) {
        deprecated.push(s.cidr);
        s.status = "deprecated"; // update in-memory
        logEvent({
          action: "subnet.deprecated",
          resourceType: "subnet",
          resourceId: s.id,
          resourceName: s.name,
          actor,
          message: `Subnet "${s.name}" (${s.cidr}) deprecated — FortiGate "${s.fortigateDevice}" no longer configured in "${integrationName}"`,
          details: {
            reason: "device-removed",
            fortigateDevice: s.fortigateDevice,
            integrationId,
            integrationName,
            cidr: s.cidr,
          },
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 2b — Decommission stale FortiSwitches / FortiAPs
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // For every previously-discovered FortiSwitch / FortiAP whose controller
  // was queried successfully this run but whose serial (or hostname, when
  // there's no serial on file) no longer appears in the controller's
  // managed inventory: flip the asset to status="decommissioned".
  //
  // This is gated on the *successful* per-controller inventory queries,
  // which is exactly the signal we already use to short-circuit "controller
  // offline" (a controller that timed out doesn't take its switches/APs
  // down with it). A decommissioned switch/AP is automatically reactivated
  // by the Phase-3b update path above when its serial reappears.
  if (switchInventoriedDevices.size > 0 || apInventoriedDevices.size > 0) {
    const candidates = await prisma.asset.findMany({
      where: {
        discoveredByIntegrationId: integrationId,
        assetType: { in: ["switch", "access_point"] },
        status: { not: "decommissioned" },
      },
      select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true, status: true },
    });
    const staleIds: string[] = [];
    for (const a of candidates) {
      const topo = (a.fortinetTopology as Record<string, unknown> | null) || null;
      const controller = (topo?.controllerFortigate as string | undefined) || "";
      const inventoriedSet = a.assetType === "switch" ? switchInventoriedDevices : apInventoriedDevices;
      // Skip when this asset's controller wasn't reachable this run — we
      // didn't get a fresh answer either way.
      if (!controller || !inventoriedSet.has(controller)) continue;
      const seenBySerial   = a.serialNumber && (a.assetType === "switch" ? seenSwitchSerials   : seenApSerials).has(a.serialNumber);
      const seenByHostname = a.hostname     && (a.assetType === "switch" ? seenSwitchHostnames : seenApHostnames).has(a.hostname);
      if (seenBySerial || seenByHostname) continue;
      staleIds.push(a.id);
      if (a.assetType === "switch")        decommissionedSwitches.push(a.hostname || a.serialNumber || a.id);
      else if (a.assetType === "access_point") decommissionedAps.push(a.hostname || a.serialNumber || a.id);
      logEvent({
        action: a.assetType === "switch" ? "asset.fortiswitch.decommissioned" : "asset.fortiap.decommissioned",
        resourceType: "asset",
        resourceId: a.id,
        resourceName: a.hostname || a.serialNumber || a.id,
        actor,
        message: `${a.assetType === "switch" ? "FortiSwitch" : "FortiAP"} "${a.hostname || a.serialNumber}" decommissioned — controller "${controller}" no longer reports it`,
        details: { reason: "missing-from-controller", controllerFortigate: controller, integrationId, integrationName },
      });
    }
    if (staleIds.length > 0) {
      await prisma.asset.updateMany({
        where: { id: { in: staleIds } },
        data: { status: "decommissioned", statusChangedAt: new Date(now), statusChangedBy: integrationLabel },
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 2c — Auto-Monitor Interfaces apply pass
  //
  // For each per-class block (fortigate / fortiswitch / fortiap), if an
  // `autoMonitorInterfaces` selection has been configured on this integration,
  // resolve it against each discovered asset's latest AssetInterfaceSample rows
  // and union the result into Asset.monitoredInterfaces. Strictly additive.
  //
  // Only applies to fortimanager + fortigate integrations. windowsserver /
  // entraid / activeDirectory don't manage Fortinet hardware.
  if (integrationType === "fortimanager" || integrationType === "fortigate") {
    const integ = await prisma.integration.findUnique({
      where: { id: integrationId },
      select: { config: true },
    });
    const cfg = (integ?.config ?? {}) as Record<string, any>;
    for (const [klass, blockKey] of [
      ["fortigate",   "fortigateMonitor"],
      ["fortiswitch", "fortiswitchMonitor"],
      ["fortiap",     "fortiapMonitor"],
    ] as const) {
      const selection = (cfg[blockKey]?.autoMonitorInterfaces ?? null) as autoMonitor.AutoMonitorSelection;
      if (!selection) continue;
      try {
        const r = await autoMonitor.applyAutoMonitorForClass(integrationId, klass, selection, actor);
        if (r.interfacesAdded > 0) {
          syncLog("info", `Auto-monitor (${klass}): pinned ${r.interfacesAdded} interface(s) on ${r.devices} device(s)`);
          await logEvent({
            action:       "integration.auto_monitor_interfaces.applied",
            resourceType: "integration",
            resourceId:   integrationId,
            resourceName: integrationName,
            actor,
            message:      `Auto-monitor interfaces applied for "${integrationName}" (${klass}) — ${r.devices} device(s), ${r.interfacesAdded} interface(s) added`,
            details:      { class: klass, devices: r.devices, interfacesAdded: r.interfacesAdded },
          });
        }
      } catch (err: any) {
        syncLog("error", `Auto-monitor (${klass}) failed: ${err?.message || "Unknown error"}`);
      }
    }
  }

  } // end mode !== "skip-deprecation" (Phase 2 + 2b + 2c)

  if (mode === "full" || mode === "skip-deprecation") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 3 — Create/update FortiGate device assets (in-memory serial lookup)
  // ══════════════════════════════════════════════════════════════════════════════

  for (const device of result.devices) {
    try {
      const fgHostname = device.hostname || device.name;
      const topology = { role: "fortigate" as const };
      if (device.serial) {
        const existingAsset = assetIdx.findBySerial(device.serial);
        if (existingAsset) {
          // Stamp the discovering integration so the Monitoring tab can render
          // the integration's name as the default probe path. monitorType
          // defaults to the integration's native type, but is *not* re-stamped
          // when the operator has explicitly overridden it (e.g. switched a
          // small-branch FortiGate whose REST sensor endpoint 404s to SNMP).
          // Detect override by anything other than the two firewall defaults.
          const integrationDefaultType = integrationType === "fortigate" ? "fortigate" : "fortimanager";
          const isOperatorOverride =
            existingAsset.monitorType !== null &&
            existingAsset.monitorType !== "fortimanager" &&
            existingAsset.monitorType !== "fortigate";
          const updateData: Record<string, unknown> = {
            ipAddress: device.mgmtIp || existingAsset.ipAddress,
            ...(device.mgmtIp ? { ipSource: fgHostname || integrationType } : {}),
            hostname: device.hostname || existingAsset.hostname,
            model: device.model || existingAsset.model,
            learnedLocation: existingAsset.learnedLocation || fgHostname,
            lastSeen: new Date(now),
            fortinetTopology: topology,
            discoveredByIntegrationId: integrationId,
            ...(isOperatorOverride ? {} : { monitorType: integrationDefaultType }),
            // Only overwrite coords when discovery actually returned them — do not
            // wipe a previously-set value with undefined on a FortiOS that omits
            // longitude/latitude from system/global.
            ...(Number.isFinite(device.latitude) && Number.isFinite(device.longitude)
              ? { latitude: device.latitude, longitude: device.longitude }
              : {}),
            ...(existingAsset.status === "decommissioned" ? { status: "active", statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
          };
          clampAcquiredToLastSeen(updateData, existingAsset);
          await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
          // Update in-memory
          if (device.mgmtIp) existingAsset.ipAddress = device.mgmtIp;
          if (device.hostname) existingAsset.hostname = device.hostname;
          if (device.model) existingAsset.model = device.model;
          if (!existingAsset.learnedLocation) existingAsset.learnedLocation = fgHostname;
          if (existingAsset.status === "decommissioned") existingAsset.status = "active";
          assetIdx.reindex(existingAsset);
          assetNames.push(`${device.name} (updated)`);
          continue;
        }
      }

      // New FortiGate — set the Device Map tag (fgt:<serial>) so the map endpoint
      // can find this device by a stable key even if hostname/model changes later.
      const fgTag = device.serial ? `fgt:${device.serial}` : null;
      const newAsset = await prisma.asset.create({
        data: {
          ipAddress: device.mgmtIp || null,
          ...(device.mgmtIp ? { ipSource: fgHostname || integrationType } : {}),
          hostname: fgHostname,
          serialNumber: device.serial || null,
          assetTag: fgTag,
          manufacturer: "Fortinet",
          model: device.model || "FortiGate",
          assetType: "firewall",
          status: "active",
          statusChangedAt: new Date(now),
          statusChangedBy: integrationLabel,
          department: "Network Security",
          learnedLocation: fgHostname,
          lastSeen: new Date(now),
          // Default monitoring source to the discovering integration. Probes
          // route through the integration's stored API token; operators can
          // override the type later from the asset's Monitoring tab.
          discoveredByIntegrationId: integrationId,
          monitorType: integrationType === "fortigate" ? "fortigate" : "fortimanager",
          // Auto-Monitored is opt-in via the integration's "Add Discovered
          // FortiGates as Monitored" checkbox. Existing FortiGates are not
          // touched — only fresh creates get the flag flipped.
          ...(fortigateAddAsMonitored ? { monitored: true } : {}),
          ...(Number.isFinite(device.latitude) && Number.isFinite(device.longitude)
            ? { latitude: device.latitude, longitude: device.longitude }
            : {}),
          fortinetTopology: topology,
          notes: `Auto-discovered from ${integrationLabel} integration`,
          tags: ["fortigate", "auto-discovered"],
        },
      });
      assetIdx.add(newAsset);
      assetNames.push(device.name);
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for device ${device.name}: ${err.message || "Unknown error"}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 3b — Create/update FortiSwitch and FortiAP assets + reservations
  // ══════════════════════════════════════════════════════════════════════════════

  // Auto-stamping policy for managed FortiSwitch / FortiAP. Two independent
  // toggles drive four cases:
  //
  //   enabled=false, addAsMonitored=false  → no-op (legacy default)
  //   enabled=false, addAsMonitored=true   → stamp monitored=true,
  //                                          monitorType="icmp" (fallback
  //                                          when no SNMP credential is yet
  //                                          configured for this class)
  //   enabled=true,  addAsMonitored=false  → stamp monitorType="snmp" +
  //                                          credential, leave monitored
  //                                          as-is so operators opt-in
  //                                          per-asset later
  //   enabled=true,  addAsMonitored=true   → stamp everything (the original
  //                                          behaviour)
  //
  // Operator override detection compares the existing asset's monitorType +
  // credential against either of the integration's two possible defaults
  // (snmp+integration-credential, or icmp+null). Anything else (winrm, ssh,
  // a different SNMP credential, the fortimanager/fortigate defaults) means
  // the operator chose something custom and we leave it alone.
  function buildClassMonitorStamp(
    cfg: ClassMonCfg,
    existing?: { monitorType?: string | null; monitorCredentialId?: string | null; monitored?: boolean | null },
  ): Record<string, unknown> {
    if (!cfg.enabled && !cfg.addAsMonitored) return {};

    const wantSnmp = cfg.enabled && !!cfg.snmpCredentialId;
    const stampedType = wantSnmp ? "snmp" : "icmp";
    const stampedCred = wantSnmp ? cfg.snmpCredentialId : null;

    if (existing && existing.monitorType != null) {
      const matchesSnmpDefault = existing.monitorType === "snmp" && existing.monitorCredentialId === cfg.snmpCredentialId;
      const matchesIcmpDefault = existing.monitorType === "icmp" && existing.monitorCredentialId == null;
      if (!matchesSnmpDefault && !matchesIcmpDefault) return {};
    }

    const stamp: Record<string, unknown> = {
      discoveredByIntegrationId: integrationId,
      monitorType: stampedType,
      monitorCredentialId: stampedCred,
    };
    // Only flip `monitored` when the operator opted into auto-Monitored.
    // Otherwise leave the existing value alone (newly-created assets fall
    // back to the Prisma default of false).
    if (cfg.addAsMonitored) stamp.monitored = true;
    return stamp;
  }

  for (const sw of result.fortiSwitches || []) {
    const swStatus = sw.state === "Unauthorized" ? "storage" : "active";
    const swJoinDate = sw.joinTime && Number.isFinite(sw.joinTime) && sw.joinTime > 0
      ? new Date(sw.joinTime * 1000) : null;
    const swNotes = `Auto-discovered from FortiGate ${sw.device}${sw.fgtInterface ? ` via ${sw.fgtInterface}` : ""} via ${integrationLabel}`;
    try {
      let existingAsset: any = sw.serial ? assetIdx.findBySerial(sw.serial) : null;
      if (!existingAsset && sw.name) existingAsset = assetIdx.findByEntry(undefined, sw.name, sw.ipAddress || undefined);

      const swTopology = {
        role: "fortiswitch" as const,
        controllerFortigate: sw.device || null,
        uplinkInterface: sw.fgtInterface || null,
      };
      if (existingAsset) {
        const acquiredAtUpdate = swJoinDate && (!existingAsset.acquiredAt || swJoinDate < new Date(existingAsset.acquiredAt))
          ? swJoinDate : undefined;
        // Re-discovery resurrects a previously-decommissioned asset back to
        // its current FortiOS-reported state (active or storage). Mirrors
        // the FortiAP path right below.
        const reactivate = existingAsset.status === "decommissioned";
        const updateData: Record<string, unknown> = {
          ipAddress: sw.ipAddress || existingAsset.ipAddress,
          ...(sw.ipAddress ? { ipSource: sw.device || integrationType } : {}),
          hostname: sw.name || existingAsset.hostname,
          osVersion: sw.osVersion || existingAsset.osVersion,
          learnedLocation: sw.device || existingAsset.learnedLocation,
          status: swStatus,
          ...(swStatus !== existingAsset.status ? { statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
          lastSeen: new Date(now),
          fortinetTopology: swTopology,
          ...(acquiredAtUpdate ? { acquiredAt: acquiredAtUpdate } : {}),
          ...buildClassMonitorStamp(switchMonitorCfg, existingAsset),
        };
        clampAcquiredToLastSeen(updateData, existingAsset);
        await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
        if (sw.ipAddress) existingAsset.ipAddress = sw.ipAddress;
        if (reactivate) existingAsset.status = swStatus;
        assetIdx.reindex(existingAsset);
        assetNames.push(`${sw.name} (updated${reactivate ? " — reactivated" : ""})`);
      } else {
        const createData: Record<string, unknown> = {
          ipAddress: sw.ipAddress || null,
          ...(sw.ipAddress ? { ipSource: sw.device || integrationType } : {}),
          hostname: sw.name || null,
          serialNumber: sw.serial || null,
          manufacturer: "Fortinet",
          model: "FortiSwitch",
          assetType: "switch",
          status: swStatus,
          statusChangedAt: new Date(now),
          statusChangedBy: integrationLabel,
          osVersion: sw.osVersion || null,
          ...buildClassMonitorStamp(switchMonitorCfg),
          learnedLocation: sw.device || null,
          acquiredAt: swJoinDate,
          lastSeen: new Date(now),
          fortinetTopology: swTopology,
          notes: swNotes,
          tags: ["fortiswitch", "auto-discovered"],
        };
        clampAcquiredToLastSeen(createData);
        const newAsset = await prisma.asset.create({ data: createData as any });
        assetIdx.add(newAsset);
        assetNames.push(sw.name || sw.serial);
      }
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for FortiSwitch ${sw.name}: ${err.message || "Unknown error"}`);
    }

    if (sw.ipAddress) {
      const matchingSubnet = findSubnetForIp(sw.ipAddress);
      if (matchingSubnet) {
        const key = reservationKey(matchingSubnet.id, sw.ipAddress);
        const existingRes = activeResMap.get(key);
        if (existingRes) {
          if (existingRes.sourceType === "manual") {
            await upsertConflict(existingRes.id, integrationId, { hostname: sw.name || null, owner: "network-team", projectRef: projectRefLabel, notes: swNotes, sourceType: "fortiswitch" }, existingRes);
          }
        } else {
          try {
            const newRes = await prisma.reservation.create({
              data: {
                subnetId: matchingSubnet.id,
                ipAddress: sw.ipAddress,
                hostname: sw.name || null,
                owner: "network-team",
                projectRef: projectRefLabel,
                notes: swNotes,
                status: "active",
                sourceType: "fortiswitch",
              },
            });
            activeResMap.set(key, newRes);
            reservationNames.push(`${sw.ipAddress} (${sw.name})`);
          } catch (err: any) {
            syncLog("error", `Failed to create reservation for FortiSwitch ${sw.name} at ${sw.ipAddress}: ${err.message || "Unknown error"}`);
          }
        }
      }
    }
  }

  // Build hostname → {ip, mac} from DHCP data so APs that get management IPs
  // via DHCP can be matched even when the managed_ap API returns no IP/MAC.
  const dhcpByHostname = new Map<string, { ip: string; mac: string }>();
  for (const e of result.dhcpEntries || []) {
    if (e.hostname && e.ipAddress) {
      const key = e.hostname.toLowerCase();
      if (!dhcpByHostname.has(key)) dhcpByHostname.set(key, { ip: e.ipAddress, mac: e.macAddress || "" });
    }
  }

  for (const ap of result.fortiAps || []) {
    const dhcpFallback = dhcpByHostname.get(ap.name.toLowerCase()) ?? dhcpByHostname.get(ap.serial.toLowerCase()) ?? null;
    const resolvedIp = ap.ipAddress || dhcpFallback?.ip || null;
    const rawMac = ap.baseMac || dhcpFallback?.mac || "";
    const normalizedMac = rawMac ? rawMac.toUpperCase().replace(/-/g, ":") : null;
    try {
      let existingAsset: any = ap.serial ? assetIdx.findBySerial(ap.serial) : null;
      if (!existingAsset && normalizedMac) existingAsset = assetIdx.findByMac(normalizedMac);
      if (!existingAsset && ap.name) existingAsset = assetIdx.findByEntry(undefined, ap.name, resolvedIp || undefined);

      const apTopology = {
        role: "fortiap" as const,
        controllerFortigate: ap.device || null,
        parentSwitch: ap.peerSwitch || null,
        parentPort: ap.peerPort || null,
        parentVlan: ap.peerVlan ?? null,
      };
      if (existingAsset) {
        const updateData: Record<string, unknown> = {
          ipAddress: resolvedIp || existingAsset.ipAddress,
          ...(resolvedIp ? { ipSource: ap.device || integrationType } : {}),
          hostname: ap.name || existingAsset.hostname,
          model: ap.model || existingAsset.model,
          osVersion: ap.osVersion || existingAsset.osVersion,
          learnedLocation: ap.device || existingAsset.learnedLocation,
          lastSeen: new Date(now),
          fortinetTopology: apTopology,
          ...(existingAsset.status === "decommissioned" ? { status: "active", statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
          ...buildClassMonitorStamp(apMonitorCfg, existingAsset),
        };
        clampAcquiredToLastSeen(updateData, existingAsset);
        await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
        if (resolvedIp) existingAsset.ipAddress = resolvedIp;
        if (existingAsset.status === "decommissioned") existingAsset.status = "active";
        assetIdx.reindex(existingAsset);
        assetNames.push(`${ap.name} (updated)`);
      } else {
        const newAsset = await prisma.asset.create({
          data: {
            ipAddress: resolvedIp || null,
            ...(resolvedIp ? { ipSource: ap.device || integrationType } : {}),
            macAddress: normalizedMac,
            macAddresses: normalizedMac ? [{ mac: normalizedMac, lastSeen: now, source: "fmg-discovery" }] : [],
            hostname: ap.name || null,
            serialNumber: ap.serial || null,
            manufacturer: "Fortinet",
            model: ap.model || "FortiAP",
            assetType: "access_point",
            status: "active",
            statusChangedAt: new Date(now),
            statusChangedBy: integrationLabel,
            osVersion: ap.osVersion || null,
            learnedLocation: ap.device || null,
            lastSeen: new Date(now),
            fortinetTopology: apTopology,
            ...buildClassMonitorStamp(apMonitorCfg),
            notes: `Auto-discovered from FortiGate ${ap.device} via ${integrationLabel}`,
            tags: ["fortiap", "auto-discovered"],
          },
        });
        assetIdx.add(newAsset);
        assetNames.push(ap.name || ap.serial);
      }
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for FortiAP ${ap.name}: ${err.message || "Unknown error"}`);
    }

    if (resolvedIp) {
      const matchingSubnet = findSubnetForIp(resolvedIp);
      if (matchingSubnet) {
        const key = reservationKey(matchingSubnet.id, resolvedIp);
        const existingRes = activeResMap.get(key);
        if (existingRes) {
          if (existingRes.sourceType === "manual") {
            await upsertConflict(existingRes.id, integrationId, { hostname: ap.name || null, owner: "network-team", projectRef: projectRefLabel, notes: `FortiAP managed by FortiGate ${ap.device}`, sourceType: "fortinap" }, existingRes);
          }
        } else {
          try {
            const newRes = await prisma.reservation.create({
              data: {
                subnetId: matchingSubnet.id,
                ipAddress: resolvedIp,
                hostname: ap.name || null,
                owner: "network-team",
                projectRef: projectRefLabel,
                notes: `FortiAP managed by FortiGate ${ap.device}`,
                status: "active",
                sourceType: "fortinap",
              },
            });
            activeResMap.set(key, newRes);
            reservationNames.push(`${resolvedIp} (${ap.name})`);
          } catch (err: any) {
            syncLog("error", `Failed to create reservation for FortiAP ${ap.name} at ${resolvedIp}: ${err.message || "Unknown error"}`);
          }
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 3c — Sync firewall VIP reservations
  // ══════════════════════════════════════════════════════════════════════════════

  if (result.vips && result.vips.length > 0) {
    for (const vip of result.vips) {
      const ipsToReserve: Array<{ ip: string; role: "external" | "mapped" }> = [
        { ip: vip.extip, role: "external" },
        ...vip.mappedips.map((ip) => ({ ip, role: "mapped" as const })),
      ];

      for (const { ip, role } of ipsToReserve) {
        const matchingSubnet = findSubnetForIp(ip);
        if (!matchingSubnet) continue;

        const key = reservationKey(matchingSubnet.id, ip);
        const proposedHostname = vip.name;
        const proposedOwner = "fortimanager-vip";
        const proposedProjectRef = `VIP: ${vip.device}`;
        const proposedNotes = `Firewall VIP "${vip.name}" (${role}) on ${vip.device} — ext: ${vip.extip}`;

        const existingRes = activeResMap.get(key);
        if (existingRes) {
          if (existingRes.sourceType === "manual") {
            await upsertConflict(existingRes.id, integrationId, { hostname: proposedHostname, owner: proposedOwner, projectRef: proposedProjectRef, notes: proposedNotes, sourceType: "vip" }, existingRes);
          } else if (existingRes.sourceType === "vip") {
            // Update existing VIP reservation if the name changed
            if (existingRes.hostname !== proposedHostname || existingRes.notes !== proposedNotes) {
              await prisma.reservation.update({
                where: { id: existingRes.id },
                data: { hostname: proposedHostname, owner: proposedOwner, notes: proposedNotes, projectRef: proposedProjectRef },
              });
              existingRes.hostname = proposedHostname;
            }
          } else if (existingRes.sourceType === "dhcp_reservation" || existingRes.sourceType === "dhcp_lease") {
            // DHCP reservation takes precedence — store VIP metadata for display in the UI
            const newVipInfo = { name: vip.name, device: vip.device, extip: vip.extip, role };
            const cur = existingRes.vipInfo as any;
            if (!cur || cur.name !== newVipInfo.name || cur.device !== newVipInfo.device || cur.role !== newVipInfo.role) {
              await prisma.reservation.update({
                where: { id: existingRes.id },
                data: { vipInfo: newVipInfo },
              });
              existingRes.vipInfo = newVipInfo;
            }
          }
          continue;
        }

        try {
          const newRes = await prisma.reservation.create({
            data: {
              subnetId: matchingSubnet.id,
              ipAddress: ip,
              hostname: proposedHostname,
              owner: proposedOwner,
              projectRef: proposedProjectRef,
              notes: proposedNotes,
              status: "active",
              sourceType: "vip",
            },
          });
          activeResMap.set(key, newRes);
          vipNames.push(`${ip} (${vip.name}/${role})`);
        } catch (err: any) {
          syncLog("error", `Failed to create VIP reservation for ${ip} (${vip.name}): ${err.message || "Unknown error"}`);
        }
      }
    }
    if (vipNames.length > 0) {
      syncLog("info", `VIP sync: created ${vipNames.length} VIP reservation(s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 4 — Create reservations for interface IPs (in-memory reservation check)
  // ══════════════════════════════════════════════════════════════════════════════

  for (const ifaceIp of result.interfaceIps) {
    if (!ifaceIp.ipAddress) continue;

    const matchingSubnet = findSubnetForIp(ifaceIp.ipAddress);
    if (!matchingSubnet) continue;

    const key = reservationKey(matchingSubnet.id, ifaceIp.ipAddress);
    const existingRes = activeResMap.get(key);
    if (existingRes) {
      if (existingRes.sourceType === "manual") {
        const proposed = { hostname: ifaceIp.device, owner: "network-team", projectRef: projectRefLabel, notes: `${ifaceIp.role === "management" ? "Management interface" : "Interface"} (${ifaceIp.interfaceName}) on ${ifaceIp.device}`, sourceType: "interface_ip" };
        await upsertConflict(existingRes.id, integrationId, proposed, existingRes);
      }
      continue;
    }

    try {
      const newRes = await prisma.reservation.create({
        data: {
          subnetId: matchingSubnet.id,
          ipAddress: ifaceIp.ipAddress,
          hostname: ifaceIp.device,
          owner: "network-team",
          projectRef: projectRefLabel,
          notes: `${ifaceIp.role === "management" ? "Management interface" : "Interface"} (${ifaceIp.interfaceName}) on ${ifaceIp.device}`,
          status: "active",
          sourceType: "interface_ip",
        },
      });
      activeResMap.set(key, newRes);
      reservationNames.push(`${ifaceIp.ipAddress} (${ifaceIp.device}/${ifaceIp.interfaceName})`);
    } catch (err: any) {
      syncLog("error", `Failed to create reservation for interface IP ${ifaceIp.ipAddress} on ${ifaceIp.device}/${ifaceIp.interfaceName}: ${err.message || "Unknown error"}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 4b — (intentionally removed) FortiGate associatedIps from interface IPs
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // Per-interface IPs and MACs for the FortiGate itself are now populated by
  // the System tab's interface scrape (monitoringService.collectSystemInfo +
  // recordSystemInfoResult), which runs on the configurable telemetry cadence
  // once monitoring is enabled on the asset. Discovery no longer races to
  // overwrite associatedIps here — the live monitor pull is the single source.
  // Manual associatedIps entries (`source: "manual"`) survive the monitor pull
  // by the same merge logic that used to live in this phase.
  syncLog("info", "Phase 4b: skipped — interface IPs/MACs are now managed by the System tab when monitoring is enabled");

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 5 — Create DHCP lease/reservation entries (in-memory lookups)
  // ══════════════════════════════════════════════════════════════════════════════

  if (result.dhcpEntries && result.dhcpEntries.length > 0) {
    for (const entry of result.dhcpEntries) {
      if (!entry.ipAddress) continue;

      const matchingSubnet = findSubnetForIp(entry.ipAddress);
      if (!matchingSubnet) continue;

      const key = reservationKey(matchingSubnet.id, entry.ipAddress);
      const isDhcpReservation = entry.type === "dhcp-reservation";

      // Look up matching asset by MAC (in-memory)
      let matchedAsset: any = null;
      if (entry.macAddress) {
        matchedAsset = assetIdx.findByMac(entry.macAddress.toUpperCase().replace(/-/g, ":"));
      }

      const proposedHostname = (matchedAsset && matchedAsset.hostname) || entry.hostname || null;
      const proposedOwner = (matchedAsset && matchedAsset.assignedTo) || (isDhcpReservation ? "dhcp-reservation" : "dhcp-lease");
      const proposedNotes = [
        `${isDhcpReservation ? "DHCP reservation" : "DHCP lease"} on ${entry.device} (${entry.interfaceName})`,
        entry.macAddress ? `MAC: ${entry.macAddress}` : null,
        entry.vci ? `Model: ${entry.vci}` : null,
        entry.ssid ? `SSID: ${entry.ssid}` : null,
        entry.accessPoint ? `AP: ${entry.accessPoint}` : null,
      ].filter(Boolean).join(" — ");
      // Use vci to identify FortiSwitch/FortiAP entries not caught by managed device APIs
      const vciLower = (entry.vci || "").toLowerCase();
      const proposedSourceType = (
        vciLower.startsWith("fortiswitch-") ? "fortiswitch" :
        vciLower.startsWith("fortiap-") ? "fortinap" :
        isDhcpReservation ? "dhcp_reservation" : "dhcp_lease"
      ) as "fortiswitch" | "fortinap" | "dhcp_reservation" | "dhcp_lease";
      const proposedExpiresAt = !isDhcpReservation && entry.expireTime ? new Date(entry.expireTime * 1000) : undefined;

      const existingRes = activeResMap.get(key);
      if (existingRes) {
        if (existingRes.sourceType === "manual") {
          if (existingRes.pushedToId) {
            // Polaris-pushed manual reservation — discovery is just seeing
            // its own echo. Flip sourceType silently so the conflict isn't
            // raised and future discoveries treat this as a normal
            // dhcp_reservation. We do NOT overwrite the user-provided
            // hostname / owner / projectRef / notes — the device-side
            // description is intentionally distinct (Polaris/<user>:
            // <hostname>) and shouldn't become the Polaris-side hostname.
            // Also dismiss any pending conflicts already raised on this
            // row from prior discovery runs that didn't have this guard.
            await prisma.reservation.update({
              where: { id: existingRes.id },
              data: {
                sourceType: "dhcp_reservation",
                ...(entry.seenLeased && isDhcpReservation
                  ? { lastSeenLeased: new Date(), staleNotifiedAt: null, staleSnoozedUntil: null }
                  : {}),
              },
            });
            await prisma.conflict.updateMany({
              where: { reservationId: existingRes.id, status: "pending" },
              data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
            });
          } else {
            await upsertConflict(existingRes.id, integrationId, { hostname: proposedHostname, owner: proposedOwner, projectRef: projectRefLabel, notes: proposedNotes, sourceType: proposedSourceType }, existingRes);
          }
        } else if (entry.seenLeased && isDhcpReservation) {
          // Static reservation we already know about; bump the
          // last-seen-leased timestamp so the stale-reservation job knows
          // its target was online at this discovery run. Cleared both
          // staleNotifiedAt (so a freshly-online reservation re-arms the
          // alert if it goes silent again later) and staleSnoozedUntil (so
          // an operator snooze on a now-online reservation doesn't linger).
          await prisma.reservation.update({
            where: { id: existingRes.id },
            data: {
              lastSeenLeased: new Date(),
              staleNotifiedAt: null,
              staleSnoozedUntil: null,
            },
          });
        }
        continue;
      }

      try {
        const newRes = await prisma.reservation.create({
          data: {
            subnetId: matchingSubnet.id,
            ipAddress: entry.ipAddress,
            hostname: proposedHostname,
            owner: proposedOwner,
            projectRef: projectRefLabel,
            notes: proposedNotes,
            status: "active",
            sourceType: proposedSourceType,
            expiresAt: proposedExpiresAt,
            // First-discovery stamp for newly-created dhcp_reservation rows
            // whose target is currently online — gives the stale job a
            // baseline so it doesn't immediately flag a brand-new reservation
            // we just learned about.
            lastSeenLeased: entry.seenLeased && isDhcpReservation ? new Date() : null,
          },
        });
        activeResMap.set(key, newRes); // Track for MAC cross-update phase
        if (isDhcpReservation) {
          dhcpReservations.push(`${entry.ipAddress} (${entry.hostname || entry.macAddress})`);
        } else {
          dhcpLeases.push(`${entry.ipAddress} (${entry.hostname || entry.macAddress})`);
        }
      } catch (err: any) {
        syncLog("error", `Failed to create DHCP ${isDhcpReservation ? "reservation" : "lease"} for ${entry.ipAddress}: ${err.message || "Unknown error"}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 6 — Associate DHCP MACs with assets & cross-update reservations
  //           (in-memory lookups, batched writes)
  // ══════════════════════════════════════════════════════════════════════════════

  if (result.dhcpEntries && result.dhcpEntries.length > 0) {
    // Collect all updates, then batch-execute
    const assetUpdates: Array<{ id: string; data: any }> = [];
    const resUpdates: Array<{ id: string; data: Record<string, string> }> = [];
    // Quarantine fan-out hook: every (asset, FortiGate) DHCP attribution
    // becomes a sighting. The flush at the end of the phase is fire-and-
    // forget — sighting recording must not fail the discovery sync.
    const sightingRows: sightings.SightingInput[] = [];

    for (const entry of result.dhcpEntries) {
      if (!entry.macAddress || !entry.ipAddress) continue;
      const normalized = entry.macAddress.toUpperCase().replace(/-/g, ":");

      // DHCP IPs recycle across devices, so IP-only matches would staple
      // a new device's MAC onto the previous lease-holder's asset.
      const asset = assetIdx.findByEntry(entry.macAddress, entry.hostname, entry.ipAddress, { allowIpFallback: false });
      if (!asset) continue;

      if (entry.device) {
        sightingRows.push({
          assetId: asset.id,
          fortigateDevice: entry.device,
          source: entry.type === "dhcp-reservation" ? "dhcp_reservation" : "dhcp_lease",
          integrationId,
        });
      }

      // Resolve subnet up-front so we can stamp it on the MAC entry
      const matchingSubnet = findSubnetForIp(entry.ipAddress);

      // Update MAC list in-memory
      const macList: Array<{mac: string; lastSeen: string; source: string; subnetCidr?: string; subnetName?: string}> = Array.isArray(asset.macAddresses) ? [...(asset.macAddresses as any)] : [];
      const existingMac = macList.find((m: any) => m.mac === normalized);
      if (existingMac) {
        existingMac.lastSeen = now;
        existingMac.source = entry.type;
        if (matchingSubnet) {
          existingMac.subnetCidr = matchingSubnet.cidr;
          existingMac.subnetName = matchingSubnet.name;
        }
      } else {
        macList.push({
          mac: normalized,
          lastSeen: now,
          source: entry.type,
          ...(matchingSubnet ? { subnetCidr: matchingSubnet.cidr, subnetName: matchingSubnet.name } : {}),
        });
      }
      macList.sort((a: any, b: any) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());

      // Queue asset update
      assetUpdates.push({
        id: asset.id,
        data: {
          macAddress: macList[0].mac,
          macAddresses: macList,
          ipAddress: entry.ipAddress,
          ipSource: entry.device || integrationType,
          status: "active",
          ...(asset.status !== "active" ? { statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
          lastSeen: new Date(now),
          ...(entry.device ? { learnedLocation: entry.device } : {}),
        },
      });

      // Update in-memory so device inventory phase sees current state
      asset.macAddress = macList[0].mac;
      asset.macAddresses = macList;
      asset.ipAddress = entry.ipAddress;
      asset.status = "active";
      asset.lastSeen = now;
      if (entry.device) asset.learnedLocation = entry.device;
      assetIdx.reindex(asset);

      // Queue reservation cross-update (in-memory lookup, no DB query)
      if (matchingSubnet) {
        const key = reservationKey(matchingSubnet.id, entry.ipAddress);
        const res = activeResMap.get(key);
        if (res) {
          const resUpdate: Record<string, string> = {};
          if (asset.hostname && res.hostname !== asset.hostname) resUpdate.hostname = asset.hostname;
          if (asset.assignedTo && res.owner !== asset.assignedTo) resUpdate.owner = asset.assignedTo;
          if (Object.keys(resUpdate).length > 0) {
            resUpdates.push({ id: res.id, data: resUpdate });
            // Update in-memory
            if (resUpdate.hostname) res.hostname = resUpdate.hostname;
            if (resUpdate.owner) res.owner = resUpdate.owner;
          }
        }
      }
    }

    // Batch-execute asset updates
    if (assetUpdates.length > 0) {
      const results = await batchSettled(assetUpdates, (u) =>
        prisma.asset.update({ where: { id: u.id }, data: u.data })
      );
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          const entry = result.dhcpEntries![i];
          syncLog("error", `Failed to update asset MAC/IP for ${entry?.macAddress} (${entry?.ipAddress}): ${(results[i] as PromiseRejectedResult).reason?.message || "Unknown error"}`);
        }
      }
    }

    // Batch-execute reservation cross-updates
    if (resUpdates.length > 0) {
      await batchSettled(resUpdates, (u) =>
        prisma.reservation.update({ where: { id: u.id }, data: u.data })
      );
    }

    // Flush quarantine-sighting rows. Failures are swallowed inside
    // recordSightings (Promise.allSettled) — a misbehaving row should not
    // fail the discovery sync.
    if (sightingRows.length > 0) {
      try {
        await sightings.recordSightings(sightingRows);
      } catch (err: any) {
        syncLog("error", `Failed to flush ${sightingRows.length} asset sighting(s): ${err.message || "Unknown error"}`);
      }

      // Auto-quarantine pass: for each unique (asset, FortiGate) sighting,
      // if the asset is currently quarantined:
      //   - Not yet a synced target on this FortiGate → extend quarantine.
      //   - Already a synced target → verify and flip drift if missing.
      // Best-effort: failures are logged but never block the discovery sync.
      const seenPairs = new Map<string, string>(); // assetId → Set of fortigateDevices (JSON-encoded unique pairs)
      const uniquePairs: Array<{ assetId: string; fortigateDevice: string }> = [];
      for (const row of sightingRows) {
        const key = `${row.assetId}|${row.fortigateDevice}`;
        if (!seenPairs.has(key)) {
          seenPairs.set(key, key);
          uniquePairs.push({ assetId: row.assetId, fortigateDevice: row.fortigateDevice });
        }
      }

      for (const pair of uniquePairs) {
        try {
          const asset = await prisma.asset.findUnique({
            where: { id: pair.assetId },
            select: { id: true, status: true, quarantineTargets: true },
          });
          if (!asset || asset.status !== "quarantined") continue;

          const targets: Array<{ fortigateDevice: string; status: string }> =
            Array.isArray(asset.quarantineTargets) ? (asset.quarantineTargets as any[]) : [];
          const existingTarget = targets.find((t) => t.fortigateDevice === pair.fortigateDevice);

          if (!existingTarget || existingTarget.status !== "synced") {
            // Not covered — extend quarantine to this FortiGate.
            await quarantineAsset({ assetId: pair.assetId, actor: "system:auto-quarantine" });
          } else {
            // Already covered — verify and persist drift if detected.
            const verifyResult = await verifyAssetQuarantine(pair.assetId);
            if (verifyResult.driftDetected) {
              await prisma.asset.update({
                where: { id: pair.assetId },
                data: { quarantineTargets: verifyResult.targets as any },
              });
            }
          }
        } catch (err: any) {
          syncLog("error", `Auto-quarantine check failed for asset ${pair.assetId} on ${pair.fortigateDevice}: ${err.message || "Unknown error"}`);
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 7 — Device inventory (fills gaps not covered by DHCP)
  // ══════════════════════════════════════════════════════════════════════════════

  if (result.deviceInventory && result.deviceInventory.length > 0) {
    const dhcpMacs = new Set<string>();
    const dhcpMacToIp = new Map<string, string>();
    for (const e of result.dhcpEntries || []) {
      if (e.macAddress) {
        const m = e.macAddress.toUpperCase().replace(/-/g, ":");
        dhcpMacs.add(m);
        if (e.ipAddress && !dhcpMacToIp.has(m)) dhcpMacToIp.set(m, e.ipAddress);
      }
    }

    // Hostname → IP from existing reservations (fallback for inventory entries missing an IP)
    const resHostnameToIp = new Map<string, string>();
    for (const r of allReservationsRaw) {
      if (r.hostname && r.ipAddress) resHostnameToIp.set(r.hostname.toLowerCase(), r.ipAddress);
    }

    for (const inv of result.deviceInventory) {
      if (!inv.macAddress && !inv.ipAddress) continue;
      const normalizedMac = inv.macAddress ? inv.macAddress.toUpperCase().replace(/-/g, ":") : "";

      const handledByDhcp = normalizedMac && dhcpMacs.has(normalizedMac);

      // In-memory asset lookup. Inventory IPs are the device's last-seen DHCP
      // IP, so they recycle just like lease IPs — skip the IP fallback.
      const existingAsset = normalizedMac
        ? assetIdx.findByEntry(inv.macAddress, inv.hostname, inv.ipAddress, { allowIpFallback: false })
        : assetIdx.findByEntry(undefined, inv.hostname, inv.ipAddress, { allowIpFallback: false });

      const switchConn = inv.switchName
        ? (inv.switchPort ? `${inv.switchName}/port${inv.switchPort}` : inv.switchName)
        : null;
      const apConn = inv.apName || null;

      if (existingAsset) {
        const updateData: Record<string, unknown> = { lastSeen: new Date(now) };
        if (existingAsset.status === "decommissioned") {
        updateData.status = "active";
        updateData.statusChangedAt = new Date(now);
        updateData.statusChangedBy = integrationLabel;
      }
        if (!handledByDhcp && inv.ipAddress && inv.ipAddress !== existingAsset.ipAddress) {
          updateData.ipAddress = inv.ipAddress;
        }
        if (inv.os && !existingAsset.os) updateData.os = inv.os;
        if (inv.os && (existingAsset as any).assetType === "other") {
          const inferred = inferAssetTypeFromOs(inv.os);
          if (inferred !== "other") updateData.assetType = inferred;
        }
        if (inv.osVersion) updateData.osVersion = inv.osVersion;
        if (inv.hardwareVendor && !existingAsset.manufacturer) updateData.manufacturer = inv.hardwareVendor;
        if (inv.device && !existingAsset.learnedLocation) updateData.learnedLocation = inv.device;
        if (switchConn) updateData.lastSeenSwitch = switchConn;
        if (apConn) updateData.lastSeenAp = apConn;

        if (inv.user) {
          const userList: Array<{user: string; domain?: string; lastSeen: string; source: string}> = Array.isArray(existingAsset.associatedUsers) ? [...(existingAsset.associatedUsers as any)] : [];
          const parts = inv.user.includes("\\") ? inv.user.split("\\") : [null, inv.user];
          const domain = parts[0] || undefined;
          const username = parts[1] || inv.user;
          const existingUser = userList.find((u) => u.user === username && u.domain === domain);
          if (existingUser) {
            existingUser.lastSeen = now;
            existingUser.source = "device-inventory";
          } else {
            userList.push({ user: username, domain, lastSeen: now, source: "device-inventory" });
          }
          userList.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
          updateData.associatedUsers = userList;
        }

        if (normalizedMac && !handledByDhcp) {
          const macList: Array<{mac: string; lastSeen: string; source: string; device?: string}> = Array.isArray(existingAsset.macAddresses) ? [...(existingAsset.macAddresses as any)] : [];
          const existingMac = macList.find((m) => m.mac === normalizedMac);
          if (existingMac) {
            existingMac.lastSeen = now;
            existingMac.source = "device-inventory";
            if (inv.device) existingMac.device = inv.device;
          } else {
            macList.push({
              mac: normalizedMac,
              lastSeen: now,
              source: "device-inventory",
              ...(inv.device ? { device: inv.device } : {}),
            });
          }
          macList.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
          updateData.macAddress = macList[0].mac;
          updateData.macAddresses = macList;
        }

        if (Object.keys(updateData).length > 0) {
          try {
            clampAcquiredToLastSeen(updateData, existingAsset);
            await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
            // Update in-memory
            Object.assign(existingAsset, updateData);
            assetIdx.reindex(existingAsset);
            inventoryAssets.push(`${existingAsset.hostname || normalizedMac} (updated)`);
          } catch (err: any) {
            syncLog("error", `Failed to update inventory asset ${existingAsset.hostname || normalizedMac}: ${err.message || "Unknown error"}`);
          }
        }
      } else {
        // Only create new assets that have a MAC and a resolvable IP
        if (!normalizedMac) continue;
        let resolvedIp = inv.ipAddress || "";
        if (!resolvedIp) resolvedIp = dhcpMacToIp.get(normalizedMac) || "";
        if (!resolvedIp && inv.hostname) resolvedIp = resHostnameToIp.get(inv.hostname.toLowerCase()) || "";
        if (!resolvedIp) continue;

        try {
          const userList: Array<{user: string; domain?: string; lastSeen: string; source: string}> = [];
          if (inv.user) {
            const parts = inv.user.includes("\\") ? inv.user.split("\\") : [null, inv.user];
            userList.push({ user: parts[1] || inv.user, domain: parts[0] || undefined, lastSeen: now, source: "device-inventory" });
          }
          const newAsset = await prisma.asset.create({
            data: {
              ipAddress: resolvedIp,
              ipSource: inv.device || integrationType,
              macAddress: normalizedMac || null,
              macAddresses: normalizedMac ? [{ mac: normalizedMac, lastSeen: now, source: "device-inventory", ...(inv.device ? { device: inv.device } : {}) }] : [],
              hostname: inv.hostname || null,
              manufacturer: inv.hardwareVendor || null,
              assetType: inferAssetTypeFromOs(inv.os),
              status: "active",
              statusChangedAt: new Date(now),
              statusChangedBy: integrationLabel,
              os: inv.os || null,
              osVersion: inv.osVersion || null,
              learnedLocation: inv.device || null,
              lastSeenSwitch: switchConn,
              lastSeenAp: apConn,
              associatedUsers: userList,
              lastSeen: new Date(now),
              notes: `Auto-discovered from FortiGate device inventory (${inv.device})`,
              tags: ["device-inventory", "auto-discovered"],
            },
          });
          assetIdx.add(newAsset);
          inventoryAssets.push(inv.hostname || normalizedMac || inv.ipAddress);
        } catch (err: any) {
          syncLog("error", `Failed to create inventory asset ${inv.hostname || normalizedMac || inv.ipAddress}: ${err.message || "Unknown error"}`);
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 7b — Clear stale `device` stamps on MAC entries
  //            For every FortiGate whose inventory succeeded this run, any MAC
  //            stamped with that FortiGate but not seen in the fresh inventory
  //            has a stale attribution — clear `device` on that entry.
  //            FortiGates whose inventory failed are left alone (we have no
  //            fresh answer to compare against).
  // ══════════════════════════════════════════════════════════════════════════════

  if (result.inventoryDevices && result.inventoryDevices.length > 0) {
    const refreshedDevices = new Set(result.inventoryDevices);
    const seenMacOnDevice = new Set<string>();
    for (const inv of result.deviceInventory || []) {
      if (!inv.macAddress || !inv.device) continue;
      const mac = inv.macAddress.toUpperCase().replace(/-/g, ":");
      seenMacOnDevice.add(`${mac}|${inv.device}`);
    }

    const staleSweepUpdates: Array<{ id: string; data: any }> = [];
    for (const asset of assetIdx.all()) {
      const macs = Array.isArray(asset.macAddresses) ? (asset.macAddresses as any[]) : [];
      if (macs.length === 0) continue;
      let mutated = false;
      for (const m of macs) {
        if (!m.device || !refreshedDevices.has(m.device)) continue;
        const key = `${m.mac}|${m.device}`;
        if (!seenMacOnDevice.has(key)) {
          delete m.device;
          mutated = true;
        }
      }
      if (mutated) {
        staleSweepUpdates.push({ id: asset.id, data: { macAddresses: macs } });
        asset.macAddresses = macs;
      }
    }

    if (staleSweepUpdates.length > 0) {
      await batchSettled(staleSweepUpdates, (u) =>
        prisma.asset.update({ where: { id: u.id }, data: u.data })
      );
      syncLog("info", `Cleared stale MAC device stamps on ${staleSweepUpdates.length} asset(s) across ${refreshedDevices.size} refreshed FortiGate(s)`);
    }
  }

  } // end Phases 3–7 (full | skip-deprecation)

  if (mode === "full" || mode === "finalize") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 8 — DNS reverse lookup for assets missing dnsName
  // ══════════════════════════════════════════════════════════════════════════════

  const DEFAULT_PTR_TTL_S = 3600;
  const nowMs = Date.now();
  const assetsNeedingDns = assetIdx.all().filter((a: any) => {
    if (!a.ipAddress) return false;
    if (!a.dnsNameFetchedAt) return true;
    const fetchedMs = new Date(a.dnsNameFetchedAt).getTime();
    const ttlMs = ((a.dnsNameTtl ?? DEFAULT_PTR_TTL_S) * 1000);
    return (nowMs - fetchedMs) > ttlMs;
  });
  if (assetsNeedingDns.length > 0) {
    syncLog("info", `DNS lookup: resolving ${assetsNeedingDns.length} assets with expired/missing PTR`);
    const dnsResolver = await getConfiguredResolver();
    const dnsResults = await batchSettled(assetsNeedingDns, async (asset: any) => {
      const fetchedAt = new Date();
      const records = await dnsResolver.reverse(asset.ipAddress);
      if (records.length > 0) {
        await prisma.asset.update({ where: { id: asset.id }, data: { dnsName: records[0].name, dnsNameFetchedAt: fetchedAt, dnsNameTtl: records[0].ttl } });
        asset.dnsName = records[0].name;
        return records[0].name;
      }
      await prisma.asset.update({ where: { id: asset.id }, data: { dnsNameFetchedAt: fetchedAt, dnsNameTtl: null } });
      return null;
    });
    for (const r of dnsResults) {
      if (r.status === "fulfilled" && r.value) dnsResolved++;
    }
    if (dnsResolved > 0) {
      syncLog("info", `DNS lookup: resolved ${dnsResolved} of ${assetsNeedingDns.length} assets`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 9 — OUI manufacturer lookup & override application
  // ══════════════════════════════════════════════════════════════════════════════

  // 9a — Apply OUI overrides to assets that already have a manufacturer
  //       (e.g. "Fortinet" from FMG can be overridden to a custom name; an
  //       optional device field overrides the asset's model too)
  const assetsWithMacAndMfg = assetIdx.all().filter((a: any) => a.macAddress && a.manufacturer);
  if (assetsWithMacAndMfg.length > 0) {
    const overrideResults = await batchSettled(assetsWithMacAndMfg, async (asset: any) => {
      const override = await lookupOuiOverride(asset.macAddress);
      if (!override) return null;
      const data: { manufacturer?: string; model?: string } = {};
      if (override.manufacturer !== asset.manufacturer) data.manufacturer = override.manufacturer;
      if (override.device && override.device !== asset.model) data.model = override.device;
      if (Object.keys(data).length === 0) return null;
      await prisma.asset.update({ where: { id: asset.id }, data });
      if (data.manufacturer) asset.manufacturer = data.manufacturer;
      if (data.model) asset.model = data.model;
      return data;
    });
    for (const r of overrideResults) {
      if (r.status === "fulfilled" && r.value) ouiOverridden++;
    }
    if (ouiOverridden > 0) {
      syncLog("info", `OUI overrides: applied to ${ouiOverridden} assets`);
    }
  }

  // 9b — OUI lookup for assets still missing a manufacturer.
  //       Also pick up the override's device field when present (applies
  //       even if asset already has a model — override wins by design).
  const assetsNeedingOui = assetIdx.all().filter((a: any) => a.macAddress && !a.manufacturer);
  if (assetsNeedingOui.length > 0) {
    syncLog("info", `OUI lookup: resolving ${assetsNeedingOui.length} assets missing manufacturer`);
    const ouiResults = await batchSettled(assetsNeedingOui, async (asset: any) => {
      const vendor = await lookupOui(asset.macAddress);
      if (!vendor) return null;
      const override = await lookupOuiOverride(asset.macAddress);
      const data: { manufacturer: string; model?: string } = { manufacturer: vendor };
      if (override?.device && override.device !== asset.model) data.model = override.device;
      await prisma.asset.update({ where: { id: asset.id }, data });
      asset.manufacturer = vendor;
      if (data.model) asset.model = data.model;
      return vendor;
    });
    for (const r of ouiResults) {
      if (r.status === "fulfilled" && r.value) ouiResolved++;
    }
    if (ouiResolved > 0) {
      syncLog("info", `OUI lookup: resolved ${ouiResolved} of ${assetsNeedingOui.length} assets`);
    }
  }

  } // end Phases 8–9 (full | finalize)

  return { created, updated, skipped, deprecated, assets: assetNames, reservations: reservationNames, vips: vipNames.length, dhcpLeases: dhcpLeases.length, dhcpReservations: dhcpReservations.length, inventoryDevices: inventoryAssets.length, dnsResolved, ouiResolved, ouiOverridden, decommissionedSwitches, decommissionedAps };
}

// ─── Entra ID asset sync ─────────────────────────────────────────────────────

const ENTRA_ASSET_TAG_PREFIX = "entra:";
const AD_ASSET_TAG_PREFIX = "ad:";
const SID_TAG_PREFIX = "sid:";
const AD_GUID_TAG_PREFIX = "ad-guid:";

function sidTag(sid: string): string {
  return `${SID_TAG_PREFIX}${sid.toUpperCase()}`;
}

// Reject SIDs that aren't useful as a cross-integration identity key:
// empty, the null SID ("S-1-0-0"), or anything that doesn't look like a SID.
// The hybrid-join cross-link only works when the SID actually pins one
// device — placeholder SIDs would just collide every dead account.
function isMeaningfulSid(sid: string | undefined | null): boolean {
  if (!sid) return false;
  const s = sid.trim().toUpperCase();
  if (!s.startsWith("S-")) return false;
  if (s === "S-1-0-0") return false;
  return true;
}

// Tags the Entra discovery auto-assigns each run (so we strip them on update
// before re-adding the fresh set). Cross-integration identity tags (sid:*,
// ad-guid:*) are NOT in this list — they must be preserved.
function isEntraManagedTag(t: string): boolean {
  if (t.startsWith("entra")) return true;
  if (t.startsWith("intune-")) return true;
  return ["auto-discovered", "compliant", "noncompliant", "azuread", "workplace", "serverad"].includes(t);
}

function inferAssetTypeFromChassis(
  chassisType: string | undefined,
  operatingSystem: string | undefined,
): "workstation" | "server" | "other" {
  const chassis = (chassisType || "").toLowerCase();
  if (["desktop", "laptop", "convertible", "detachable"].includes(chassis)) return "workstation";
  if (["tablet", "phone"].includes(chassis)) return "other";

  // Fall back to OS inference (Entra-only devices have no chassisType).
  // Intune doesn't report servers in practice, but a future change could.
  const inferred = inferAssetTypeFromOs(operatingSystem);
  if (inferred === "server") return "server";
  if (inferred === "workstation") return "workstation";
  return "workstation"; // Entra/Intune devices default to workstation
}

async function syncEntraDevices(
  integrationId: string,
  integrationName: string,
  result: { devices: entraId.DiscoveredEntraDevice[] },
  actor?: string,
): Promise<{ created: string[]; updated: string[]; skipped: string[] }> {
  const syncLog = (level: "info" | "error" | "warning", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const now = new Date();

  // Load the full asset table so we can index by (Entra) assetTag, by SID tag,
  // and by hostname. SID index catches hybrid-joined devices that the on-prem
  // AD integration discovered first (assetTag = "ad:{guid}").
  const allAssets = await prisma.asset.findMany();
  const assetByEntraId = new Map<string, any>();       // deviceId → asset
  const assetBySid = new Map<string, any>();           // uppercase SID → asset
  const assetByHostnameNoTag = new Map<string, any>(); // hostname → asset (only those without an assetTag)
  for (const a of allAssets) {
    const tag = a.assetTag ?? "";
    if (tag.startsWith(ENTRA_ASSET_TAG_PREFIX)) {
      assetByEntraId.set(tag.slice(ENTRA_ASSET_TAG_PREFIX.length).toLowerCase(), a);
    } else if (!tag && a.hostname) {
      assetByHostnameNoTag.set(a.hostname.toLowerCase(), a);
    }
    for (const t of (a.tags as string[] | null) || []) {
      if (t.startsWith(SID_TAG_PREFIX)) {
        assetBySid.set(t.slice(SID_TAG_PREFIX.length).toUpperCase(), a);
      }
    }
  }

  for (const dev of result.devices) {
    const deviceIdKey = dev.deviceId.toLowerCase();
    if (!deviceIdKey) {
      skipped.push(`${dev.displayName || "<unnamed>"} (missing deviceId)`);
      continue;
    }

    const assetType = inferAssetTypeFromChassis(dev.chassisType, dev.operatingSystem);
    const disabled = !dev.accountEnabled;
    const status: "active" | "disabled" = disabled ? "disabled" : "active";

    const tags: string[] = ["entraid", "auto-discovered"];
    if (disabled) tags.push("entra-disabled");
    if (dev.trustType) tags.push(dev.trustType.toLowerCase());
    if (dev.complianceState) tags.push(`intune-${dev.complianceState.toLowerCase()}`);
    else if (dev.isCompliant === true) tags.push("compliant");
    else if (dev.isCompliant === false) tags.push("noncompliant");
    if (isMeaningfulSid(dev.onPremisesSecurityIdentifier)) tags.push(sidTag(dev.onPremisesSecurityIdentifier!));

    // Prefer Intune's lastSync (freshest hands-on-device signal) over Entra's sign-in time
    const lastSeenIso = dev.lastSyncDateTime || dev.approximateLastSignInDateTime;
    const lastSeen = lastSeenIso ? new Date(lastSeenIso) : null;
    const acquiredAt = dev.registrationDateTime ? new Date(dev.registrationDateTime) : null;

    // 1. Primary match: Entra assetTag
    let existing = assetByEntraId.get(deviceIdKey);
    let takingOver = false;
    // 2. Secondary match (hybrid-joined): on-prem SID tag. Lets Entra claim
    //    assets first discovered by the AD integration.
    if (!existing && dev.onPremisesSecurityIdentifier) {
      const sidMatch = assetBySid.get(dev.onPremisesSecurityIdentifier.toUpperCase());
      if (sidMatch) {
        existing = sidMatch;
        takingOver = !(sidMatch.assetTag || "").startsWith(ENTRA_ASSET_TAG_PREFIX);
        if (takingOver) {
          syncLog("info", `SID cross-link: Entra device "${dev.displayName}" (${dev.deviceId}) taking over existing asset ${sidMatch.id} (was ${sidMatch.assetTag || "<untagged>"}).`);
        }
      }
    }

    if (existing) {
      // Update the existing asset (either Entra-sourced, or SID-matched take-over)
      const updateData: Record<string, unknown> = {
        hostname: dev.displayName || existing.hostname,
        os: dev.operatingSystem || existing.os,
        osVersion: dev.operatingSystemVersion || existing.osVersion,
        lastSeen: lastSeen || existing.lastSeen,
        status,
        ...(status !== existing.status ? { statusChangedAt: now, statusChangedBy: integrationName } : {}),
      };
      if (takingOver) {
        // Priority rule: Entra's assetTag always wins. AD guid is preserved
        // via ad-guid:{guid} tag so AD sync can still find this asset later.
        updateData.assetTag = `${ENTRA_ASSET_TAG_PREFIX}${dev.deviceId}`;
      }
      if (dev.serialNumber) updateData.serialNumber = dev.serialNumber;
      if (dev.macAddress) updateData.macAddress = dev.macAddress;
      if (dev.manufacturer) updateData.manufacturer = dev.manufacturer;
      if (dev.model) updateData.model = dev.model;
      if (dev.userPrincipalName) updateData.assignedTo = dev.userPrincipalName;
      if (acquiredAt && (!existing.acquiredAt || acquiredAt < new Date(existing.acquiredAt))) {
        updateData.acquiredAt = acquiredAt;
      }
      // Only overwrite assetType if the existing one is "other" (default) — respect manual recategorization
      if (existing.assetType === "other") updateData.assetType = assetType;
      // Merge tags: strip Entra-managed auto-tags and re-add the fresh set.
      // Cross-integration identity tags (sid:*, ad-guid:*) and user-set tags
      // pass through untouched.
      const preserved = ((existing.tags as string[]) || []).filter((t) => !isEntraManagedTag(t));
      updateData.tags = [...preserved, ...tags.filter((t) => !preserved.includes(t))];

      try {
        clampAcquiredToLastSeen(updateData, existing);
        await prisma.asset.update({ where: { id: existing.id }, data: updateData });
        updated.push(dev.displayName || dev.deviceId);
      } catch (err: any) {
        syncLog("error", `Failed to update asset for Entra device ${dev.displayName || dev.deviceId}: ${err.message || "Unknown error"}`);
      }
      continue;
    }

    // No existing assetTag or SID match — check for hostname collision with a non-tagged asset.
    // If one exists, create (or refresh) a pending Conflict so an admin can decide
    // whether to merge (accept) or create a duplicate (reject). Skip the
    // create-path so we don't accidentally produce the duplicate yet.
    if (dev.displayName) {
      const collision = assetByHostnameNoTag.get(dev.displayName.toLowerCase());
      if (collision) {
        try {
          const existingConflict = await prisma.conflict.findFirst({
            where: { entityType: "asset", status: "pending", proposedDeviceId: dev.deviceId },
          });
          const proposedFields = {
            sourceType: "entraid",
            assetTagPrefix: ENTRA_ASSET_TAG_PREFIX,
            deviceId: dev.deviceId,
            hostname: dev.displayName,
            serialNumber: dev.serialNumber || null,
            macAddress: dev.macAddress || null,
            manufacturer: dev.manufacturer || null,
            model: dev.model || null,
            os: dev.operatingSystem || null,
            osVersion: dev.operatingSystemVersion || null,
            assignedTo: dev.userPrincipalName || null,
            chassisType: dev.chassisType || null,
            complianceState: dev.complianceState || null,
            trustType: dev.trustType || null,
            onPremisesSecurityIdentifier: dev.onPremisesSecurityIdentifier || null,
            assetType,
            lastSeen: dev.lastSyncDateTime || dev.approximateLastSignInDateTime || null,
            registrationDateTime: dev.registrationDateTime || null,
          };
          if (existingConflict) {
            // Refresh the snapshot so the admin sees the latest Entra values
            await prisma.conflict.update({
              where: { id: existingConflict.id },
              data: { proposedAssetFields: proposedFields as any, assetId: collision.id },
            });
          } else {
            await prisma.conflict.create({
              data: {
                entityType: "asset",
                assetId: collision.id,
                integrationId,
                proposedDeviceId: dev.deviceId,
                proposedAssetFields: proposedFields as any,
                conflictFields: ["hostname"],
                status: "pending",
              },
            });
          }
          syncLog("warning", `Hostname collision queued for review — Entra device "${dev.displayName}" (${dev.deviceId}) matches existing asset ${collision.id}.`);
        } catch (err: any) {
          syncLog("error", `Failed to queue hostname-collision conflict for "${dev.displayName}": ${err.message || "Unknown error"}`);
        }
        skipped.push(`${dev.displayName} (hostname collision — pending review)`);
        continue;
      }
    }

    // Create a new asset
    try {
      const createData: Record<string, unknown> = {
        assetTag: `${ENTRA_ASSET_TAG_PREFIX}${dev.deviceId}`,
        hostname: dev.displayName || null,
        serialNumber: dev.serialNumber || null,
        macAddress: dev.macAddress || null,
        manufacturer: dev.manufacturer || null,
        model: dev.model || null,
        assetType,
        status,
        statusChangedAt: now,
        statusChangedBy: integrationName,
        os: dev.operatingSystem || null,
        osVersion: dev.operatingSystemVersion || null,
        assignedTo: dev.userPrincipalName || null,
        lastSeen,
        acquiredAt,
        notes: `Auto-discovered from Entra ID integration "${integrationName}"${dev.trustType ? ` (trust: ${dev.trustType})` : ""}`,
        tags,
      };
      clampAcquiredToLastSeen(createData);
      const newAsset = await prisma.asset.create({ data: createData as any });
      assetByEntraId.set(deviceIdKey, newAsset);
      if (dev.onPremisesSecurityIdentifier) {
        assetBySid.set(dev.onPremisesSecurityIdentifier.toUpperCase(), newAsset);
      }
      created.push(dev.displayName || dev.deviceId);
    } catch (err: any) {
      syncLog("error", `Failed to create asset for Entra device ${dev.displayName || dev.deviceId}: ${err.message || "Unknown error"}`);
    }
  }

  syncLog("info", `Entra ID sync: ${created.length} created, ${updated.length} updated, ${skipped.length} skipped`);
  return { created, updated, skipped };
}

// ─── Active Directory asset sync ─────────────────────────────────────────────

function isAdManagedTag(t: string): boolean {
  if (t.startsWith("activedirectory")) return true;
  if (t.startsWith(AD_GUID_TAG_PREFIX)) return true; // replaced fresh each run
  return ["auto-discovered", "ad-disabled"].includes(t);
}

async function syncActiveDirectoryDevices(
  integrationId: string,
  integrationName: string,
  result: { devices: activeDirectory.DiscoveredAdDevice[] },
  actor?: string,
): Promise<{ created: string[]; updated: string[]; skipped: string[] }> {
  const syncLog = (level: "info" | "error" | "warning", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  // Load the full asset table so we can index by AD assetTag, AD-guid tag, SID tag, and hostname.
  const allAssets = await prisma.asset.findMany();
  const assetByAdGuidTag = new Map<string, any>();         // guid → asset (works even after Entra took over assetTag)
  const assetBySid = new Map<string, any>();               // uppercase SID → asset
  const assetByHostnameNoTag = new Map<string, any>();     // hostname → asset (untagged only)
  for (const a of allAssets) {
    const tag = a.assetTag ?? "";
    if (!tag && a.hostname) assetByHostnameNoTag.set(a.hostname.toLowerCase(), a);
    if (tag.startsWith(AD_ASSET_TAG_PREFIX)) {
      assetByAdGuidTag.set(tag.slice(AD_ASSET_TAG_PREFIX.length).toLowerCase(), a);
    }
    for (const t of (a.tags as string[] | null) || []) {
      if (t.startsWith(AD_GUID_TAG_PREFIX)) {
        assetByAdGuidTag.set(t.slice(AD_GUID_TAG_PREFIX.length).toLowerCase(), a);
      } else if (t.startsWith(SID_TAG_PREFIX)) {
        assetBySid.set(t.slice(SID_TAG_PREFIX.length).toUpperCase(), a);
      }
    }
  }

  for (const dev of result.devices) {
    const guidKey = dev.objectGuid.toLowerCase();
    if (!guidKey) {
      skipped.push(`${dev.cn || "<unnamed>"} (missing objectGUID)`);
      continue;
    }

    const displayName = dev.dnsHostName || dev.cn;
    const hostLookupKey = (dev.dnsHostName || dev.cn || "").toLowerCase();
    const assetType = inferAssetTypeFromOs(dev.operatingSystem);
    const status: "active" | "disabled" = dev.disabled ? "disabled" : "active";
    // Realm-monitorable hosts (Windows via WinRM, Linux via SSH) get locked to
    // this AD integration so the bind credentials double as the probe
    // credentials, mirroring how FMG owns its discovered firewalls.
    const adMonitorable = getAdMonitorProtocol(dev.operatingSystem) !== null;

    const tags: string[] = ["activedirectory", "auto-discovered", `${AD_GUID_TAG_PREFIX}${guidKey}`];
    if (isMeaningfulSid(dev.objectSid)) tags.push(sidTag(dev.objectSid));
    if (dev.disabled) tags.push("ad-disabled");

    const lastLogon = dev.lastLogonTimestamp ? new Date(dev.lastLogonTimestamp) : null;
    const whenCreated = dev.whenCreated ? new Date(dev.whenCreated) : null;

    // Match order: (1) AD guid tag/assetTag (2) SID tag (hybrid; Entra likely
    // has assetTag) (3) hostname collision → conflict (4) create new.
    let existing = assetByAdGuidTag.get(guidKey);
    if (!existing && dev.objectSid) {
      existing = assetBySid.get(dev.objectSid.toUpperCase());
    }

    if (existing) {
      const updateData: Record<string, unknown> = {
        os: dev.operatingSystem || existing.os,
        osVersion: dev.operatingSystemVersion || existing.osVersion,
        status,
        ...(status !== existing.status ? { statusChangedAt: new Date(), statusChangedBy: integrationName } : {}),
      };
      // Hostname: prefer dnsHostName if present; otherwise cn; never blank out a
      // human-entered hostname with the empty string.
      if (displayName) {
        updateData.hostname = displayName;
        if (dev.dnsHostName) updateData.dnsName = dev.dnsHostName;
      }
      // learnedLocation: AD OU path if no user-set location.
      if (!existing.location && dev.ouPath) updateData.learnedLocation = dev.ouPath;
      // lastSeen: don't regress a newer existing value (e.g. Entra/Intune had fresher data).
      if (lastLogon) {
        const existingLastSeen = existing.lastSeen ? new Date(existing.lastSeen) : null;
        if (!existingLastSeen || lastLogon > existingLastSeen) {
          updateData.lastSeen = lastLogon;
        }
      }
      // acquiredAt: backfill with AD whenCreated only if older than current.
      if (whenCreated && (!existing.acquiredAt || whenCreated < new Date(existing.acquiredAt))) {
        updateData.acquiredAt = whenCreated;
      }
      // assetType: only set if still default "other" (respect manual recategorization).
      if (existing.assetType === "other" && assetType !== "other") updateData.assetType = assetType;
      // Notes: only write if the existing notes field is empty.
      if (!existing.notes && dev.description) updateData.notes = dev.description;

      // Tag merge: strip AD-managed tags + stale sid/ad-guid (we re-add the fresh ones),
      // preserve all other tags including those set by Entra (entraid, intune-*, trustType, etc.).
      const preserved = ((existing.tags as string[]) || []).filter(
        (t) => !isAdManagedTag(t) && !t.startsWith(SID_TAG_PREFIX),
      );
      updateData.tags = [...preserved, ...tags.filter((t) => !preserved.includes(t))];

      // Default monitoring source to this AD integration for realm-monitorable
      // hosts. Skip if the asset is already discovered by a different
      // integration (e.g. an FMG-discovered firewall — defensive, shouldn't
      // happen). Also skip the type+credential reset when the operator has
      // explicitly overridden monitorType (anything other than null or the AD
      // default) — preserve their choice across re-runs.
      const alreadyOwnedByOtherIntegration =
        existing.discoveredByIntegrationId &&
        existing.discoveredByIntegrationId !== integrationId &&
        (existing.monitorType === "fortimanager" || existing.monitorType === "fortigate");
      if (adMonitorable && !alreadyOwnedByOtherIntegration) {
        updateData.discoveredByIntegrationId = integrationId;
        const isOperatorOverride =
          existing.monitorType !== null &&
          existing.monitorType !== "activedirectory";
        if (!isOperatorOverride) {
          updateData.monitorType = "activedirectory";
          // WinRM/SSH use the integration's bindDn/bindPassword, not a Credential row.
          updateData.monitorCredentialId = null;
        }
      }

      try {
        clampAcquiredToLastSeen(updateData, existing);
        await prisma.asset.update({ where: { id: existing.id }, data: updateData });
        updated.push(displayName || dev.objectGuid);
      } catch (err: any) {
        syncLog("error", `Failed to update asset for AD computer ${displayName || dev.objectGuid}: ${err.message || "Unknown error"}`);
      }
      continue;
    }

    // No guid or SID match — check hostname collision against untagged assets.
    if (hostLookupKey) {
      const collision = assetByHostnameNoTag.get(hostLookupKey);
      if (collision) {
        try {
          const existingConflict = await prisma.conflict.findFirst({
            where: { entityType: "asset", status: "pending", proposedDeviceId: dev.objectGuid },
          });
          const proposedFields = {
            sourceType: "activedirectory",
            assetTagPrefix: AD_ASSET_TAG_PREFIX,
            deviceId: dev.objectGuid,
            hostname: displayName,
            dnsName: dev.dnsHostName || null,
            os: dev.operatingSystem || null,
            osVersion: dev.operatingSystemVersion || null,
            notes: dev.description || null,
            learnedLocation: dev.ouPath || null,
            objectSid: dev.objectSid || null,
            status,
            assetType,
            lastSeen: dev.lastLogonTimestamp || null,
            registrationDateTime: dev.whenCreated || null,
            disabled: dev.disabled,
          };
          if (existingConflict) {
            await prisma.conflict.update({
              where: { id: existingConflict.id },
              data: { proposedAssetFields: proposedFields as any, assetId: collision.id },
            });
          } else {
            await prisma.conflict.create({
              data: {
                entityType: "asset",
                assetId: collision.id,
                integrationId,
                proposedDeviceId: dev.objectGuid,
                proposedAssetFields: proposedFields as any,
                conflictFields: ["hostname"],
                status: "pending",
              },
            });
          }
          syncLog("warning", `Hostname collision queued for review — AD computer "${displayName}" (${dev.objectGuid}) matches existing asset ${collision.id}.`);
        } catch (err: any) {
          syncLog("error", `Failed to queue hostname-collision conflict for "${displayName}": ${err.message || "Unknown error"}`);
        }
        skipped.push(`${displayName} (hostname collision — pending review)`);
        continue;
      }
    }

    // Create a new asset
    try {
      const createData: Record<string, unknown> = {
        assetTag: `${AD_ASSET_TAG_PREFIX}${dev.objectGuid}`,
        hostname: displayName || null,
        dnsName: dev.dnsHostName || null,
        assetType,
        status,
        statusChangedAt: new Date(),
        statusChangedBy: integrationName,
        os: dev.operatingSystem || null,
        osVersion: dev.operatingSystemVersion || null,
        learnedLocation: dev.ouPath || null,
        notes: dev.description || `Auto-discovered from Active Directory integration "${integrationName}"`,
        lastSeen: lastLogon,
        acquiredAt: whenCreated,
        tags,
        // Realm-monitorable hosts: lock monitoring source to this AD integration
        // so the bind credentials are reused for the probe (WinRM for Windows,
        // SSH for Linux).
        ...(adMonitorable ? { discoveredByIntegrationId: integrationId, monitorType: "activedirectory" } : {}),
      };
      clampAcquiredToLastSeen(createData);
      const newAsset = await prisma.asset.create({ data: createData as any });
      assetByAdGuidTag.set(guidKey, newAsset);
      if (dev.objectSid) assetBySid.set(dev.objectSid.toUpperCase(), newAsset);
      created.push(displayName || dev.objectGuid);
    } catch (err: any) {
      syncLog("error", `Failed to create asset for AD computer ${displayName || dev.objectGuid}: ${err.message || "Unknown error"}`);
    }
  }

  syncLog("info", `Active Directory sync: ${created.length} created, ${updated.length} updated, ${skipped.length} skipped`);
  return { created, updated, skipped };
}

function stripSecret(integration: Record<string, any>) {
  const config = { ...(integration.config as Record<string, unknown>) };
  if (config.apiToken) {
    config.apiToken = "••••••••";
  }
  if (config.fortigateApiToken) {
    config.fortigateApiToken = "••••••••";
  }
  if (config.password) {
    config.password = "••••••••";
  }
  if (config.clientSecret) {
    config.clientSecret = "••••••••";
  }
  if (config.bindPassword) {
    config.bindPassword = "••••••••";
  }
  return { ...integration, config };
}

export function hasActiveDiscoveries(): boolean {
  return activeDiscovery.size > 0;
}

export default router;
