/**
 * src/api/routes/integrations.ts — Integration CRUD + connection testing
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requireNetworkAdmin } from "../middleware/auth.js";
import * as fortimanager from "../../services/fortimanagerService.js";
import * as windowsServer from "../../services/windowsServerService.js";
import { isValidIpAddress, ipInCidr, normalizeCidr, cidrContains, cidrOverlaps } from "../../utils/cidr.js";
import type { DiscoveredSubnet, DiscoveryResult, DiscoveredDevice, DiscoveredInterfaceIp, DiscoveredDhcpEntry, DiscoveredInventoryDevice, DiscoveryProgressCallback } from "../../services/fortimanagerService.js";
import { logEvent } from "./events.js";
import { getConfiguredResolver } from "../../services/dnsService.js";
import { lookupOui, lookupOuiOverride } from "../../services/ouiService.js";

const router = Router();

// Track in-flight DHCP discovery per integration — abort previous if re-saved
const activeDiscovery = new Map<string, { controller: AbortController; name: string; currentDevice?: string }>();

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
  dhcpInclude:   z.array(z.string()).optional().default([]),
  dhcpExclude:   z.array(z.string()).optional().default([]),
  inventoryExcludeInterfaces: z.array(z.string()).optional().default([]),
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
    type:         z.literal("windowsserver"),
    name:         z.string().min(1, "Name is required"),
    config:       WindowsServerConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(4),
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

    // Auto-register FortiManager IP as asset/reservation
    if (input.type === "fortimanager" && input.config.host) {
      const registration = await registerFortiManager(input.config.host, input.name, false);
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
          discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], fortiSwitches: [], fortiAps: [] };
        } else {
          discoveryResult = await fortimanager.discoverDhcpSubnets(input.config as any, ac.signal);
        }
        const syncResult = await syncDhcpSubnets(integration.id, input.name, input.type, discoveryResult, req.session?.username);
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
      data.config = newConfig;
    }

    const updated = await prisma.integration.update({
      where: { id: req.params.id },
      data,
    });

    logEvent({ action: "integration.updated", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: req.session?.username, message: `Integration "${updated.name}" updated` });

    const finalConfig = (updated.config as Record<string, unknown>) || {};
    const response: Record<string, unknown> = stripSecret(updated);

    // Auto-register FortiManager IP as asset/reservation
    if (existing.type === "fortimanager" && finalConfig.host && typeof finalConfig.host === "string") {
      const registration = await registerFortiManager(finalConfig.host, updated.name, false);
      if (registration?.conflicts?.length) {
        response.conflicts = registration.conflicts;
      }
    }

    // DHCP discovery — only if previously tested successfully and auto-discover enabled
    const canDiscover =
      updated.lastTestOk === true &&
      updated.enabled &&
      updated.autoDiscover &&
      finalConfig.host &&
      ((existing.type === "fortimanager" && finalConfig.apiToken) ||
       (existing.type === "windowsserver" && finalConfig.username));

    if (canDiscover) {
      activeDiscovery.get(req.params.id)?.controller.abort();
      const ac = new AbortController();
      activeDiscovery.set(req.params.id, { controller: ac, name: updated.name });
      logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: req.session?.username, message: `DHCP discovery started for "${updated.name}"` });
      try {
        let discoveryResult: DiscoveryResult;
        if (existing.type === "windowsserver") {
          const subnets = await windowsServer.discoverDhcpScopes(finalConfig as any, ac.signal);
          discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], fortiSwitches: [], fortiAps: [] };
        } else {
          discoveryResult = await fortimanager.discoverDhcpSubnets(finalConfig as any, ac.signal);
        }
        const syncResult = await syncDhcpSubnets(updated.id, updated.name, existing.type, discoveryResult, req.session?.username);
        response.dhcpDiscovery = syncResult;
        logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: req.session?.username, message: `DHCP discovery completed for "${updated.name}" — ${syncResult.created.length} created, ${syncResult.updated.length} updated, ${syncResult.skipped.length} skipped` });
      } catch (err: any) {
        if (err.name !== "AbortError") {
          response.dhcpDiscoveryError = err.message || "DHCP discovery failed";
          logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: req.session?.username, level: "error", message: `DHCP discovery failed for "${updated.name}": ${err.message || "Unknown error"}` });
        }
      } finally {
        activeDiscovery.delete(req.params.id);
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
    } else if (integration.type === "windowsserver") {
      result = await windowsServer.testConnection(config as any);
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
    const result = await registerFortiManager(config.host as string, integration.name, true, fields);
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
  if (!config.host) throw new AppError(400, "Integration has no host configured");
  if (integration.type === "fortimanager" && !config.apiToken) throw new AppError(400, "Integration has no API token configured");
  if (integration.type === "windowsserver" && !config.username) throw new AppError(400, "Integration has no username configured");

  activeDiscovery.get(integrationId)?.controller.abort();
  const ac = new AbortController();
  const integrationName = integration.name;
  activeDiscovery.set(integrationId, { controller: ac, name: integrationName });

  const label = actor === "auto-discovery" ? "Scheduled" : "Manual";
  logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, message: `${label} DHCP discovery started for "${integrationName}"` });

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
      const syncTotals = { created: [] as string[], updated: [] as string[], skipped: [] as string[] };

      // Per-device callback: sync each FortiGate's data as it arrives (phases 1, 3–9).
      // Phase 2 (stale deprecation) runs separately at the end once all devices are known.
      const onDeviceComplete = async (deviceResult: DiscoveryResult) => {
        const r = await syncDhcpSubnets(integrationId, integrationName, integration.type, deviceResult, actor, "skip-deprecation");
        syncTotals.created.push(...r.created);
        syncTotals.updated.push(...r.updated);
        syncTotals.skipped.push(...r.skipped);
      };

      if (integration.type === "windowsserver") {
        const subnets = await windowsServer.discoverDhcpScopes(config as any, ac.signal);
        discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], fortiSwitches: [], fortiAps: [] };
        // Windows Server is a single host — no per-device iteration, sync the full result normally
        const r = await syncDhcpSubnets(integrationId, integrationName, integration.type, discoveryResult, actor);
        syncTotals.created.push(...r.created);
        syncTotals.updated.push(...r.updated);
        syncTotals.skipped.push(...r.skipped);
      } else {
        // FortiManager: onDeviceComplete fires after each managed FortiGate is queried,
        // syncing subnets/assets/reservations incrementally.
        discoveryResult = await fortimanager.discoverDhcpSubnets(config as any, ac.signal, onProgress, integration.pollInterval ?? 24, onDeviceComplete);
        // Run stale deprecation once, now that the full device list is known.
        await syncDhcpSubnets(integrationId, integrationName, integration.type, discoveryResult, actor, "deprecation-only");
      }

      // ── ORIGINAL BATCH SYNC (commented out — replaced by per-device callback above) ──
      // const syncResult = await syncDhcpSubnets(integrationId, integrationName, integration.type, discoveryResult, actor);

      logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, message: `${label} DHCP discovery completed for "${integrationName}" — ${syncTotals.created.length} created, ${syncTotals.updated.length} updated, ${syncTotals.skipped.length} skipped` });
    } catch (err: any) {
      if (err.name !== "AbortError") {
        logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level: "error", message: `${label} DHCP discovery failed for "${integrationName}": ${err.message || "Unknown error"}` });
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
        if (input.type === "fortimanager" && (!cfg.apiToken || typeof cfg.apiToken !== "string")) {
          cfg.apiToken = stored.apiToken;
        }
        if (input.type === "windowsserver" && (!cfg.password || typeof cfg.password !== "string")) {
          cfg.password = stored.password;
        }
      }
    }

    if (input.type === "fortimanager") {
      result = await fortimanager.testConnection(input.config);
    } else if (input.type === "windowsserver") {
      result = await windowsServer.testConnection(input.config);
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
 * Register a FortiManager's IP as a subnet reservation and asset.
 * If force=false, returns conflicts instead of overwriting.
 * If force=true, overwrites selected fields on the existing reservation.
 */
async function registerFortiManager(host: string, integrationName: string, force: boolean, fields: string[] = []) {
  if (!isValidIpAddress(host)) return { conflicts: [], created: [] };

  const subnets = await prisma.subnet.findMany();
  const matchingSubnet = subnets.find((s) => ipInCidr(host, s.cidr));

  if (!matchingSubnet && !isPrivateIp(host)) return { conflicts: [], created: [] };

  const conflicts: ConflictEntry[] = [];
  const created: string[] = [];
  const hostname = integrationName.toLowerCase().replace(/\s+/g, "-");

  // ── Reservation ──
  const proposedReservation = {
    ipAddress: host,
    hostname,
    owner: "network-team",
    projectRef: "FortiManager Integration",
    notes: `Auto-registered from FortiManager integration: ${integrationName}`,
    status: "active" as const,
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
    assetType: "server" as const,
    status: "active" as const,
    manufacturer: "Fortinet",
    model: "FortiManager",
    department: "Network Security",
    notes: `Auto-registered from FortiManager integration: ${integrationName}`,
    tags: ["fortimanager", "auto-registered"],
  };

  await prisma.asset.create({ data: proposedAsset });
  created.push("asset");

  return { conflicts, created };
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

  /** Broad match: MAC → hostname → IP (same priority order as original code) */
  findByEntry(mac?: string, hostname?: string, ip?: string): any | undefined {
    if (mac) {
      const norm = mac.toUpperCase().replace(/-/g, ":");
      const hit = this.byMac.get(norm);
      if (hit) return hit;
    }
    if (hostname) {
      const hit = this.byHostname.get(hostname.toLowerCase());
      if (hit) return hit;
    }
    if (ip) {
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
// "skip-deprecation"   — run phases 1, 3–9 but not phase 2 (used in per-device syncs)
// "deprecation-only"   — run only phase 2 (used after all per-device syncs complete)
type SyncMode = "full" | "skip-deprecation" | "deprecation-only";

async function syncDhcpSubnets(integrationId: string, integrationName: string, integrationType: string, result: DiscoveryResult, actor?: string, mode: SyncMode = "full") {
  const syncLog = (level: "info" | "error", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const assetNames: string[] = [];
  const reservationNames: string[] = [];
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

  // Collect the set of FortiGate device names in this discovery
  const discoveredDeviceNames = new Set(result.devices.map((d) => d.name));

  if (mode !== "deprecation-only") {
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
          purpose: `Discovered from ${integrationType === "windowsserver" ? "Windows Server" : "FortiManager"} DHCP`,
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
  } // end mode !== "deprecation-only" (Phase 1)

  if (mode !== "skip-deprecation") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 2 — Deprecate stale subnets (single updateMany)
  // ══════════════════════════════════════════════════════════════════════════════

  if (discoveredDeviceNames.size > 0) {
    // Find stale subnets in-memory first (for the return value)
    const staleSubnets = allSubnets.filter(
      (s) => s.discoveredBy === integrationId && s.status !== "deprecated" &&
             s.fortigateDevice && !discoveredDeviceNames.has(s.fortigateDevice)
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
      }
    }
  }

  } // end mode !== "skip-deprecation" (Phase 2)

  if (mode !== "deprecation-only") {
  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 3 — Create/update FortiGate device assets (in-memory serial lookup)
  // ══════════════════════════════════════════════════════════════════════════════

  for (const device of result.devices) {
    try {
      if (device.serial) {
        const existingAsset = assetIdx.findBySerial(device.serial);
        if (existingAsset) {
          await prisma.asset.update({
            where: { id: existingAsset.id },
            data: {
              ipAddress: device.mgmtIp || existingAsset.ipAddress,
              hostname: device.hostname || existingAsset.hostname,
              model: device.model || existingAsset.model,
              lastSeen: new Date(now),
            },
          });
          // Update in-memory
          if (device.mgmtIp) existingAsset.ipAddress = device.mgmtIp;
          if (device.hostname) existingAsset.hostname = device.hostname;
          if (device.model) existingAsset.model = device.model;
          assetIdx.reindex(existingAsset);
          assetNames.push(`${device.name} (updated)`);
          continue;
        }
      }

      const newAsset = await prisma.asset.create({
        data: {
          ipAddress: device.mgmtIp || null,
          hostname: device.hostname || device.name,
          serialNumber: device.serial || null,
          manufacturer: "Fortinet",
          model: device.model || "FortiGate",
          assetType: "firewall",
          status: "active",
          department: "Network Security",
          lastSeen: new Date(now),
          notes: `Auto-discovered from FortiManager integration`,
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
    try {
      let existingAsset: any = sw.serial ? assetIdx.findBySerial(sw.serial) : null;
      if (!existingAsset && sw.name) existingAsset = assetIdx.findByEntry(undefined, sw.name, sw.ipAddress || undefined);

      if (existingAsset) {
        await prisma.asset.update({
          where: { id: existingAsset.id },
          data: {
            ipAddress: sw.ipAddress || existingAsset.ipAddress,
            hostname: sw.name || existingAsset.hostname,
            model: sw.model || existingAsset.model,
            osVersion: sw.osVersion || existingAsset.osVersion,
            learnedLocation: sw.device || existingAsset.learnedLocation,
            lastSeen: new Date(now),
          },
        });
        if (sw.ipAddress) existingAsset.ipAddress = sw.ipAddress;
        assetIdx.reindex(existingAsset);
        assetNames.push(`${sw.name} (updated)`);
      } else {
        const newAsset = await prisma.asset.create({
          data: {
            ipAddress: sw.ipAddress || null,
            hostname: sw.name || null,
            serialNumber: sw.serial || null,
            manufacturer: "Fortinet",
            model: sw.model || "FortiSwitch",
            assetType: "switch",
            status: "active",
            osVersion: sw.osVersion || null,
            learnedLocation: sw.device || null,
            lastSeen: new Date(now),
            notes: `Auto-discovered from FortiGate ${sw.device} via FortiManager`,
            tags: ["fortiswitch", "auto-discovered"],
          },
        });
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
        if (!activeResMap.has(key)) {
          try {
            const newRes = await prisma.reservation.create({
              data: {
                subnetId: matchingSubnet.id,
                ipAddress: sw.ipAddress,
                hostname: sw.name || null,
                owner: "network-team",
                projectRef: "FortiManager Integration",
                notes: `FortiSwitch managed by FortiGate ${sw.device}`,
                status: "active",
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

  for (const ap of result.fortiAps || []) {
    try {
      const normalizedMac = ap.baseMac ? ap.baseMac.toUpperCase().replace(/-/g, ":") : null;
      let existingAsset: any = ap.serial ? assetIdx.findBySerial(ap.serial) : null;
      if (!existingAsset && normalizedMac) existingAsset = assetIdx.findByMac(normalizedMac);
      if (!existingAsset && ap.name) existingAsset = assetIdx.findByEntry(undefined, ap.name, ap.ipAddress || undefined);

      if (existingAsset) {
        await prisma.asset.update({
          where: { id: existingAsset.id },
          data: {
            ipAddress: ap.ipAddress || existingAsset.ipAddress,
            hostname: ap.name || existingAsset.hostname,
            model: ap.model || existingAsset.model,
            osVersion: ap.osVersion || existingAsset.osVersion,
            learnedLocation: ap.device || existingAsset.learnedLocation,
            lastSeen: new Date(now),
          },
        });
        if (ap.ipAddress) existingAsset.ipAddress = ap.ipAddress;
        assetIdx.reindex(existingAsset);
        assetNames.push(`${ap.name} (updated)`);
      } else {
        const newAsset = await prisma.asset.create({
          data: {
            ipAddress: ap.ipAddress || null,
            macAddress: normalizedMac,
            macAddresses: normalizedMac ? [{ mac: normalizedMac, lastSeen: now, source: "fmg-discovery" }] : [],
            hostname: ap.name || null,
            serialNumber: ap.serial || null,
            manufacturer: "Fortinet",
            model: ap.model || "FortiAP",
            assetType: "access_point",
            status: "active",
            osVersion: ap.osVersion || null,
            learnedLocation: ap.device || null,
            lastSeen: new Date(now),
            notes: `Auto-discovered from FortiGate ${ap.device} via FortiManager`,
            tags: ["fortiap", "auto-discovered"],
          },
        });
        assetIdx.add(newAsset);
        assetNames.push(ap.name || ap.serial);
      }
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for FortiAP ${ap.name}: ${err.message || "Unknown error"}`);
    }

    if (ap.ipAddress) {
      const matchingSubnet = findSubnetForIp(ap.ipAddress);
      if (matchingSubnet) {
        const key = reservationKey(matchingSubnet.id, ap.ipAddress);
        if (!activeResMap.has(key)) {
          try {
            const newRes = await prisma.reservation.create({
              data: {
                subnetId: matchingSubnet.id,
                ipAddress: ap.ipAddress,
                hostname: ap.name || null,
                owner: "network-team",
                projectRef: "FortiManager Integration",
                notes: `FortiAP managed by FortiGate ${ap.device}`,
                status: "active",
              },
            });
            activeResMap.set(key, newRes);
            reservationNames.push(`${ap.ipAddress} (${ap.name})`);
          } catch (err: any) {
            syncLog("error", `Failed to create reservation for FortiAP ${ap.name} at ${ap.ipAddress}: ${err.message || "Unknown error"}`);
          }
        }
      }
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
    if (activeResMap.has(key)) continue; // Already reserved

    try {
      const newRes = await prisma.reservation.create({
        data: {
          subnetId: matchingSubnet.id,
          ipAddress: ifaceIp.ipAddress,
          hostname: ifaceIp.device,
          owner: "network-team",
          projectRef: "FortiManager Integration",
          notes: `${ifaceIp.role === "management" ? "Management" : "DHCP server"} interface (${ifaceIp.interfaceName}) on ${ifaceIp.device}`,
          status: "active",
        },
      });
      activeResMap.set(key, newRes); // Track so DHCP phase doesn't duplicate
      reservationNames.push(`${ifaceIp.ipAddress} (${ifaceIp.device}/${ifaceIp.interfaceName})`);
    } catch (err: any) {
      syncLog("error", `Failed to create reservation for interface IP ${ifaceIp.ipAddress} on ${ifaceIp.device}/${ifaceIp.interfaceName}: ${err.message || "Unknown error"}`);
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
      if (activeResMap.has(key)) continue; // Already reserved

      const isDhcpReservation = entry.type === "dhcp-reservation";

      // Look up matching asset by MAC (in-memory)
      let matchedAsset: any = null;
      if (entry.macAddress) {
        matchedAsset = assetIdx.findByMac(entry.macAddress.toUpperCase().replace(/-/g, ":"));
      }

      try {
        const newRes = await prisma.reservation.create({
          data: {
            subnetId: matchingSubnet.id,
            ipAddress: entry.ipAddress,
            hostname: (matchedAsset && matchedAsset.hostname) || entry.hostname || null,
            owner: (matchedAsset && matchedAsset.assignedTo) || (isDhcpReservation ? "dhcp-reservation" : "dhcp-lease"),
            projectRef: "FortiManager Integration",
            notes: `${isDhcpReservation ? "DHCP reservation" : "DHCP lease"} on ${entry.device} (${entry.interfaceName})${entry.macAddress ? " — MAC: " + entry.macAddress : ""}`,
            status: "active",
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

      const asset = assetIdx.findByEntry(entry.macAddress, entry.hostname, entry.ipAddress);
      if (!asset) continue;

      // Update MAC list in-memory
      const macList: Array<{mac: string; lastSeen: string; source: string}> = Array.isArray(asset.macAddresses) ? [...(asset.macAddresses as any)] : [];
      const existingMac = macList.find((m: any) => m.mac === normalized);
      if (existingMac) {
        existingMac.lastSeen = now;
        existingMac.source = entry.type;
      } else {
        macList.push({ mac: normalized, lastSeen: now, source: entry.type });
      }
      macList.sort((a: any, b: any) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());

      // Queue asset update
      assetUpdates.push({
        id: asset.id,
        data: {
          macAddress: macList[0].mac,
          macAddresses: macList,
          ipAddress: entry.ipAddress,
          status: "active",
          ...(entry.device ? { learnedLocation: entry.device } : {}),
        },
      });

      // Update in-memory so device inventory phase sees current state
      asset.macAddress = macList[0].mac;
      asset.macAddresses = macList;
      asset.ipAddress = entry.ipAddress;
      asset.status = "active";
      if (entry.device) asset.learnedLocation = entry.device;
      assetIdx.reindex(asset);

      // Queue reservation cross-update (in-memory lookup, no DB query)
      const matchingSubnet = findSubnetForIp(entry.ipAddress);
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

      // In-memory asset lookup
      const existingAsset = normalizedMac
        ? assetIdx.findByEntry(inv.macAddress, inv.hostname, inv.ipAddress)
        : assetIdx.findByEntry(undefined, inv.hostname, inv.ipAddress);

      const switchConn = inv.switchName
        ? (inv.switchPort ? `${inv.switchName}/port${inv.switchPort}` : inv.switchName)
        : null;
      const apConn = inv.apName || null;

      if (existingAsset) {
        const updateData: Record<string, unknown> = { lastSeen: new Date(now) };
        if (!handledByDhcp && inv.ipAddress && inv.ipAddress !== existingAsset.ipAddress) {
          updateData.ipAddress = inv.ipAddress;
        }
        if (inv.os && !existingAsset.os) updateData.os = inv.os;
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
          const macList: Array<{mac: string; lastSeen: string; source: string}> = Array.isArray(existingAsset.macAddresses) ? [...(existingAsset.macAddresses as any)] : [];
          const existingMac = macList.find((m) => m.mac === normalizedMac);
          if (existingMac) {
            existingMac.lastSeen = now;
            existingMac.source = "device-inventory";
          } else {
            macList.push({ mac: normalizedMac, lastSeen: now, source: "device-inventory" });
          }
          macList.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
          updateData.macAddress = macList[0].mac;
          updateData.macAddresses = macList;
        }

        if (Object.keys(updateData).length > 0) {
          try {
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
              macAddresses: normalizedMac ? [{ mac: normalizedMac, lastSeen: now, source: "device-inventory" }] : [],
              hostname: inv.hostname || null,
              manufacturer: inv.hardwareVendor || null,
              assetType: "other",
              status: "active",
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
  // Phase 8 — DNS reverse lookup for assets missing dnsName
  // ══════════════════════════════════════════════════════════════════════════════

  const assetsNeedingDns = assetIdx.all().filter((a: any) => a.ipAddress && !a.dnsName);
  if (assetsNeedingDns.length > 0) {
    syncLog("info", `DNS lookup: resolving ${assetsNeedingDns.length} assets missing dnsName`);
    const dnsResolver = await getConfiguredResolver();
    const dnsResults = await batchSettled(assetsNeedingDns, async (asset: any) => {
      const hostnames = await dnsResolver.reverse(asset.ipAddress);
      if (hostnames.length > 0) {
        await prisma.asset.update({ where: { id: asset.id }, data: { dnsName: hostnames[0] } });
        asset.dnsName = hostnames[0];
        return hostnames[0];
      }
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
  //       (e.g. "Fortinet" from FMG can be overridden to a custom name)
  const assetsWithMacAndMfg = assetIdx.all().filter((a: any) => a.macAddress && a.manufacturer);
  if (assetsWithMacAndMfg.length > 0) {
    const overrideResults = await batchSettled(assetsWithMacAndMfg, async (asset: any) => {
      const override = await lookupOuiOverride(asset.macAddress);
      if (override && override !== asset.manufacturer) {
        await prisma.asset.update({ where: { id: asset.id }, data: { manufacturer: override } });
        asset.manufacturer = override;
        return override;
      }
      return null;
    });
    for (const r of overrideResults) {
      if (r.status === "fulfilled" && r.value) ouiOverridden++;
    }
    if (ouiOverridden > 0) {
      syncLog("info", `OUI overrides: applied to ${ouiOverridden} assets`);
    }
  }

  // 9b — OUI lookup for assets still missing a manufacturer
  const assetsNeedingOui = assetIdx.all().filter((a: any) => a.macAddress && !a.manufacturer);
  if (assetsNeedingOui.length > 0) {
    syncLog("info", `OUI lookup: resolving ${assetsNeedingOui.length} assets missing manufacturer`);
    const ouiResults = await batchSettled(assetsNeedingOui, async (asset: any) => {
      const vendor = await lookupOui(asset.macAddress);
      if (vendor) {
        await prisma.asset.update({ where: { id: asset.id }, data: { manufacturer: vendor } });
        asset.manufacturer = vendor;
        return vendor;
      }
      return null;
    });
    for (const r of ouiResults) {
      if (r.status === "fulfilled" && r.value) ouiResolved++;
    }
    if (ouiResolved > 0) {
      syncLog("info", `OUI lookup: resolved ${ouiResolved} of ${assetsNeedingOui.length} assets`);
    }
  }

  } // end mode !== "deprecation-only" (Phases 3–9)

  return { created, updated, skipped, deprecated, assets: assetNames, reservations: reservationNames, dhcpLeases: dhcpLeases.length, dhcpReservations: dhcpReservations.length, inventoryDevices: inventoryAssets.length, dnsResolved, ouiResolved, ouiOverridden };
}

function stripSecret(integration: Record<string, any>) {
  const config = { ...(integration.config as Record<string, unknown>) };
  if (config.apiToken) {
    config.apiToken = "••••••••";
  }
  if (config.password) {
    config.password = "••••••••";
  }
  return { ...integration, config };
}

export function hasActiveDiscoveries(): boolean {
  return activeDiscovery.size > 0;
}

export default router;
