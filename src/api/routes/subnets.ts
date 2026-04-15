/**
 * src/api/routes/subnets.ts
 */

import { Router } from "express";
import { z } from "zod";
import * as subnetService from "../../services/subnetService.js";

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
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /subnets?blockId=&status=&tag=
router.get("/", async (req, res, next) => {
  try {
    const { blockId, status, tag } = req.query as Record<string, string>;
    res.json(await subnetService.listSubnets({ blockId, status: status as any, tag }));
  } catch (err) {
    next(err);
  }
});

// POST /subnets/next-available  (must come before /:id)
router.post("/next-available", async (req, res, next) => {
  try {
    const { blockId, prefixLength, ...metadata } = AllocateNextSchema.parse(req.body);
    const subnet = await subnetService.allocateNextSubnet(blockId, prefixLength, metadata);
    res.status(201).json(subnet);
  } catch (err) {
    next(err);
  }
});

// GET /subnets/:id
router.get("/:id", async (req, res, next) => {
  try {
    res.json(await subnetService.getSubnet(req.params.id));
  } catch (err) {
    next(err);
  }
});

// POST /subnets
router.post("/", async (req, res, next) => {
  try {
    const input = CreateSubnetSchema.parse(req.body);
    const subnet = await subnetService.createSubnet(input);
    res.status(201).json(subnet);
  } catch (err) {
    next(err);
  }
});

// PUT /subnets/:id
router.put("/:id", async (req, res, next) => {
  try {
    const input = UpdateSubnetSchema.parse(req.body);
    res.json(await subnetService.updateSubnet(req.params.id, input));
  } catch (err) {
    next(err);
  }
});

// DELETE /subnets/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await subnetService.deleteSubnet(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
