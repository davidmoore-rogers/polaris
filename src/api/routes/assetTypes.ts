/**
 * src/api/routes/assetTypes.ts
 *
 * CRUD for the operator-extensible AssetTypeDef registry. The eight
 * historical AssetType enum values are seeded as `isBuiltIn=true,
 * isProtected=true` rows by the registry-cutover migration and cannot be
 * renamed or deleted. Custom rows can be created / edited / deleted by
 * anyone holding `assets=write` (admin + assetsadmin in the default role
 * matrix). Read is open to any caller with `assets=read`.
 *
 * Custom types live in the same string column as built-ins (Asset.assetType
 * is a free-form TEXT validated against the registry at write time). Code
 * that special-cases the eight built-ins (dependency tree, fortinetTopology,
 * polling source defaults, topology rendering, inferAssetTypeFromOs) only
 * fires for the seeded names — custom types fall through to "other"-like
 * generic behavior by design.
 */

import { Router } from "express";
import { z } from "zod";
import * as assetTypeService from "../../services/assetTypeService.js";
import { requirePermission } from "../middleware/permissions.js";
import { logEvent } from "./events.js";

const router = Router();

const CreateSchema = z.object({
  name:        z.string().min(2).max(32),
  label:       z.string().min(1).max(64),
  description: z.string().max(500).nullable().optional(),
});

const UpdateSchema = z.object({
  name:        z.string().min(2).max(32).optional(),
  label:       z.string().min(1).max(64).optional(),
  description: z.string().max(500).nullable().optional(),
});

// ─── Reads ─────────────────────────────────────────────────────────────────

router.get("/", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const withUsage = req.query.withUsage === "1" || req.query.withUsage === "true";
    res.json({ types: await assetTypeService.listAssetTypes({ withUsage }) });
  } catch (err) { next(err); }
});

router.get("/:id", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await assetTypeService.getAssetType(req.params.id as string));
  } catch (err) { next(err); }
});

// ─── Writes ────────────────────────────────────────────────────────────────

router.post("/", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const input = CreateSchema.parse(req.body);
    const saved = await assetTypeService.createAssetType({
      ...input,
      createdBy: req.session?.username ?? null,
    });
    logEvent({
      action: "asset_type.created",
      resourceType: "asset_type",
      resourceId: saved.id,
      resourceName: saved.name,
      actor: req.session?.username,
      message: `Asset type "${saved.label}" (${saved.name}) created`,
    });
    res.status(201).json(saved);
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const input = UpdateSchema.parse(req.body);
    const saved = await assetTypeService.updateAssetType(req.params.id as string, input);
    logEvent({
      action: "asset_type.updated",
      resourceType: "asset_type",
      resourceId: saved.id,
      resourceName: saved.name,
      actor: req.session?.username,
      message: `Asset type "${saved.label}" (${saved.name}) updated`,
    });
    res.json(saved);
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const before = await assetTypeService.getAssetType(id).catch(() => null);
    await assetTypeService.deleteAssetType(id);
    logEvent({
      action: "asset_type.deleted",
      resourceType: "asset_type",
      resourceId: id,
      resourceName: before?.name,
      actor: req.session?.username,
      message: before
        ? `Asset type "${before.label}" (${before.name}) deleted`
        : "Asset type deleted",
    });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
