/**
 * src/api/routes/applicationMap.ts
 *
 * The Application Map page's API: the connectivity graph built from mapped-
 * process connection facts (AssetProcessConnection) plus the shared drag
 * layout (ApplicationMapLayout — the appmap counterpart of TopologyLayout).
 *
 * Gates: `applicationMap=read` to view the graph, `applicationMap=write`
 * to save/reset the shared layout. The per-asset connections read used by
 * the process detail panel lives on /assets/:id/process-connections
 * (assets=read) — it's asset detail, not the map.
 */

import { Router } from "express";
import { z } from "zod";
import {
  buildApplicationMapGraph,
  saveAppMapLayout,
  deleteAppMapLayout,
} from "../../services/applicationMapService.js";
import { logEvent } from "./events.js";
import { requirePermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";

const router = Router();

// GET /application-map — the full graph payload (nodes, edges, savedLayout, stats).
router.get("/", requirePermission("applicationMap", "read"), async (_req, res, next) => {
  try {
    res.json(await buildApplicationMapGraph());
  } catch (err) {
    next(err);
  }
});

const LayoutPutSchema = z.object({
  view: z.string().min(1).max(64).default("global"),
  // Shape-validated by sanitizePositions inside the service (same validator
  // as the Device Map topology layout).
  positions: z.unknown(),
});

// PUT /application-map/layout — full-replace the shared layout (last-write-wins).
router.put("/layout", requirePermission("applicationMap", "write"), async (req, res, next) => {
  try {
    const input = LayoutPutSchema.parse(req.body ?? {});
    const dto = await saveAppMapLayout(input.view, input.positions, requestActor(req) ?? null);
    logEvent({
      action: "application_map.layout.saved",
      resourceType: "application_map",
      resourceId: dto.view,
      actor: requestActor(req),
      message: `Application Map layout "${dto.view}" saved (${Object.keys(dto.positions).length} nodes)`,
    });
    res.json(dto);
  } catch (err) {
    next(err);
  }
});

// DELETE /application-map/layout?view=global — reset to the computed layout.
router.delete("/layout", requirePermission("applicationMap", "write"), async (req, res, next) => {
  try {
    const view = typeof req.query.view === "string" && req.query.view ? req.query.view : "global";
    const removed = await deleteAppMapLayout(view);
    if (removed) {
      logEvent({
        action: "application_map.layout.reset",
        resourceType: "application_map",
        resourceId: view,
        actor: requestActor(req),
        message: `Application Map layout "${view}" reset`,
      });
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
