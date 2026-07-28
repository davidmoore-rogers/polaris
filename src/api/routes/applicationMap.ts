/**
 * src/api/routes/applicationMap.ts
 *
 * The Application Map page's API: the connectivity graph built from mapped-
 * process connection facts (AssetProcessConnection), the shared drag layout
 * (ApplicationMapLayout — the appmap counterpart of TopologyLayout), and the
 * Discovery surface (fleet-wide process/service aggregate + the persistent
 * auto-map selection).
 *
 * Gates: `applicationMap=read` to view the graph, `applicationMap=write`
 * to save/reset the shared layout. The Discovery WRITES additionally require
 * `assets=write`, because what they change is per-asset pin arrays
 * (Asset.mappedProcesses / mappedServices) — the same fields the assets PUT
 * guards. The per-asset connections read used by the process detail panel lives
 * on /assets/:id/process-connections (assets=read) — it's asset detail, not the map.
 */

import { Router } from "express";
import { z } from "zod";
import {
  buildApplicationMapGraph,
  saveAppMapLayout,
  deleteAppMapLayout,
} from "../../services/applicationMapService.js";
import {
  getFleetProcessAggregate,
  getFleetServiceAggregate,
  getSelection,
  saveSelection,
  normalizeSelection,
  previewAutoMap,
  applyAutoMap,
  unmapEverywhere,
} from "../../services/appMapDiscoveryService.js";
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

// ─── Discovery: fleet aggregate + persistent auto-map selection ─────────────
//
// Mounted BEFORE nothing in particular (no conflicting param routes here), but
// note the write gates are chained: `applicationMap=write` says "you may curate
// this map", `assets=write` says "you may change asset pin fields". Both are
// required because the write does both.
const requireDiscoveryWrite = [
  requirePermission("applicationMap", "write"),
  requirePermission("assets", "write"),
];

// GET /application-map/discovery — everything the modal needs in one round-trip.
router.get("/discovery", requirePermission("applicationMap", "read"), async (_req, res, next) => {
  try {
    const [processes, services, selection] = await Promise.all([
      getFleetProcessAggregate(),
      getFleetServiceAggregate(),
      getSelection(),
    ]);
    res.json({ processes, services, selection });
  } catch (err) {
    next(err);
  }
});

// POST /application-map/discovery/preview — dry run; writes nothing. Read-gated
// because it only reports what a selection WOULD pin.
router.post("/discovery/preview", requirePermission("applicationMap", "read"), async (req, res, next) => {
  try {
    const selection = normalizeSelection((req.body ?? {}).selection);
    res.json(await previewAutoMap(selection));
  } catch (err) {
    next(err);
  }
});

// PUT /application-map/discovery — persist the selection and apply it inline, so
// the operator sees pins land immediately instead of waiting for the reconcile
// tick. The tick is what covers assets discovered later.
router.put("/discovery", ...requireDiscoveryWrite, async (req, res, next) => {
  try {
    const selection = normalizeSelection((req.body ?? {}).selection);
    await saveSelection(selection);
    const actor = requestActor(req);
    logEvent({
      action: "application_map.automap.saved",
      resourceType: "application_map",
      resourceId: "discovery",
      actor,
      message:
        `Application Map auto-map selection saved ` +
        `(${selection.processes.names.length} processes, ${selection.services.names.length} services` +
        `${selection.scope ? ", scoped" : ""})`,
      details: { selection } as any,
    });
    const applied = await applyAutoMap(selection);
    if (applied.devices > 0) {
      logEvent({
        action: "application_map.automap.applied",
        resourceType: "application_map",
        resourceId: "discovery",
        actor,
        message:
          `Auto-map pinned ${applied.processPins} process(es) + ${applied.servicePins} service(s) ` +
          `across ${applied.devices} device(s)`,
        details: applied as any,
      });
    }
    res.json({ selection, applied });
  } catch (err) {
    next(err);
  }
});

const UnmapSchema = z.object({
  kind: z.enum(["process", "service"]),
  name: z.string().min(1).max(256),
});

// POST /application-map/discovery/unmap — the explicit subtractive action. Apply
// is additive by design, so removing something from every host has to be asked
// for separately.
router.post("/discovery/unmap", ...requireDiscoveryWrite, async (req, res, next) => {
  try {
    const input = UnmapSchema.parse(req.body ?? {});
    const result = await unmapEverywhere(input.kind, input.name);
    logEvent({
      action: "application_map.automap.unmapped",
      resourceType: "application_map",
      resourceId: "discovery",
      actor: requestActor(req),
      message:
        `Un-mapped ${input.kind} "${input.name}" from ${result.devices} device(s) ` +
        `(${result.connectionRowsDeleted} connection row(s) deleted)`,
      details: { ...result, kind: input.kind, name: input.name } as any,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
