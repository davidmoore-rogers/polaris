/**
 * src/api/routes/groupMappings.ts — IdP group → role + tags mapping CRUD
 *
 * Gated on users=fullwrite at the mount (same privilege tier that assigns
 * roles to users); no dedicated function key. Thin wrappers over
 * groupMappingService — all validation + Events live there.
 */

import { Router } from "express";
import { z } from "zod";
import * as groupMappingService from "../../services/groupMappingService.js";
import { GROUP_MAPPING_PROVIDERS } from "../../services/groupMappingService.js";

const router = Router();

const TagsSchema = z.array(z.string().max(64)).max(64);
const ProviderSchema = z.enum(GROUP_MAPPING_PROVIDERS as unknown as [string, ...string[]]);

const CreateSchema = z.object({
  provider: ProviderSchema,
  groupKey: z.string().min(1).max(512),
  roleId: z.string().uuid().optional().nullable(),
  regionTags: TagsSchema.optional(),
  otherTags: TagsSchema.optional(),
  enabled: z.boolean().optional(),
  description: z.string().max(200).optional().nullable(),
});

const UpdateSchema = z.object({
  groupKey: z.string().min(1).max(512).optional(),
  roleId: z.string().uuid().optional().nullable(),
  regionTags: TagsSchema.optional(),
  otherTags: TagsSchema.optional(),
  enabled: z.boolean().optional(),
  description: z.string().max(200).optional().nullable(),
});

const ListQuerySchema = z.object({ provider: ProviderSchema.optional() });

router.get("/", async (req, res, next) => {
  try {
    const { provider } = ListQuerySchema.parse(req.query);
    res.json(await groupMappingService.listGroupMappings(provider));
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await groupMappingService.getGroupMapping(req.params.id as string));
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const input = CreateSchema.parse(req.body);
    const created = await groupMappingService.createGroupMapping(input, req.session?.username);
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.put("/:id", async (req, res, next) => {
  try {
    const input = UpdateSchema.parse(req.body);
    const updated = await groupMappingService.updateGroupMapping(req.params.id as string, input, req.session?.username);
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await groupMappingService.deleteGroupMapping(req.params.id as string, req.session?.username);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
