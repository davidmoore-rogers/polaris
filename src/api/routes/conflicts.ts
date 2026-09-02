/**
 * src/api/routes/conflicts.ts — Discovery conflict review and resolution
 *
 * Thin route layer: role-based visibility + resolve gating live here; the
 * resolution engine (accept/reject/merge for both entityType variants,
 * including the ip-override flavour and the ghost-absorb transaction) lives
 * in src/services/conflictResolutionService.ts — see its header for the
 * conflict-variant semantics. The duplicate-IP flavour's own verb
 * (`/:id/reassign-ip`) delegates to src/services/duplicateIpConflictService.ts.
 *
 * Access rides the discoveryConflicts permission alone: read = list both
 * entity types, write = resolve both — with ONE exception, `/:id/reassign-ip`,
 * which additionally requires `assets:write` because it edits inventory.
 * (The historical networkadmin↔
 * reservation / assetsadmin↔asset role-NAME partition was dropped 2026-08 —
 * it silently stopped applying when the seeded roles were renamed and never
 * applied to bearer-token callers.)
 */

import { Router, type Request } from "express";
import { AppError } from "../../utils/errors.js";
import { requireAuth, requestActor } from "../middleware/auth.js";
import { hasPermission } from "../middleware/permissions.js";
import {
  listConflicts,
  countPendingConflicts,
  loadPendingConflict,
  acceptConflict,
  mergeAssetConflict,
  rejectConflict,
} from "../../services/conflictResolutionService.js";
import { reassignDuplicateIpAsset } from "../../services/duplicateIpConflictService.js";

const router = Router();
router.use(requireAuth);

function visibleEntityTypes(req: Request): ("reservation" | "asset")[] {
  if (!hasPermission(req, "discoveryConflicts", "read")) return [];
  return ["reservation", "asset"];
}

function canResolve(req: Request): boolean {
  return hasPermission(req, "discoveryConflicts", "write");
}

// GET /api/v1/conflicts — list conflicts visible to the current role
router.get("/", async (req, res, next) => {
  try {
    const status = (req.query.status as string) || "pending";
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 5000);
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const entityTypes = visibleEntityTypes(req);
    if (entityTypes.length === 0) {
      res.json({ conflicts: [], total: 0, limit, offset });
      return;
    }

    const { conflicts, total } = await listConflicts(entityTypes, status, limit, offset);

    res.json({ conflicts, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/conflicts/count — pending count for nav badge, scoped to role
router.get("/count", async (req, res, next) => {
  try {
    const entityTypes = visibleEntityTypes(req);
    if (entityTypes.length === 0) {
      res.json({ count: 0 });
      return;
    }
    const count = await countPendingConflicts(entityTypes);
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/accept
router.post("/:id/accept", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    await acceptConflict(conflict, requestActor(req));

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/merge — asset conflicts only; per-field winner
// selection. Body: { fieldWinners: { hostname: "existing"|"proposed", ... } }.
// Fields not present in fieldWinners fall back to the default accept logic
// (today's behavior — blank-fill for most, always-overwrite for os/osVersion,
// NetBIOS upgrade for hostname). Resolves the conflict the same way Accept
// does: stamps the AssetSource row, absorbs ghost assets, marks status accepted.
router.post("/:id/merge", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (conflict.entityType !== "asset") {
      throw new AppError(400, "Merge with per-field selection is only supported for asset conflicts");
    }
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    const raw = (req.body && req.body.fieldWinners) || {};
    const fieldWinners: Record<string, "existing" | "proposed"> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === "existing" || v === "proposed") fieldWinners[k] = v;
    }

    await mergeAssetConflict(conflict, requestActor(req), fieldWinners);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/reassign-ip — duplicate-IP conflicts only.
// Body: { assetId, ipAddress }. Gives ONE of the assets sharing the address a
// new one (operator-pin semantics, like editing IP Address on the asset form)
// and closes the conflict once fewer than two current claims remain.
//
// CHAINED gate — discoveryConflicts:write AND assets:write (the
// /network-scans/:id/adopt precedent): resolving conflict queue entries and
// editing device inventory are separable grants, and this verb needs both.
router.post("/:id/reassign-ip", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }
    if (!hasPermission(req, "assets", "write")) {
      throw new AppError(403, "You do not have permission to change an asset's IP address");
    }
    const assetId = typeof req.body?.assetId === "string" ? req.body.assetId : "";
    const ipAddress = typeof req.body?.ipAddress === "string" ? req.body.ipAddress : "";
    if (!assetId) throw new AppError(400, "assetId is required");

    const outcome = await reassignDuplicateIpAsset(
      conflict,
      assetId,
      ipAddress,
      requestActor(req),
    );

    res.json({ ok: true, ...outcome });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/reject
router.post("/:id/reject", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    await rejectConflict(conflict, requestActor(req));

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
