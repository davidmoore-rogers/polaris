/**
 * src/api/routes/conflicts.ts — Discovery conflict review and resolution
 *
 * Thin route layer: role-based visibility + resolve gating live here; the
 * resolution engine (accept/reject/merge for both entityType variants,
 * including the ip-override flavour and the ghost-absorb transaction) lives
 * in src/services/conflictResolutionService.ts — see its header for the
 * conflict-variant semantics.
 *
 * Role-based access:
 *   admin         — all conflicts
 *   networkadmin  — reservation conflicts only
 *   assetsadmin   — asset conflicts only
 *   others        — no access (empty list, 403 on resolve)
 */

import { Router, type Request } from "express";
import { AppError } from "../../utils/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { hasPermission } from "../middleware/permissions.js";
import {
  listConflicts,
  countPendingConflicts,
  loadPendingConflict,
  acceptConflict,
  mergeAssetConflict,
  rejectConflict,
} from "../../services/conflictResolutionService.js";

const router = Router();
router.use(requireAuth);

// Per-entity-type visibility. Built-in non-admin roles keep the historical
// split (networkadmin sees reservation conflicts; assetsadmin sees asset
// conflicts). Custom roles with discoveryConflicts permission see both
// types — admins who create a custom role can scope to a single entity
// type via the matrix description if they want, since the role-name
// partition only applies to the two seeded built-ins.
function visibleEntityTypes(req: Request): ("reservation" | "asset")[] {
  if (!hasPermission(req, "discoveryConflicts", "read")) return [];
  const roleName = req.session?.role;
  if (roleName === "networkadmin") return ["reservation"];
  if (roleName === "assetsadmin") return ["asset"];
  return ["reservation", "asset"];
}

function canResolve(req: Request, entityType: string): boolean {
  if (!hasPermission(req, "discoveryConflicts", "write")) return false;
  const roleName = req.session?.role;
  if (roleName === "networkadmin") return entityType === "reservation";
  if (roleName === "assetsadmin") return entityType === "asset";
  return true;
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
    if (!canResolve(req, conflict.entityType)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    await acceptConflict(conflict, req.session?.username);

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
    if (!canResolve(req, conflict.entityType)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    const raw = (req.body && req.body.fieldWinners) || {};
    const fieldWinners: Record<string, "existing" | "proposed"> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === "existing" || v === "proposed") fieldWinners[k] = v;
    }

    await mergeAssetConflict(conflict, req.session?.username, fieldWinners);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/reject
router.post("/:id/reject", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req, conflict.entityType)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    await rejectConflict(conflict, req.session?.username);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
