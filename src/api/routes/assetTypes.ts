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
import {
  MATCH_FIELDS,
  MATCH_OPS,
  MATCH_CONTEXTS,
  AUTHORITATIVE_TYPE_SOURCES,
} from "../../utils/assetTypeMatch.js";
import { requirePermission } from "../middleware/permissions.js";
import { logEvent } from "./events.js";

const router = Router();

// Shape only. The semantic rules — regex compiles, clause count, value
// length — live in `utils/assetTypeMatch.validateMatchRules`, because the
// service is also reached by the seed path and by preview, and a rule that
// only the route rejected would still be storable.
const ClauseSchema = z.object({
  field:  z.enum(MATCH_FIELDS),
  op:     z.enum(MATCH_OPS),
  value:  z.string().min(1).max(200),
  negate: z.boolean().optional(),
});
const MatchRulesSchema = z.object({ clauses: z.array(ClauseSchema).max(64) }).nullable();
const MatchContextsSchema = z.array(z.enum(MATCH_CONTEXTS)).max(MATCH_CONTEXTS.length);
const MatchPrioritySchema = z.number().int().min(0).max(1000);

const CreateSchema = z.object({
  name:          z.string().min(2).max(32),
  label:         z.string().min(1).max(64),
  description:   z.string().max(500).nullable().optional(),
  matchRules:    MatchRulesSchema.optional(),
  matchContexts: MatchContextsSchema.optional(),
  matchPriority: MatchPrioritySchema.optional(),
});

const UpdateSchema = z.object({
  name:          z.string().min(2).max(32).optional(),
  label:         z.string().min(1).max(64).optional(),
  description:   z.string().max(500).nullable().optional(),
  matchRules:    MatchRulesSchema.optional(),
  matchContexts: MatchContextsSchema.optional(),
  matchPriority: MatchPrioritySchema.optional(),
});

const PreviewSchema = z.object({
  name:          z.string().min(1).max(32),
  matchRules:    MatchRulesSchema,
  matchContexts: MatchContextsSchema,
  matchPriority: MatchPrioritySchema,
}).optional();

// ─── Reads ─────────────────────────────────────────────────────────────────

router.get("/", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const withUsage = req.query.withUsage === "1" || req.query.withUsage === "true";
    res.json({ types: await assetTypeService.listAssetTypes({ withUsage }) });
  } catch (err) { next(err); }
});

/**
 * The matching vocabulary + the paths rules cannot reach.
 *
 * Its own route, declared before `/:id`, so the Device Types card renders the
 * server's field/operator list and the authoritative-source catalogue rather
 * than each carrying a copy that drifts. Same reasoning as
 * `/assets/pin-filter-schema`.
 */
router.get("/match-schema", requirePermission("assets", "read"), (_req, res) => {
  res.json({
    fields: MATCH_FIELDS,
    ops: MATCH_OPS,
    contexts: MATCH_CONTEXTS,
    authoritativeSources: AUTHORITATIVE_TYPE_SOURCES,
  });
});

/**
 * Dry-run: which assets currently sitting in "Other" a rule set would claim.
 * Read-level — it writes nothing. An optional draft body previews an unsaved
 * edit by substituting it into the live registry.
 */
router.post("/match-preview", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const draft = PreviewSchema.parse(req.body?.draft ?? undefined);
    res.json(await assetTypeService.previewMatchRules(draft ?? undefined));
  } catch (err) { next(err); }
});

/** Re-type the assets the saved rules claim. Explicit, audited, `other`-only. */
router.post("/match-apply", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const result = await assetTypeService.applyMatchRules();
    if (result.updated > 0) {
      logEvent({
        action: "asset_type.rules_applied",
        resourceType: "asset_type",
        actor: req.session?.username,
        message: `Device-type rules re-typed ${result.updated} asset(s) out of "Other"`,
        details: { byType: result.byType },
      });
    }
    res.json(result);
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
