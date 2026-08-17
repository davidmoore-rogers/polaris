/**
 * src/api/routes/mapRegions.ts
 *
 * CRUD for operator-drawn map regions. /map/regions is mounted with the
 * `mapRegions=read` gate (router.ts), so any role with mapRegions read or
 * higher can list them; per-route writes below escalate to mapRegions=write.
 * The read-time access exists so callers that need to *consume* the region
 * registry (e.g. the user/role region-tag picker) can do so without holding
 * the write capability.
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
router.get("/", async (_req, res, next) => {
  try {
    res.json(await service.listRegions());
  } catch (err) {
    next(err);
  }
});

// POST /map/regions
router.post("/", requirePermission("mapRegions", "write"), async (req, res, next) => {
  try {
    const input = CreateRegionSchema.parse(req.body);
    const created = await service.createRegion({
      name: input.name,
      polygon: input.polygon,
      color: input.color,
      actor: req.session?.username ?? null,
    });
    const summary = await service.applyOneRegion(created);
    logEvent({
      action: "region.created",
      resourceType: "map-region",
      resourceId: created.id,
      resourceName: created.name,
      actor: req.session?.username,
      message:
        `Map region "${created.name}" created (${summary.added} asset${summary.added === 1 ? "" : "s"}, ` +
        `${summary.subnetsAdded} network${summary.subnetsAdded === 1 ? "" : "s"} tagged)`,
      details: { vertices: created.polygon.length, added: summary.added, subnetsAdded: summary.subnetsAdded },
    });
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
        ...summary,
      },
    });
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
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
