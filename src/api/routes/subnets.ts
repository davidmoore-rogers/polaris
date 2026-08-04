/**
 * src/api/routes/subnets.ts
 */

import { Router } from "express";
import { z } from "zod";
import * as subnetService from "../../services/subnetService.js";
import { refreshSubnet } from "../../services/subnetRefreshService.js";
import { requirePermission, requireOwnership, assertOwnership } from "../middleware/permissions.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const CreateSubnetSchema = z.object({
  blockId:     z.string().uuid(),
  cidr:        z.string().min(1, "CIDR is required"),
  name:        z.string().min(1, "Subnet name is required"),
  purpose:     z.string().optional(),          // description / what it's for
  vlan:        z.number().int().min(1).max(4094).optional(),
  tags:        z.array(z.string()).optional(),
});

const AllocateNextSchema = z.object({
  blockId:      z.string().uuid(),
  prefixLength: z.number().int().min(8).max(32),
  name:         z.string().min(1, "Subnet name is required"),
  purpose:      z.string().optional(),
  vlan:         z.number().int().min(1).max(4094).optional(),
  tags:         z.array(z.string()).optional(),
});

const BulkEntrySchema = z.object({
  skip:         z.boolean().optional(),
  name:         z.string().optional(),
  prefixLength: z.number().int().min(8).max(32),
  vlan:         z.number().int().min(1).max(4094).nullable().optional(),
}).refine((e) => e.skip === true || (typeof e.name === "string" && e.name.trim().length > 0), {
  message: "Each entry needs a name unless it is marked as a skip row",
});

const BulkAllocateSchema = z.object({
  blockId: z.string().uuid(),
  prefix:  z.string().min(1, "Site/prefix name is required"),
  entries: z.array(BulkEntrySchema).min(1, "At least one entry is required"),
  tags:         z.array(z.string()).optional(),
  anchorPrefix: z.number().int().min(8).max(32).optional(),
});

const UpdateSubnetSchema = z.object({
  name:    z.string().min(1, "Name is required").optional(),
  purpose: z.string().optional(),
  status:  z.enum(["available", "reserved", "deprecated"]).optional(),
  vlan:    z.number().int().min(1).max(4094).nullable().optional(),
  tags:    z.array(z.string()).optional(),
  convertToManual: z.boolean().optional(),
  mergeIntegration: z.boolean().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /subnets?blockId=&status=&tag=&limit=&offset=
router.get("/", requirePermission("subnets", "read"), async (req, res, next) => {
  try {
    const { blockId, status, tag, createdBy } = req.query as Record<string, string>;
    const limit = parseInt(req.query.limit as string, 10) || undefined;
    const offset = parseInt(req.query.offset as string, 10) || undefined;
    const resolvedCreatedBy = createdBy === "me" ? (req.session?.username ?? undefined) : (createdBy || undefined);
    res.json(await subnetService.listSubnets({ blockId, status: status as any, tag, createdBy: resolvedCreatedBy, limit, offset }));
  } catch (err) {
    next(err);
  }
});

// POST /subnets/next-available  (must come before /:id)
router.post("/next-available", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const { blockId, prefixLength, ...metadata } = AllocateNextSchema.parse(req.body);
    const subnet = await subnetService.allocateNextSubnet(blockId, prefixLength, {
      ...metadata,
      createdBy: req.session?.username ?? undefined,
      actor: req.session?.username,
    });
    res.status(201).json(subnet);
  } catch (err) {
    next(err);
  }
});

// POST /subnets/bulk-allocate/preview  (must come before /:id)
// Lenient about missing names so the UI can show running totals while the
// user is still filling rows; the mutating /bulk-allocate endpoint enforces
// names via BulkEntrySchema.
const PreviewEntrySchema = z.object({
  skip:         z.boolean().optional(),
  name:         z.string().optional(),
  prefixLength: z.number().int().min(8).max(32),
  vlan:         z.number().int().min(1).max(4094).nullable().optional(),
});
router.post("/bulk-allocate/preview", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const schema = z.object({
      blockId:      z.string().uuid(),
      entries:      z.array(PreviewEntrySchema),
      anchorPrefix: z.number().int().min(8).max(32).optional(),
    });
    const input = schema.parse(req.body);
    res.json(await subnetService.previewBulkAllocate(input));
  } catch (err) {
    next(err);
  }
});

// POST /subnets/bulk-allocate  (must come before /:id)
router.post("/bulk-allocate", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const input = BulkAllocateSchema.parse(req.body);
    const result = await subnetService.bulkAllocate({
      ...input,
      createdBy: req.session?.username ?? undefined,
      actor: req.session?.username,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /subnets/:id/refresh — Per-subnet "refresh from device" action used by
// the IP panel's Refresh button. Queries the originating FortiGate for ONE
// DHCP scope (CMDB reservations + live leases), reconciles against Polaris's
// reservation rows for the same subnet, and bumps subnet.lastDiscoveredAt.
// Requires user-or-above so the same role that can reserve IPs can also kick
// a per-subnet refresh; full-fleet discovery still requires networkadmin via
// /integrations/:id/discover.
router.post("/:id/refresh", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const result = await refreshSubnet(id, req.session?.username ?? null);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /subnets/:id/ips?page=&pageSize=
router.get("/:id/ips", requirePermission("subnets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const pageSize = Math.min(65536, Math.max(1, parseInt(req.query.pageSize as string, 10) || 256));
    res.json(await subnetService.getSubnetIps(id, page, pageSize));
  } catch (err) {
    next(err);
  }
});

// GET /subnets/:id
router.get("/:id", requirePermission("subnets", "read"), async (req, res, next) => {
  try {
    res.json(await subnetService.getSubnet(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// POST /subnets
router.post("/", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const input = CreateSubnetSchema.parse(req.body);
    const subnet = await subnetService.createSubnet({
      ...input,
      createdBy: req.session?.username ?? undefined,
      actor: req.session?.username,
    });
    res.status(201).json(subnet);
  } catch (err) {
    next(err);
  }
});

// PUT /subnets/:id
router.put("/:id", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = UpdateSubnetSchema.parse(req.body);
    const before = await subnetService.getSubnet(id);
    assertOwnership(req, before.createdBy, "edit networks");
    const subnet = await subnetService.updateSubnet(id, {
      ...input,
      vlan: input.vlan ?? undefined,
      actor: req.session?.username,
    });
    res.json(subnet);
  } catch (err) {
    next(err);
  }
});

// DELETE /subnets/:id
router.delete("/:id", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    if (req.permissionLevel !== "fullwrite") {
      const existing = await subnetService.getSubnet(id);
      assertOwnership(req, existing.createdBy, "delete networks");
    }
    await subnetService.deleteSubnet(id, req.session?.username);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
