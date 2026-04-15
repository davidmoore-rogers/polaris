/**
 * src/api/routes/blocks.ts
 */

import { Router } from "express";
import { z } from "zod";
import * as blockService from "../../services/blockService.js";

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

router.post("/", async (req, res, next) => {
  try {
    const input = CreateBlockSchema.parse(req.body);
    res.status(201).json(await blockService.createBlock(input));
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const input = UpdateBlockSchema.parse(req.body);
    res.json(await blockService.updateBlock(req.params.id, input));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await blockService.deleteBlock(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
