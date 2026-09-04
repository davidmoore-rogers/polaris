/**
 * src/api/routes/savedDashboards.ts — saved dashboards (named canvases).
 *
 * Mounted TWICE, deliberately:
 *   - /api/v1/saved-dashboards on the main router (after the global
 *     requireAuth) — the Dashboard page's "Dashboards ▾" menu.
 *   - /dash/api/v1/saved-dashboards on the Dash wallboard listener, which is
 *     GET-only app-wide and carries NO session: a wallboard can therefore load
 *     a published dashboard and can never save one, structurally rather than by
 *     a check here. Its two reads answer with PUBLIC rows only.
 *
 * The mount carries a `savedDashboards:read` floor for both, so the wallboard's
 * synthetic readonly identity is gated by the same matrix an operator's is.
 * Per route on top of that:
 *
 *   GET    /       — own + public (public only with no session)   read
 *   GET    /:id    — one, 404 (not 403) when not visible          read
 *   POST   /       — create/overwrite own by name                 read
 *                    (visibility "public" also needs             write)
 *   PUT    /:id    — edit own                                     same as POST
 *   DELETE /:id    — delete own                                   read
 *                    (someone else's needs                    fullwrite)
 *
 * Keeping a PRIVATE dashboard needs only the read level because the ungated
 * per-user /me/dashboard already lets any caller store the same layout;
 * PUBLISHING is what reaches other operators and the unauthenticated wallboard,
 * which is the write. See services/savedDashboardService.ts for the model.
 */

import { Router } from "express";
import { z } from "zod";
import type { Request } from "express";
import { AppError } from "../../utils/errors.js";
import { hasPermission, requirePermission } from "../middleware/permissions.js";
import {
  createSavedDashboard,
  deleteSavedDashboard,
  getSavedDashboard,
  listSavedDashboards,
  normalizeName,
  readSavedDashboard,
  sanitizeDashboardLayout,
  updateSavedDashboard,
  type SavedDashboardVisibility,
} from "../../services/savedDashboardService.js";
import { MAX_DASHBOARD_NAME_LEN } from "../../utils/dashboardLayout.js";

const router = Router();

const BodySchema = z.object({
  name:       z.string().min(1).max(MAX_DASHBOARD_NAME_LEN),
  visibility: z.enum(["private", "public"]),
  // Shape-validated by sanitizeDashboardLayout (the unit-tested contract);
  // Zod only guarantees it's an object here.
  layout:     z.record(z.unknown()),
});

/**
 * The signed-in user, or null on the wallboard mount. Unlike scopeAccess's
 * sessionUser this must NOT throw: a session-less caller is the whole point of
 * the dash mount, and it reads public rows.
 */
function viewer(req: Request): { id: string; username: string } | null {
  const id = req.session?.userId;
  const username = req.session?.username;
  return id && username ? { id, username } : null;
}

/** A caller that can only ever read (the wallboard) may not mutate anything. */
function requireViewer(req: Request): { id: string; username: string } {
  const user = viewer(req);
  if (!user) throw new AppError(401, "This endpoint requires a signed-in user");
  return user;
}

/**
 * Publishing to everyone (and to the wallboard) is a write to shared state;
 * keeping a private dashboard is not. Checked per request rather than at the
 * mount because the level depends on the payload's `visibility`.
 */
function assertMayPublish(req: Request, visibility: SavedDashboardVisibility): void {
  if (visibility === "public" && !hasPermission(req, "savedDashboards", "write")) {
    throw new AppError(403, "Forbidden — publishing a public dashboard requires savedDashboards:write");
  }
}

// Read floor for every route on both mounts. requirePermission refreshes the
// role snapshot, so hasPermission checks below read a fresh matrix.
router.use(requirePermission("savedDashboards", "read"));

router.get("/", async (req, res, next) => {
  try {
    const user = viewer(req);
    res.json({ dashboards: await listSavedDashboards(user ? user.id : null) });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const user = requireViewer(req);
    assertMayPublish(req, body.visibility);
    const saved = await createSavedDashboard(
      {
        name:       normalizeName(body.name),
        visibility: body.visibility as SavedDashboardVisibility,
        layout:     sanitizeDashboardLayout(body.layout),
      },
      user,
    );
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const user = requireViewer(req);
    const row = await getSavedDashboard(req.params.id);
    if (row.ownerId !== user.id) {
      throw new AppError(403, "Forbidden — you can only edit saved dashboards you created");
    }
    assertMayPublish(req, body.visibility);
    const saved = await updateSavedDashboard(
      row.id,
      {
        name:       normalizeName(body.name),
        visibility: body.visibility as SavedDashboardVisibility,
        layout:     sanitizeDashboardLayout(body.layout),
      },
      user,
    );
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const user = requireViewer(req);
    const row = await getSavedDashboard(req.params.id);
    // Someone else's dashboard (including an orphan left by a deleted account)
    // is housekeeping — fullwrite.
    if (row.ownerId !== user.id && !hasPermission(req, "savedDashboards", "fullwrite")) {
      throw new AppError(403, "Forbidden — deleting someone else's dashboard requires savedDashboards:fullwrite");
    }
    await deleteSavedDashboard(row.id, user.username);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Declared LAST so the literal paths above can never be captured by :id.
router.get("/:id", async (req, res, next) => {
  try {
    const user = viewer(req);
    res.json(await readSavedDashboard(req.params.id, user ? user.id : null));
  } catch (err) {
    next(err);
  }
});

export default router;
