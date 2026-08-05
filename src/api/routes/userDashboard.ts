/**
 * src/api/routes/userDashboard.ts
 *
 * Per-user dashboard layout persistence. Mounted at /api/v1/me/dashboard
 * (after the global requireAuth in router.ts). No admin override —
 * layouts are strictly per-caller. No Event audit log — this is UI
 * preference, not security-relevant.
 *
 * GET  /me/dashboard — returns the caller's layout, or the empty layout
 *                       ({version:3,dashboards:[],activeId:""}) when no row
 *                       exists yet. A legacy v1/v2 row is returned untouched
 *                       (GET is not validated) and wrapped into one tab
 *                       client-side.
 * PUT  /me/dashboard — Zod-validates the full v3 layout (multiple named
 *                       dashboards + activeId), upserts, returns the saved
 *                       shape. The client always normalizes to v3 before
 *                       saving, so PUT only ever needs to accept v3.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import {
  getLayoutForUser,
  saveLayoutForUser,
  type DashboardLayout,
} from "../../services/userDashboardService.js";

const router = Router();

// Layout caps. Generous but bounded so a malicious caller can't push a huge blob.
const MAX_WIDGETS = 64;          // per dashboard
const MAX_COLUMNS = 12;          // per dashboard
const MAX_DASHBOARDS = 24;

const WidgetInstanceSchema = z.object({
  id:     z.string().uuid("widget id must be a uuid"),
  type:   z.string().min(1).max(64),
  height: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  config: z.record(z.unknown()).default({}),
});

const ColumnSchema = z.object({
  id:      z.string().uuid("column id must be a uuid"),
  width:   z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(12)]),
  widgets: z.array(WidgetInstanceSchema).max(MAX_WIDGETS),
});

const DashboardSchema = z
  .object({
    id:      z.string().uuid("dashboard id must be a uuid"),
    name:    z.string().min(1).max(60),
    columns: z.array(ColumnSchema).max(MAX_COLUMNS),
  })
  .superRefine((dash, ctx) => {
    const total = dash.columns.reduce((n, c) => n + c.widgets.length, 0);
    if (total > MAX_WIDGETS) {
      ctx.addIssue({ code: "custom", message: `too many widgets (max ${MAX_WIDGETS})` });
    }
  });

const LayoutSchema = z
  .object({
    version:    z.literal(3),
    dashboards: z.array(DashboardSchema).min(1).max(MAX_DASHBOARDS),
    activeId:   z.string().uuid(),
  })
  .superRefine((layout, ctx) => {
    if (!layout.dashboards.some((d) => d.id === layout.activeId)) {
      ctx.addIssue({ code: "custom", message: "activeId must match a dashboard id" });
    }
  });

router.get("/", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Unauthorized");
    const layout = await getLayoutForUser(userId);
    res.json(layout);
  } catch (err) {
    next(err);
  }
});

router.put("/", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Unauthorized");
    // Inline parse like every other route file — the global errorHandler
    // formats a thrown ZodError into a field-labeled 400.
    const body = LayoutSchema.parse(req.body) as DashboardLayout;
    const layout = await saveLayoutForUser(userId, body);
    res.json(layout);
  } catch (err) {
    next(err);
  }
});

export default router;
