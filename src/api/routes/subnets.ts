/**
 * src/api/routes/subnets.ts
 */

import { Router } from "express";
import { z } from "zod";
import * as subnetService from "../../services/subnetService.js";
import { requireNetworkAdmin } from "../middleware/auth.js";
import { logEvent } from "./events.js";

const router = Router();

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const CreateSubnetSchema = z.object({
  blockId:     z.string().uuid(),
  cidr:        z.string().min(1),
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

const UpdateSubnetSchema = z.object({
  name:    z.string().min(1).optional(),
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
    const { blockId, status, tag } = req.query as Record<string, string>;
    const limit = parseInt(req.query.limit as string, 10) || undefined;
    const offset = parseInt(req.query.offset as string, 10) || undefined;
    res.json(await subnetService.listSubnets({ blockId, status: status as any, tag, limit, offset }));
  } catch (err) {
    next(err);
  }
});

// POST /subnets/next-available  (must come before /:id)
router.post("/next-available", requireNetworkAdmin, async (req, res, next) => {
  try {
    const { blockId, prefixLength, ...metadata } = AllocateNextSchema.parse(req.body);
    const subnet = await subnetService.allocateNextSubnet(blockId, prefixLength, metadata);
    logEvent({ action: "subnet.created", resourceType: "subnet", resourceId: subnet.id, resourceName: metadata.name, actor: (req as any).user?.username, message: `Subnet "${metadata.name}" (${subnet.cidr}) auto-allocated` });
    res.status(201).json(subnet);
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
    const subnet = await subnetService.createSubnet(input);
    logEvent({ action: "subnet.created", resourceType: "subnet", resourceId: subnet.id, resourceName: input.name, actor: (req as any).user?.username, message: `Subnet "${input.name}" (${input.cidr}) created` });
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
    const subnet = await subnetService.updateSubnet(id, { ...input, vlan: input.vlan ?? undefined });
    logEvent({ action: "subnet.updated", resourceType: "subnet", resourceId: id, resourceName: input.name || subnet.name, actor: (req as any).user?.username, message: `Subnet "${input.name || subnet.name}" updated` });
    res.json(subnet);
  } catch (err) {
    next(err);
  }
});

// DELETE /subnets/:id
router.delete("/:id", requireNetworkAdmin, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await subnetService.deleteSubnet(id);
    logEvent({ action: "subnet.deleted", resourceType: "subnet", resourceId: id, actor: (req as any).user?.username, message: `Subnet deleted` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
