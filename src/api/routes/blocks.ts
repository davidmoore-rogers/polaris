/**
 * src/api/routes/blocks.ts
 */

import { Router } from "express";
import { z } from "zod";
import * as blockService from "../../services/blockService.js";
import { requireNetworkAdmin } from "../middleware/auth.js";
import { logEvent } from "./events.js";

const router = Router();

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const CreateBlockSchema = z.object({
  name:        z.string().min(1),
  cidr:        z.string().min(1),
  description: z.string().optional(),
  tags:        z.array(z.string()).optional(),
});

const UpdateBlockSchema = z.object({
  name:        z.string().min(1).optional(),
  description: z.string().optional(),
  tags:        z.array(z.string()).optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    const { ipVersion, tag } = req.query as Record<string, string>;
    res.json(await blockService.listBlocks({ ipVersion: ipVersion as any, tag }));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await blockService.getBlock(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireNetworkAdmin, async (req, res, next) => {
  try {
    const input = CreateBlockSchema.parse(req.body);
    const block = await blockService.createBlock(input);
    logEvent({ action: "block.created", resourceType: "block", resourceId: block.id, resourceName: input.name, actor: (req as any).user?.username, message: `Block "${input.name}" (${input.cidr}) created` });
    res.status(201).json(block);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireNetworkAdmin, async (req, res, next) => {
  try {
    const input = UpdateBlockSchema.parse(req.body);
    const block = await blockService.updateBlock(req.params.id, input);
    logEvent({ action: "block.updated", resourceType: "block", resourceId: req.params.id, resourceName: input.name || block.name, actor: (req as any).user?.username, message: `Block "${input.name || block.name}" updated` });
    res.json(block);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireNetworkAdmin, async (req, res, next) => {
  try {
    await blockService.deleteBlock(req.params.id);
    logEvent({ action: "block.deleted", resourceType: "block", resourceId: req.params.id, actor: (req as any).user?.username, message: `Block deleted` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
