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

const router = Router();

// Track in-flight DHCP discovery per integration — abort previous if re-saved
const activeDiscovery = new Map<string, { controller: AbortController; name: string; currentDevice?: string }>();

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

// All integration routes require network admin or admin
router.use(requireNetworkAdmin);

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

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
  // Legacy field names accepted on write; service reads both with fallback
  dhcpInclude:   z.array(z.string()).optional(),
  dhcpExclude:   z.array(z.string()).optional(),
  inventoryExcludeInterfaces: z.array(z.string()).optional().default([]),
  inventoryIncludeInterfaces: z.array(z.string()).optional().default([]),
  deviceInclude: z.array(z.string()).optional().default([]),
  deviceExclude: z.array(z.string()).optional().default([]),
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

// GET /api/v1/integrations/discoveries — active background discoveries
router.get("/discoveries", (req, res) => {
  const running = Array.from(activeDiscovery.entries()).map(([id, { name, currentDevice }]) => ({ id, name, currentDevice }));
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
      activeDiscovery.set(integration.id, { controller: ac, name: input.name });
      logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: req.session?.username, message: `DHCP discovery started for "${input.name}"` });
      try {
        let discoveryResult: DiscoveryResult;
        if (input.type === "windowsserver") {
          const subnets = await windowsServer.discoverDhcpScopes(input.config as any, ac.signal);
          // Windows Server stamps subnets with config.host as their fortigateDevice,
          // so the "known roster" is just the DHCP server host itself.
          const wsHost = (input.config as any).host as string;
          discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames: wsHost ? [wsHost] : [], fortiSwitches: [], fortiAps: [], vips: [] };
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
      if (!input.config.password) {
        newConfig.password = currentConfig.password;
      }
      if (!input.config.clientSecret) {
        newConfig.clientSecret = currentConfig.clientSecret;
      }
      if (!input.config.bindPassword) {
        newConfig.bindPassword = currentConfig.bindPassword;
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

    // DHCP discovery — fire detached so the save response returns immediately.
    // triggerDiscovery revalidates credentials/config and logs its own start/error events.
    const canDiscover =
      updated.lastTestOk === true &&
      updated.enabled &&
      updated.autoDiscover &&
      (
        (finalConfig.host &&
          ((existing.type === "fortimanager" && finalConfig.apiToken) ||
           (existing.type === "fortigate" && finalConfig.apiToken) ||
           (existing.type === "windowsserver" && finalConfig.username) ||
           (existing.type === "activedirectory" && finalConfig.bindDn && finalConfig.bindPassword && finalConfig.baseDn))) ||
        (existing.type === "entraid" && finalConfig.tenantId && finalConfig.clientId && finalConfig.clientSecret)
      );

    if (canDiscover) {
      try {
        await triggerDiscovery(req.params.id, req.session?.username ?? "");
      } catch (err: any) {
        logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: req.session?.username, level: "error", message: `DHCP discovery failed to start for "${updated.name}": ${err.message || "Unknown error"}` });
      }
    }

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

// POST /api/v1/integrations/:id/query — proxy a manual API call to a FortiManager or FortiGate
router.post("/:id/query", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) throw new AppError(404, "Integration not found");

    if (integration.type === "fortimanager") {
      const { method, params } = z.object({
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
  activeDiscovery.set(integrationId, { controller: ac, name: integrationName });

  await prisma.integration.update({ where: { id: integrationId }, data: { lastDiscoveryAt: new Date() } });

  const label = actor === "auto-discovery" ? "Scheduled" : "Manual";
  const kindLabel = (integration.type === "entraid" || integration.type === "activedirectory") ? "device discovery" : "DHCP discovery";
  logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, message: `${label} ${kindLabel} started for "${integrationName}"` });

  const onProgress: DiscoveryProgressCallback = (step, level, message, device) => {
    logEvent({ action: `integration.${step}`, resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
    if (device) {
      const entry = activeDiscovery.get(integrationId);
      if (entry) entry.currentDevice = device;
    }
  };

  (async () => {
    try {
      let discoveryResult: DiscoveryResult;

      // Accumulate per-device sync totals for the completion log
      const syncTotals = { created: [] as string[], updated: [] as string[], skipped: [] as string[], deprecated: [] as string[] };

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
        discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames: wsHost ? [wsHost] : [], fortiSwitches: [], fortiAps: [], vips: [] };
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
        logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, message: `${label} ${kindLabel} completed for "${integrationName}" — ${syncTotals.created.length} created, ${syncTotals.updated.length} updated, ${syncTotals.skipped.length} skipped${deprecatedSuffix}` });
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
  let dnsResolved = 0;
  let ouiResolved = 0;
  let ouiOverridden = 0;
  const now = new Date().toISOString();

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

  } // end mode !== "skip-deprecation" (Phase 2)

  if (mode === "full" || mode === "skip-deprecation") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 3 — Create/update FortiGate device assets (in-memory serial lookup)
  // ══════════════════════════════════════════════════════════════════════════════

  for (const device of result.devices) {
    try {
      const fgHostname = device.hostname || device.name;
      if (device.serial) {
        const existingAsset = assetIdx.findBySerial(device.serial);
        if (existingAsset) {
          const updateData: Record<string, unknown> = {
            ipAddress: device.mgmtIp || existingAsset.ipAddress,
            ...(device.mgmtIp ? { ipSource: integrationType } : {}),
            hostname: device.hostname || existingAsset.hostname,
            model: device.model || existingAsset.model,
            learnedLocation: existingAsset.learnedLocation || fgHostname,
            lastSeen: new Date(now),
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

      const newAsset = await prisma.asset.create({
        data: {
          ipAddress: device.mgmtIp || null,
          ...(device.mgmtIp ? { ipSource: integrationType } : {}),
          hostname: fgHostname,
          serialNumber: device.serial || null,
          manufacturer: "Fortinet",
          model: device.model || "FortiGate",
          assetType: "firewall",
          status: "active",
          statusChangedAt: new Date(now),
          statusChangedBy: integrationLabel,
          department: "Network Security",
          learnedLocation: fgHostname,
          lastSeen: new Date(now),
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

  for (const sw of result.fortiSwitches || []) {
    const swStatus = sw.state === "Unauthorized" ? "storage" : "active";
    const swJoinDate = sw.joinTime && Number.isFinite(sw.joinTime) && sw.joinTime > 0
      ? new Date(sw.joinTime * 1000) : null;
    const swNotes = `Auto-discovered from FortiGate ${sw.device}${sw.fgtInterface ? ` via ${sw.fgtInterface}` : ""} via ${integrationLabel}`;
    try {
      let existingAsset: any = sw.serial ? assetIdx.findBySerial(sw.serial) : null;
      if (!existingAsset && sw.name) existingAsset = assetIdx.findByEntry(undefined, sw.name, sw.ipAddress || undefined);

      if (existingAsset) {
        const acquiredAtUpdate = swJoinDate && (!existingAsset.acquiredAt || swJoinDate < new Date(existingAsset.acquiredAt))
          ? swJoinDate : undefined;
        const updateData: Record<string, unknown> = {
          ipAddress: sw.ipAddress || existingAsset.ipAddress,
          ...(sw.ipAddress ? { ipSource: integrationType } : {}),
          hostname: sw.name || existingAsset.hostname,
          osVersion: sw.osVersion || existingAsset.osVersion,
          learnedLocation: sw.device || existingAsset.learnedLocation,
          status: swStatus,
          ...(swStatus !== existingAsset.status ? { statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
          lastSeen: new Date(now),
          ...(acquiredAtUpdate ? { acquiredAt: acquiredAtUpdate } : {}),
        };
        clampAcquiredToLastSeen(updateData, existingAsset);
        await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
        if (sw.ipAddress) existingAsset.ipAddress = sw.ipAddress;
        assetIdx.reindex(existingAsset);
        assetNames.push(`${sw.name} (updated)`);
      } else {
        const createData: Record<string, unknown> = {
          ipAddress: sw.ipAddress || null,
          ...(sw.ipAddress ? { ipSource: integrationType } : {}),
          hostname: sw.name || null,
          serialNumber: sw.serial || null,
          manufacturer: "Fortinet",
          model: "FortiSwitch",
          assetType: "switch",
          status: swStatus,
          statusChangedAt: new Date(now),
          statusChangedBy: integrationLabel,
          osVersion: sw.osVersion || null,
          learnedLocation: sw.device || null,
          acquiredAt: swJoinDate,
          lastSeen: new Date(now),
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

      if (existingAsset) {
        const updateData: Record<string, unknown> = {
          ipAddress: resolvedIp || existingAsset.ipAddress,
          ...(resolvedIp ? { ipSource: integrationType } : {}),
          hostname: ap.name || existingAsset.hostname,
          model: ap.model || existingAsset.model,
          osVersion: ap.osVersion || existingAsset.osVersion,
          learnedLocation: ap.device || existingAsset.learnedLocation,
          lastSeen: new Date(now),
          ...(existingAsset.status === "decommissioned" ? { status: "active", statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
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
            ...(resolvedIp ? { ipSource: integrationType } : {}),
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
  // Phase 4b — Update FortiGate asset associatedIps from non-management interface IPs
  // ══════════════════════════════════════════════════════════════════════════════

  const ifaceIpsByDevice = new Map<string, Array<{ ip: string; interfaceName: string }>>();
  const totalNonMgmtIps = result.interfaceIps.filter((ip) => ip.ipAddress && ip.role !== "management").length;
  for (const ifaceIp of result.interfaceIps) {
    if (!ifaceIp.ipAddress || ifaceIp.role === "management") continue;
    const list = ifaceIpsByDevice.get(ifaceIp.device) ?? [];
    list.push({ ip: ifaceIp.ipAddress, interfaceName: ifaceIp.interfaceName });
    ifaceIpsByDevice.set(ifaceIp.device, list);
  }
  syncLog("info", `Phase 4b: ${totalNonMgmtIps} non-management interface IP(s) across ${ifaceIpsByDevice.size} device(s)`);

  for (const [deviceName, ifaces] of ifaceIpsByDevice) {
    const matchingDevice = result.devices.find((d: any) => d.name === deviceName || d.hostname === deviceName);
    let asset: any = matchingDevice?.serial ? assetIdx.findBySerial(matchingDevice.serial) : null;
    let matchedBy = asset ? "serial" : "";
    if (!asset) {
      asset = assetIdx.findByEntry(undefined, deviceName, undefined);
      if (asset) matchedBy = "hostname";
    }
    if (!asset) {
      syncLog("info", `Phase 4b: ${deviceName}: no matching asset found (serial=${matchingDevice?.serial || "n/a"}, hostname=${deviceName}) — ${ifaces.length} IP(s) dropped`);
      continue;
    }

    const existingIps: any[] = Array.isArray(asset.associatedIps) ? (asset.associatedIps as any[]) : [];
    const manualIps = existingIps.filter((e: any) => e.source === "manual");
    const discoveredIps = ifaces.map((iface) => ({
      ip: iface.ip,
      interfaceName: iface.interfaceName,
      source: "fmg-discovery",
      lastSeen: now,
    }));

    const newAssociatedIps = [...manualIps, ...discoveredIps];
    try {
      await prisma.asset.update({ where: { id: asset.id }, data: { associatedIps: newAssociatedIps } });
      asset.associatedIps = newAssociatedIps;
      syncLog("info", `Phase 4b: ${deviceName}: matched by ${matchedBy} (asset ${asset.id}) — wrote ${discoveredIps.length} discovered + ${manualIps.length} manual IP(s)`);
    } catch (err: any) {
      syncLog("error", `Failed to update associatedIps for ${deviceName}: ${err.message || "Unknown error"}`);
    }
  }

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
          await upsertConflict(existingRes.id, integrationId, { hostname: proposedHostname, owner: proposedOwner, projectRef: projectRefLabel, notes: proposedNotes, sourceType: proposedSourceType }, existingRes);
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

    for (const entry of result.dhcpEntries) {
      if (!entry.macAddress || !entry.ipAddress) continue;
      const normalized = entry.macAddress.toUpperCase().replace(/-/g, ":");

      // DHCP IPs recycle across devices, so IP-only matches would staple
      // a new device's MAC onto the previous lease-holder's asset.
      const asset = assetIdx.findByEntry(entry.macAddress, entry.hostname, entry.ipAddress, { allowIpFallback: false });
      if (!asset) continue;

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
          ipSource: integrationType,
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

  return { created, updated, skipped, deprecated, assets: assetNames, reservations: reservationNames, vips: vipNames.length, dhcpLeases: dhcpLeases.length, dhcpReservations: dhcpReservations.length, inventoryDevices: inventoryAssets.length, dnsResolved, ouiResolved, ouiOverridden };
}

// ─── Entra ID asset sync ─────────────────────────────────────────────────────

const ENTRA_ASSET_TAG_PREFIX = "entra:";
const AD_ASSET_TAG_PREFIX = "ad:";
const SID_TAG_PREFIX = "sid:";
const AD_GUID_TAG_PREFIX = "ad-guid:";

function sidTag(sid: string): string {
  return `${SID_TAG_PREFIX}${sid.toUpperCase()}`;
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
    if (dev.onPremisesSecurityIdentifier) tags.push(sidTag(dev.onPremisesSecurityIdentifier));

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

    const tags: string[] = ["activedirectory", "auto-discovered", `${AD_GUID_TAG_PREFIX}${guidKey}`];
    if (dev.objectSid) tags.push(sidTag(dev.objectSid));
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
