/**
 * src/api/routes/mapRegions.ts
 *
 * CRUD for operator-drawn map regions. /map/regions is mounted with the
 * `mapRegions=read` gate (router.ts), so any role with mapRegions read or
 * higher can list them; per-route writes below escalate to mapRegions=write.
 * The read-time access exists so callers that need to *consume* the region
 * registry (e.g. the user/role region-tag picker) can do so without holding
 * the write capability.
 *
 * The GET serves the DECORATED projection (each region plus its derived
 * `level` / `depth` / `parentId` / `childIds` / `ancestorIds`), which is purely
 * additive for existing consumers.
 *
 * Every write additionally records what the edit did to OTHER regions' levels
 * (`region.levels_shifted`). Levels are derived from nesting, so drawing one
 * polygon around two existing regions re-levels an ancestor chain and changes
 * who alert routing reaches for regions nobody touched — see `logLevelShifts`.
 */

import { Router } from "express";
import { z } from "zod";
import * as service from "../../services/mapRegionService.js";
import { logEvent } from "./events.js";
import { requirePermission } from "../middleware/permissions.js";

const router = Router();

/**
 * One phrasing for the reconcile Event, shared by the create + update paths.
 * Region tags land on assets AND on the subnets an enclosed gate serves, so the
 * message has to name both — an edit can touch only networks.
 */
function reconcileMessage(summary: service.ReconcileSummary): string {
  const assets = `${summary.assetsTouched} asset${summary.assetsTouched === 1 ? "" : "s"}`;
  const nets = `${summary.subnetsTouched} network${summary.subnetsTouched === 1 ? "" : "s"}`;
  return (
    `Region tags reconciled: assets +${summary.added} / -${summary.removed} (${assets} touched), ` +
    `networks +${summary.subnetsAdded} / -${summary.subnetsRemoved} (${nets} touched)`
  );
}

/** The derived nesting facts for one region, for an Event's `details`. */
async function levelDetails(regionId: string): Promise<{ level: number | null; depth: number | null; parentName: string | null }> {
  const { regions, hierarchy } = await service.getRegionHierarchy();
  const node = hierarchy.byId[regionId];
  if (!node) return { level: null, depth: null, parentName: null };
  const parent = node.parentId ? regions.find((r) => r.id === node.parentId) : null;
  return { level: node.level, depth: node.depth, parentName: parent?.name ?? null };
}

/**
 * Record every OTHER region whose derived level moved because of this edit.
 *
 * This is the most operationally important line in the levels feature: drawing
 * a polygon around two existing regions promotes it and can re-level an entire
 * ancestor chain, which changes who alert routing reaches for regions the
 * operator never touched. Without this Event that change leaves no trace.
 *
 * The edited region is excluded — its own level is already reported in its
 * region.created / region.updated / region.deleted details, and repeating it
 * here would read as collateral damage from its own edit.
 */
async function logLevelShifts(
  before: import("../../utils/regionHierarchy.js").RegionHierarchy,
  editedId: string,
  actor: string | undefined,
): Promise<void> {
  const { regions, hierarchy: after } = await service.getRegionHierarchy();
  const shifts = service.diffRegionLevels(before, after).filter((s) => s.regionId !== editedId);
  if (shifts.length === 0) return;
  const nameById = new Map(regions.map((r) => [r.id, r.name]));
  const described = shifts.map((s) => ({ ...s, name: nameById.get(s.regionId) ?? null }));
  logEvent({
    action: "region.levels_shifted",
    resourceType: "map-region",
    resourceId: editedId,
    actor,
    level: "info",
    message:
      `Nesting levels changed for ${shifts.length} other region${shifts.length === 1 ? "" : "s"}: ` +
      described
        .slice(0, 5)
        .map((s) => `${s.name ?? s.regionId} L${s.from ?? "-"}→L${s.to ?? "-"}`)
        .join(", ") +
      (shifts.length > 5 ? `, +${shifts.length - 5} more` : ""),
    details: { shifts: described },
  });
}

const PolygonSchema = z
  .array(z.tuple([z.number(), z.number()]))
  .min(3, "Polygon must have at least 3 vertices")
  .max(1000, "Polygon cannot have more than 1000 vertices");

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex string like "#4fc3f7"');

const CreateRegionSchema = z.object({
  name: z.string().min(1, "Region name is required").max(64),
  polygon: PolygonSchema,
  color: HexColorSchema.optional(),
});

const UpdateRegionSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  polygon: PolygonSchema.optional(),
  color: HexColorSchema.optional(),
});

// GET /map/regions
// Serves the DECORATED projection — each region additionally carries its
// derived `level` / `depth` / `parentId` / `childIds` / `ancestorIds`. Purely
// additive, so region-pills.js (name + color) and the map's edit mode (polygons)
// are unaffected.
router.get("/", async (_req, res, next) => {
  try {
    res.json(await service.listRegionsWithLevels());
  } catch (err) {
    next(err);
  }
});

// POST /map/regions
router.post("/", requirePermission("mapRegions", "write"), async (req, res, next) => {
  try {
    const input = CreateRegionSchema.parse(req.body);
    // Captured BEFORE the write: a new polygon drawn around existing regions
    // promotes itself and re-levels everything above it.
    const { hierarchy: beforeLevels } = await service.getRegionHierarchy();
    const created = await service.createRegion({
      name: input.name,
      polygon: input.polygon,
      color: input.color,
      actor: req.session?.username ?? null,
    });
    const summary = await service.applyOneRegion(created);
    const levels = await levelDetails(created.id);
    logEvent({
      action: "region.created",
      resourceType: "map-region",
      resourceId: created.id,
      resourceName: created.name,
      actor: req.session?.username,
      message:
        `Map region "${created.name}" created at level ${levels.level ?? 1} (${summary.added} asset${summary.added === 1 ? "" : "s"}, ` +
        `${summary.subnetsAdded} network${summary.subnetsAdded === 1 ? "" : "s"} tagged)`,
      details: {
        vertices: created.polygon.length,
        added: summary.added,
        subnetsAdded: summary.subnetsAdded,
        ...levels,
      },
    });
    await logLevelShifts(beforeLevels, created.id, req.session?.username);
    if (summary.added > 0 || summary.subnetsAdded > 0) {
      logEvent({
        action: "region.tags_reconciled",
        resourceType: "map-region",
        resourceId: created.id,
        resourceName: created.name,
        message: reconcileMessage(summary),
        details: summary,
      });
    }
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// PUT /map/regions/:id
router.put("/:id", requirePermission("mapRegions", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = UpdateRegionSchema.parse(req.body);
    const { hierarchy: beforeLevels } = await service.getRegionHierarchy();
    const result = await service.updateRegion(id, input);
    let summary: service.ReconcileSummary;
    if (result.renamed) {
      summary = await service.applyRename(result.region, result.previousName);
    } else {
      summary = await service.applyOneRegion(result.region);
    }
    logEvent({
      action: "region.updated",
      resourceType: "map-region",
      resourceId: result.region.id,
      resourceName: result.region.name,
      actor: req.session?.username,
      message: result.renamed
        ? `Map region renamed "${result.previousName}" → "${result.region.name}"`
        : `Map region "${result.region.name}" updated${result.polygonChanged ? " (polygon edited)" : ""}`,
      details: {
        previousName: result.previousName,
        renamed: result.renamed,
        polygonChanged: result.polygonChanged,
        vertices: result.region.polygon.length,
        ...(await levelDetails(result.region.id)),
        ...summary,
      },
    });
    await logLevelShifts(beforeLevels, result.region.id, req.session?.username);
    if (summary.assetsTouched > 0 || summary.subnetsTouched > 0) {
      logEvent({
        action: "region.tags_reconciled",
        resourceType: "map-region",
        resourceId: result.region.id,
        resourceName: result.region.name,
        message: reconcileMessage(summary),
        details: summary,
      });
    }
    res.json(result.region);
  } catch (err) {
    next(err);
  }
});

// DELETE /map/regions/:id
router.delete("/:id", requirePermission("mapRegions", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    // Deleting a container demotes everything that was inside it.
    const { hierarchy: beforeLevels } = await service.getRegionHierarchy();
    const removed = await service.deleteRegion(id);
    const summary = await service.applyDelete(removed);
    logEvent({
      action: "region.deleted",
      resourceType: "map-region",
      resourceId: removed.id,
      resourceName: removed.name,
      actor: req.session?.username,
      message:
        `Map region "${removed.name}" deleted (${summary.removed} asset${summary.removed === 1 ? "" : "s"}, ` +
        `${summary.subnetsRemoved} network${summary.subnetsRemoved === 1 ? "" : "s"} untagged)`,
      details: summary,
    });
    await logLevelShifts(beforeLevels, removed.id, req.session?.username);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
