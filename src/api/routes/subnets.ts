/**
 * src/api/routes/subnets.ts
 */

import { Router } from "express";
import { z } from "zod";
import * as subnetService from "../../services/subnetService.js";
import { requireNetworkAdmin } from "../middleware/auth.js";
import { logEvent, buildChanges } from "./events.js";

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

const BulkAllocateSchema = z.object({
  blockId: z.string().uuid(),
  prefix:  z.string().min(1, "Site/prefix name is required"),
  entries: z.array(
    z.object({
      name:         z.string().min(1, "Entry name is required"),
      prefixLength: z.number().int().min(8).max(32),
      vlan:         z.number().int().min(1).max(4094).nullable().optional(),
    })
  ).min(1, "At least one entry is required"),
  tags:    z.array(z.string()).optional(),
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
router.get("/", async (req, res, next) => {
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
router.post("/next-available", requireNetworkAdmin, async (req, res, next) => {
  try {
    const { blockId, prefixLength, ...metadata } = AllocateNextSchema.parse(req.body);
    const subnet = await subnetService.allocateNextSubnet(blockId, prefixLength, { ...metadata, createdBy: req.session?.username ?? undefined });
    logEvent({ action: "subnet.created", resourceType: "subnet", resourceId: subnet.id, resourceName: metadata.name, actor: req.session?.username, message: `Subnet "${metadata.name}" (${subnet.cidr}) auto-allocated` });
    res.status(201).json(subnet);
  } catch (err) {
    next(err);
  }
});

// POST /subnets/bulk-allocate  (must come before /:id)
router.post("/bulk-allocate", requireNetworkAdmin, async (req, res, next) => {
  try {
    const input = BulkAllocateSchema.parse(req.body);
    const result = await subnetService.bulkAllocate({ ...input, createdBy: req.session?.username ?? undefined });
    if (result.created.length > 0) {
      const cidrs = result.created.map((s) => s.cidr).join(", ");
      logEvent({
        action: "subnet.bulk-allocated",
        resourceType: "subnet",
        actor: req.session?.username,
        message: `Bulk-allocated ${result.created.length} subnet(s) with prefix "${input.prefix}": ${cidrs}`,
        details: { created: result.created, failed: result.failed },
      });
    }
    res.status(result.failed.length > 0 && result.created.length === 0 ? 409 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /subnets/:id/ips?page=&pageSize=
router.get("/:id/ips", async (req, res, next) => {
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
router.get("/:id", async (req, res, next) => {
  try {
    res.json(await subnetService.getSubnet(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// POST /subnets
router.post("/", requireNetworkAdmin, async (req, res, next) => {
  try {
    const input = CreateSubnetSchema.parse(req.body);
    const subnet = await subnetService.createSubnet({ ...input, createdBy: req.session?.username ?? undefined });
    logEvent({ action: "subnet.created", resourceType: "subnet", resourceId: subnet.id, resourceName: input.name, actor: req.session?.username, message: `Subnet "${input.name}" (${input.cidr}) created` });
    res.status(201).json(subnet);
  } catch (err) {
    next(err);
  }
});

// PUT /subnets/:id
router.put("/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = UpdateSubnetSchema.parse(req.body);
    const before = await subnetService.getSubnet(id);
    const subnet = await subnetService.updateSubnet(id, { ...input, vlan: input.vlan ?? undefined });
    const changes = buildChanges(
      { name: before.name, purpose: before.purpose, status: before.status, vlan: before.vlan, tags: before.tags },
      { name: subnet.name, purpose: subnet.purpose, status: subnet.status, vlan: subnet.vlan, tags: subnet.tags },
    );
    logEvent({ action: "subnet.updated", resourceType: "subnet", resourceId: id, resourceName: input.name || subnet.name, actor: req.session?.username, message: `Subnet "${input.name || subnet.name}" updated`, details: changes ? { changes } : undefined });
    res.json(subnet);
  } catch (err) {
    next(err);
  }
});

// DELETE /subnets/:id
router.delete("/:id", requireNetworkAdmin, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const result = await subnetService.deleteSubnet(id);
    const resCount = result.deletedReservations.length;
    const message = resCount > 0
      ? `Subnet "${result.name}" (${result.cidr}) deleted with ${resCount} reservation(s)`
      : `Subnet "${result.name}" (${result.cidr}) deleted`;
    logEvent({
      action: "subnet.deleted",
      resourceType: "subnet",
      resourceId: id,
      resourceName: result.name,
      actor: req.session?.username,
      message,
      details: resCount > 0 ? { deletedReservations: result.deletedReservations } : undefined,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
