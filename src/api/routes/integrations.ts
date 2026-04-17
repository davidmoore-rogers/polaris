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

const router = Router();

// Track in-flight DHCP discovery per integration — abort previous if re-saved
const activeDiscovery = new Map<string, AbortController>();

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
    pollInterval: z.number().int().min(1).max(24).optional().default(4),
  }),
  z.object({
    type:         z.literal("windowsserver"),
    name:         z.string().min(1, "Name is required"),
    config:       WindowsServerConfigSchema,
    enabled:      z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(4),
  }),
]);

const UpdateIntegrationSchema = z.object({
  name:         z.string().min(1).optional(),
  config:       z.record(z.unknown()).optional(),
  enabled:      z.boolean().optional(),
  pollInterval: z.number().int().min(1).max(24).optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/integrations
router.get("/", async (_req, res, next) => {
  try {
    const integrations = await prisma.integration.findMany({
      orderBy: { createdAt: "desc" },
    });
    // Strip passwords from the response
    const safe = integrations.map(stripSecret);
    res.json(safe);
  } catch (err) {
    next(err);
  }
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
        pollInterval: input.pollInterval,
      },
    });

    logEvent({ action: "integration.created", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: (req as any).user?.username, message: `Integration "${input.name}" (${input.type}) created` });

    const response: Record<string, unknown> = stripSecret(integration);

    // Auto-register FortiManager IP as asset/reservation
    if (input.type === "fortimanager" && input.config.host) {
      const registration = await registerFortiManager(input.config.host, input.name, false);
      if (registration?.conflicts?.length) {
        response.conflicts = registration.conflicts;
      }
    }

    // DHCP discovery
    const canDiscover =
      input.enabled !== false &&
      input.config.host &&
      ((input.type === "fortimanager" && (input.config as any).apiToken) ||
       (input.type === "windowsserver" && (input.config as any).username));

    if (canDiscover) {
      activeDiscovery.get(integration.id)?.abort();
      const ac = new AbortController();
      activeDiscovery.set(integration.id, ac);
      logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: (req as any).user?.username, message: `DHCP discovery started for "${input.name}"` });
      try {
        let discoveryResult: DiscoveryResult;
        if (input.type === "windowsserver") {
          const subnets = await windowsServer.discoverDhcpScopes(input.config as any, ac.signal);
          discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [] };
        } else {
          discoveryResult = await fortimanager.discoverDhcpSubnets(input.config as any, ac.signal);
        }
        const syncResult = await syncDhcpSubnets(integration.id, input.name, input.type, discoveryResult, (req as any).user?.username);
        response.dhcpDiscovery = syncResult;
        logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: (req as any).user?.username, message: `DHCP discovery completed for "${input.name}" — ${syncResult.created.length} created, ${syncResult.updated.length} updated, ${syncResult.skipped.length} skipped` });
      } catch (err: any) {
        if (err.name !== "AbortError") {
          response.dhcpDiscoveryError = err.message || "DHCP discovery failed";
          logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: (req as any).user?.username, level: "error", message: `DHCP discovery failed for "${input.name}": ${err.message || "Unknown error"}` });
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

    logEvent({ action: "integration.updated", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: (req as any).user?.username, message: `Integration "${updated.name}" updated` });

    const finalConfig = (updated.config as Record<string, unknown>) || {};
    const response: Record<string, unknown> = stripSecret(updated);

    // Auto-register FortiManager IP as asset/reservation
    if (existing.type === "fortimanager" && finalConfig.host && typeof finalConfig.host === "string") {
      const registration = await registerFortiManager(finalConfig.host, updated.name, false);
      if (registration?.conflicts?.length) {
        response.conflicts = registration.conflicts;
      }
    }

    // DHCP discovery
    const canDiscover =
      updated.enabled &&
      finalConfig.host &&
      ((existing.type === "fortimanager" && finalConfig.apiToken) ||
       (existing.type === "windowsserver" && finalConfig.username));

    if (canDiscover) {
      activeDiscovery.get(req.params.id)?.abort();
      const ac = new AbortController();
      activeDiscovery.set(req.params.id, ac);
      logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: (req as any).user?.username, message: `DHCP discovery started for "${updated.name}"` });
      try {
        let discoveryResult: DiscoveryResult;
        if (existing.type === "windowsserver") {
          const subnets = await windowsServer.discoverDhcpScopes(finalConfig as any, ac.signal);
          discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [] };
        } else {
          discoveryResult = await fortimanager.discoverDhcpSubnets(finalConfig as any, ac.signal);
        }
        const syncResult = await syncDhcpSubnets(updated.id, updated.name, existing.type, discoveryResult, (req as any).user?.username);
        response.dhcpDiscovery = syncResult;
        logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: (req as any).user?.username, message: `DHCP discovery completed for "${updated.name}" — ${syncResult.created.length} created, ${syncResult.updated.length} updated, ${syncResult.skipped.length} skipped` });
      } catch (err: any) {
        if (err.name !== "AbortError") {
          response.dhcpDiscoveryError = err.message || "DHCP discovery failed";
          logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: (req as any).user?.username, level: "error", message: `DHCP discovery failed for "${updated.name}": ${err.message || "Unknown error"}` });
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
    logEvent({ action: "integration.deleted", resourceType: "integration", resourceId: req.params.id, resourceName: existing.name, actor: (req as any).user?.username, message: `Integration "${existing.name}" deleted` });
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

    logEvent({ action: "integration.test.started", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: (req as any).user?.username, message: `Connection test started for "${integration.name}"` });

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

    logEvent({ action: "integration.test.completed", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: (req as any).user?.username, level: result.ok ? "info" : "warning", message: `Connection test ${result.ok ? "succeeded" : "failed"} for "${integration.name}": ${result.message}` });

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

// POST /api/v1/integrations/:id/discover — manually trigger DHCP discovery
router.post("/:id/discover", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");

    const config = integration.config as Record<string, unknown>;
    if (!config.host) {
      throw new AppError(400, "Integration has no host configured");
    }
    if (integration.type === "fortimanager" && !config.apiToken) {
      throw new AppError(400, "Integration has no API token configured");
    }
    if (integration.type === "windowsserver" && !config.username) {
      throw new AppError(400, "Integration has no username configured");
    }

    // Abort any in-flight discovery for this integration
    activeDiscovery.get(req.params.id)?.abort();
    const ac = new AbortController();
    activeDiscovery.set(req.params.id, ac);

    const actor = (req as any).user?.username;
    logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor, message: `Manual DHCP discovery started for "${integration.name}"` });

    // Progress callback — logs each Phase 2 step as an event
    const onProgress: DiscoveryProgressCallback = (step, level, message) => {
      logEvent({ action: `integration.${step}`, resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor, level, message: `[${integration.name}] ${message}` });
    };

    try {
      let discoveryResult: DiscoveryResult;
      if (integration.type === "windowsserver") {
        const subnets = await windowsServer.discoverDhcpScopes(config as any, ac.signal);
        discoveryResult = { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [] };
      } else {
        discoveryResult = await fortimanager.discoverDhcpSubnets(config as any, ac.signal, onProgress);
      }
      const syncResult = await syncDhcpSubnets(integration.id, integration.name, integration.type, discoveryResult, actor);
      logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: (req as any).user?.username, message: `Manual DHCP discovery completed for "${integration.name}" — ${syncResult.created.length} created, ${syncResult.updated.length} updated, ${syncResult.skipped.length} skipped` });
      res.json(syncResult);
    } catch (err: any) {
      logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: (req as any).user?.username, level: "error", message: `Manual DHCP discovery failed for "${integration.name}": ${err.message || "Unknown error"}` });
      throw err;
    } finally {
      activeDiscovery.delete(req.params.id);
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/test — test without saving (for the create form)
router.post("/test", async (req, res, next) => {
  try {
    const input = CreateIntegrationSchema.parse(req.body);
    let result: { ok: boolean; message: string; version?: string };

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
    status: "active",
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

/**
 * Sync discovered DHCP subnets into the database.
 * Creates new subnets or updates existing ones with integration/device info.
 * Also creates FortiGate assets and interface IP reservations.
 */
async function syncDhcpSubnets(integrationId: string, integrationName: string, integrationType: string, result: DiscoveryResult, actor?: string) {
  const syncLog = (level: "info" | "error", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const assets: string[] = [];
  const reservations: string[] = [];

  const blocks = await prisma.ipBlock.findMany();

  // Collect the set of FortiGate device names in this discovery
  const discoveredDeviceNames = new Set(result.devices.map((d) => d.name));

  // ── Sync subnets ──
  for (const entry of result.subnets) {
    let cidr: string;
    try {
      cidr = normalizeCidr(entry.cidr);
    } catch {
      skipped.push(`${entry.cidr} (invalid CIDR)`);
      continue;
    }

    // Check if a non-deprecated subnet with this CIDR already exists
    const existing = await prisma.subnet.findFirst({
      where: { cidr, status: { not: "deprecated" } },
    });
    if (existing) {
      await prisma.subnet.update({
        where: { id: existing.id },
        data: { discoveredBy: integrationId, fortigateDevice: entry.fortigateDevice },
      });
      updated.push(cidr);
      continue;
    }

    // Find the most specific parent block that contains this CIDR
    const matchingBlock = blocks
      .filter((b) => cidrContains(b.cidr, cidr))
      .sort((a, b) => {
        const prefixA = parseInt(a.cidr.split("/")[1], 10);
        const prefixB = parseInt(b.cidr.split("/")[1], 10);
        return prefixB - prefixA; // most specific first
      })[0];

    if (!matchingBlock) {
      skipped.push(`${cidr} (no matching parent block)`);
      continue;
    }

    // Check for overlaps with non-deprecated sibling subnets
    const siblings = await prisma.subnet.findMany({
      where: { blockId: matchingBlock.id, status: { not: "deprecated" } },
      select: { cidr: true },
    });
    const overlap = siblings.find((s) => cidrOverlaps(s.cidr, cidr));
    if (overlap) {
      skipped.push(`${cidr} (overlaps ${overlap.cidr})`);
      continue;
    }

    // Create the subnet (a deprecated entry with the same CIDR may exist — that's fine)
    try {
      await prisma.subnet.create({
        data: {
          blockId: matchingBlock.id,
          cidr,
          name: `DHCP: ${entry.name} (${entry.fortigateDevice})`,
          purpose: `Discovered from ${integrationType === "windowsserver" ? "Windows Server" : "FortiManager"} DHCP`,
          status: "available",
          discoveredBy: integrationId,
          fortigateDevice: entry.fortigateDevice,
          tags: ["dhcp-discovered", integrationType],
        },
      });
      created.push(cidr);
    } catch (err: any) {
      skipped.push(`${cidr} (create failed)`);
      syncLog("error", `Failed to create subnet ${cidr}: ${err.message || "Unknown error"}`);
    }
  }

  // ── Deprecate subnets from FortiGates no longer in the device list ──
  const deprecated: string[] = [];
  if (discoveredDeviceNames.size > 0) {
    const staleSubnets = await prisma.subnet.findMany({
      where: {
        discoveredBy: integrationId,
        status: { not: "deprecated" },
        fortigateDevice: { notIn: [...discoveredDeviceNames] },
      },
    });
    for (const subnet of staleSubnets) {
      await prisma.subnet.update({
        where: { id: subnet.id },
        data: { status: "deprecated" },
      });
      deprecated.push(subnet.cidr);
    }
  }

  // ── Create FortiGate assets ──
  for (const device of result.devices) {
    try {
      // Upsert by serial number if available, otherwise create
      if (device.serial) {
        const existingAsset = await prisma.asset.findFirst({
          where: { serialNumber: device.serial },
        });
        if (existingAsset) {
          await prisma.asset.update({
            where: { id: existingAsset.id },
            data: {
              ipAddress: device.mgmtIp || existingAsset.ipAddress,
              hostname: device.hostname || existingAsset.hostname,
              model: device.model || existingAsset.model,
            },
          });
          assets.push(`${device.name} (updated)`);
          continue;
        }
      }

      await prisma.asset.create({
        data: {
          ipAddress: device.mgmtIp || null,
          hostname: device.hostname || device.name,
          serialNumber: device.serial || null,
          manufacturer: "Fortinet",
          model: device.model || "FortiGate",
          assetType: "firewall",
          status: "active",
          department: "Network Security",
          notes: `Auto-discovered from FortiManager integration`,
          tags: ["fortigate", "auto-discovered"],
        },
      });
      assets.push(device.name);
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for device ${device.name}: ${err.message || "Unknown error"}`);
    }
  }

  // ── Create reservations for interface IPs ──
  const allSubnets = await prisma.subnet.findMany();
  for (const ifaceIp of result.interfaceIps) {
    if (!ifaceIp.ipAddress) continue;

    // Find which subnet this IP belongs to
    const matchingSubnet = allSubnets.find((s) => ipInCidr(ifaceIp.ipAddress, s.cidr));
    if (!matchingSubnet) continue;

    // Check for existing active reservation on this IP
    const existingRes = await prisma.reservation.findFirst({
      where: { subnetId: matchingSubnet.id, ipAddress: ifaceIp.ipAddress, status: "active" },
    });
    if (existingRes) continue; // Don't overwrite existing reservations

    try {
      await prisma.reservation.create({
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
      reservations.push(`${ifaceIp.ipAddress} (${ifaceIp.device}/${ifaceIp.interfaceName})`);
    } catch (err: any) {
      syncLog("error", `Failed to create reservation for interface IP ${ifaceIp.ipAddress} on ${ifaceIp.device}/${ifaceIp.interfaceName}: ${err.message || "Unknown error"}`);
    }
  }

  // ── Create reservations for DHCP leases and static reservations ──
  const dhcpLeases: string[] = [];
  const dhcpReservations: string[] = [];
  if (result.dhcpEntries && result.dhcpEntries.length > 0) {
    // Refresh subnet list in case new ones were just created above
    const currentSubnets = await prisma.subnet.findMany();
    for (const entry of result.dhcpEntries) {
      if (!entry.ipAddress) continue;

      const matchingSubnet = currentSubnets.find((s) => ipInCidr(entry.ipAddress, s.cidr));
      if (!matchingSubnet) continue;

      // Check for existing active reservation on this IP
      const existingRes = await prisma.reservation.findFirst({
        where: { subnetId: matchingSubnet.id, ipAddress: entry.ipAddress, status: "active" },
      });
      if (existingRes) continue;

      const isDhcpReservation = entry.type === "dhcp-reservation";
      try {
        await prisma.reservation.create({
          data: {
            subnetId: matchingSubnet.id,
            ipAddress: entry.ipAddress,
            hostname: entry.hostname || null,
            owner: isDhcpReservation ? "dhcp-reservation" : "dhcp-lease",
            projectRef: "FortiManager Integration",
            notes: `${isDhcpReservation ? "DHCP reservation" : "DHCP lease"} on ${entry.device} (${entry.interfaceName})${entry.macAddress ? " — MAC: " + entry.macAddress : ""}`,
            status: "active",
          },
        });
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

  // ── Associate DHCP entry MACs with matching assets & cross-update ──
  if (result.dhcpEntries && result.dhcpEntries.length > 0) {
    const allAssets = await prisma.asset.findMany();
    const now = new Date().toISOString();
    for (const entry of result.dhcpEntries) {
      if (!entry.macAddress || !entry.ipAddress) continue;
      const normalized = entry.macAddress.toUpperCase().replace(/-/g, ":");

      // Match asset by MAC address, hostname, or IP
      const asset = allAssets.find(
        (a) => {
          // MAC match — check primary and all associated MACs
          if (a.macAddress && a.macAddress.toUpperCase() === normalized) return true;
          if (Array.isArray(a.macAddresses)) {
            if ((a.macAddresses as any[]).some((m: any) => m.mac === normalized)) return true;
          }
          // Hostname or IP match
          if (entry.hostname && a.hostname && a.hostname.toLowerCase() === entry.hostname.toLowerCase()) return true;
          if (a.ipAddress && a.ipAddress === entry.ipAddress) return true;
          return false;
        }
      );
      if (!asset) continue;

      // Update MAC list
      const macList: Array<{mac: string; lastSeen: string; source: string}> = Array.isArray(asset.macAddresses) ? [...(asset.macAddresses as any)] : [];
      const existingMac = macList.find((m) => m.mac === normalized);
      if (existingMac) {
        existingMac.lastSeen = now;
        existingMac.source = entry.type;
      } else {
        macList.push({ mac: normalized, lastSeen: now, source: entry.type });
      }
      macList.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());

      try {
        // Update asset: MAC list + IP address from DHCP entry
        await prisma.asset.update({
          where: { id: asset.id },
          data: {
            macAddress: macList[0].mac,
            macAddresses: macList,
            ipAddress: entry.ipAddress,
          },
        });

        // Update the reservation hostname to match the asset's hostname
        if (asset.hostname) {
          const matchingSubnet = currentSubnets.find((s) => ipInCidr(entry.ipAddress, s.cidr));
          if (matchingSubnet) {
            const res = await prisma.reservation.findFirst({
              where: { subnetId: matchingSubnet.id, ipAddress: entry.ipAddress, status: "active" },
            });
            if (res && res.hostname !== asset.hostname) {
              await prisma.reservation.update({
                where: { id: res.id },
                data: { hostname: asset.hostname },
              });
            }
          }
        }
      } catch (err: any) {
        syncLog("error", `Failed to update asset MAC/IP for ${entry.macAddress} (${entry.ipAddress}): ${err.message || "Unknown error"}`);
      }
    }
  }

  // ── Process device inventory — fill in gaps not covered by DHCP ──
  const inventoryAssets: string[] = [];
  if (result.deviceInventory && result.deviceInventory.length > 0) {
    // Collect MACs already handled by DHCP entries so we can skip them
    const dhcpMacs = new Set<string>();
    if (result.dhcpEntries) {
      for (const e of result.dhcpEntries) {
        if (e.macAddress) dhcpMacs.add(e.macAddress.toUpperCase().replace(/-/g, ":"));
      }
    }

    const now = new Date().toISOString();
    // Refresh asset list to include anything created during this sync
    const refreshedAssets = await prisma.asset.findMany();

    for (const inv of result.deviceInventory) {
      if (!inv.macAddress && !inv.ipAddress) continue;
      const normalizedMac = inv.macAddress ? inv.macAddress.toUpperCase().replace(/-/g, ":") : "";

      // DHCP takes precedence — if this MAC was in DHCP entries, only update supplemental fields
      const handledByDhcp = normalizedMac && dhcpMacs.has(normalizedMac);

      // Find existing asset by MAC, hostname, or IP
      const existingAsset = refreshedAssets.find((a) => {
        if (normalizedMac) {
          if (a.macAddress && a.macAddress.toUpperCase() === normalizedMac) return true;
          if (Array.isArray(a.macAddresses) && (a.macAddresses as any[]).some((m: any) => m.mac === normalizedMac)) return true;
        }
        if (inv.hostname && a.hostname && a.hostname.toLowerCase() === inv.hostname.toLowerCase()) return true;
        if (inv.ipAddress && a.ipAddress && a.ipAddress === inv.ipAddress) return true;
        return false;
      });

      // Build connection strings
      const switchConn = inv.switchName
        ? (inv.switchPort ? `${inv.switchName}/port${inv.switchPort}` : inv.switchName)
        : null;
      const apConn = inv.apName || null;

      if (existingAsset) {
        // Update existing asset — DHCP-set fields (IP, MAC) not overwritten if already handled
        const updateData: Record<string, unknown> = {};
        if (!handledByDhcp && inv.ipAddress && inv.ipAddress !== existingAsset.ipAddress) {
          updateData.ipAddress = inv.ipAddress;
        }
        if (inv.os && !existingAsset.os) updateData.os = inv.os;
        if (inv.osVersion) updateData.osVersion = inv.osVersion;
        if (inv.hardwareVendor && !existingAsset.manufacturer) updateData.manufacturer = inv.hardwareVendor;
        if (switchConn) updateData.lastSeenSwitch = switchConn;
        if (apConn) updateData.lastSeenAp = apConn;

        // Add user if reported by inventory
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

        // Add MAC if not already tracked
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
        } else if (normalizedMac && handledByDhcp) {
          // Still update switch/AP even when DHCP handled the IP/MAC
        }

        if (Object.keys(updateData).length > 0) {
          try {
            await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
            inventoryAssets.push(`${existingAsset.hostname || normalizedMac} (updated)`);
          } catch (err: any) {
            syncLog("error", `Failed to update inventory asset ${existingAsset.hostname || normalizedMac}: ${err.message || "Unknown error"}`);
          }
        }
      } else {
        // Create new asset from device inventory
        try {
          const userList: Array<{user: string; domain?: string; lastSeen: string; source: string}> = [];
          if (inv.user) {
            const parts = inv.user.includes("\\") ? inv.user.split("\\") : [null, inv.user];
            userList.push({ user: parts[1] || inv.user, domain: parts[0] || undefined, lastSeen: now, source: "device-inventory" });
          }
          const newAsset = await prisma.asset.create({
            data: {
              ipAddress: inv.ipAddress || null,
              macAddress: normalizedMac || null,
              macAddresses: normalizedMac ? [{ mac: normalizedMac, lastSeen: now, source: "device-inventory" }] : [],
              hostname: inv.hostname || null,
              manufacturer: inv.hardwareVendor || null,
              assetType: "other",
              status: "active",
              os: inv.os || null,
              osVersion: inv.osVersion || null,
              lastSeenSwitch: switchConn,
              lastSeenAp: apConn,
              associatedUsers: userList,
              notes: `Auto-discovered from FortiGate device inventory (${inv.device})`,
              tags: ["device-inventory", "auto-discovered"],
            },
          });
          refreshedAssets.push(newAsset);
          inventoryAssets.push(inv.hostname || normalizedMac || inv.ipAddress);
        } catch (err: any) {
          syncLog("error", `Failed to create inventory asset ${inv.hostname || normalizedMac || inv.ipAddress}: ${err.message || "Unknown error"}`);
        }
      }
    }
  }

  return { created, updated, skipped, deprecated, assets, reservations, dhcpLeases: dhcpLeases.length, dhcpReservations: dhcpReservations.length, inventoryDevices: inventoryAssets.length };
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

export default router;
