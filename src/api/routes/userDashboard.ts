/**
 * src/api/routes/userDashboard.ts
 *
 * Per-user dashboard layout persistence. Mounted at /api/v1/me/dashboard
 * (after the global requireAuth in router.ts). No admin override —
 * layouts are strictly per-caller. No Event audit log — this is UI
 * preference, not security-relevant.
 *
 * GET  /me/dashboard — returns the caller's layout, or the empty layout
 *                       ({version:2,columns:[]}) when no row exists yet. A
 *                       legacy v1 row is returned untouched (GET is not
 *                       validated) and migrated to v2 client-side.
 * PUT  /me/dashboard — Zod-validates the full v2 layout, upserts, returns
 *                       the saved shape so the client sees what landed. The
 *                       client always migrates v1→v2 before saving, so PUT
 *                       only ever needs to accept v2.
 */

import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { AppError } from "../../utils/errors.js";
import {
  getLayoutForUser,
  saveLayoutForUser,
  type DashboardLayout,
} from "../../services/userDashboardService.js";

const router = Router();

// Layout caps. Generous on widget count but bounded so a malicious caller
// can't push a 10 MB blob.
const MAX_WIDGETS = 64;
const MAX_COLUMNS = 12;

const WidgetInstanceSchema = z.object({
  id:     z.string().uuid("widget id must be a uuid"),
  type:   z.string().min(1).max(64),
  height: z.union([z.literal(1), z.literal(2)]),
  config: z.record(z.unknown()).default({}),
});

const ColumnSchema = z.object({
  id:      z.string().uuid("column id must be a uuid"),
  width:   z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(12)]),
  widgets: z.array(WidgetInstanceSchema).max(MAX_WIDGETS),
});

const LayoutSchema = z
  .object({
    version: z.literal(2),
    columns: z.array(ColumnSchema).max(MAX_COLUMNS),
  })
  .superRefine((layout, ctx) => {
    const total = layout.columns.reduce((n, c) => n + c.widgets.length, 0);
    if (total > MAX_WIDGETS) {
      ctx.addIssue({ code: "custom", message: `too many widgets (max ${MAX_WIDGETS})` });
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

router.put("/", validate(LayoutSchema), async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Unauthorized");
    const layout = await saveLayoutForUser(userId, req.body as DashboardLayout);
    res.json(layout);
  } catch (err) {
    next(err);
  }
});

export default router;
