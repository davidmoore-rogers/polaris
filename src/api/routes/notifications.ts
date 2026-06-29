/**
 * src/api/routes/notifications.ts — triggered notifications (View tab).
 *
 * Mounted at /api/v1/notifications. Gates:
 *   GET  /            notifications:read   (view; region-scoped to the caller)
 *   POST /acknowledge notifications:write  (user and up; readonly cannot)
 *   POST /clear       notifications:fullwrite (admin + assetsadmin)
 *
 * Rule CRUD lives in notificationRules.ts. Business logic in
 * notificationService; region scope via regionScopeService.
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import {
  listNotifications,
  acknowledgeNotifications,
  clearNotifications,
} from "../../services/notificationService.js";
import { getEffectiveRegionTags } from "../../services/regionScopeService.js";

export const notificationsRouter = Router();

const csvList = (v: unknown): string[] | undefined => {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
};

notificationsRouter.get("/", requirePermission("notifications", "read"), async (req, res, next) => {
  try {
    const viewerRegionTags = req.session?.userId
      ? await getEffectiveRegionTags(req.session.userId)
      : [];
    const ackParam = req.query.acknowledged;
    const result = await listNotifications({
      viewerRegionTags,
      filters: {
        severity: csvList(req.query.severity),
        acknowledged:
          ackParam === "true" ? true : ackParam === "false" ? false : undefined,
        assetId: typeof req.query.assetId === "string" ? req.query.assetId : undefined,
        region: csvList(req.query.region),
        search: typeof req.query.search === "string" ? req.query.search : undefined,
        includeCleared: req.query.includeCleared === "true",
      },
      sortBy: typeof req.query.sortBy === "string" ? req.query.sortBy : undefined,
      sortDir: req.query.sortDir === "asc" ? "asc" : "desc",
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
      offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
});

const AckSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(2000),
  note: z.string().max(2000).optional(),
});

notificationsRouter.post("/acknowledge", requirePermission("notifications", "write"), async (req, res, next) => {
  try {
    const { ids, note } = AckSchema.parse(req.body);
    const count = await acknowledgeNotifications(ids, req.session?.username ?? "unknown", note);
    res.json({ acknowledged: count });
  } catch (err) { next(err); }
});

const ClearSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(2000),
});

notificationsRouter.post("/clear", requirePermission("notifications", "fullwrite"), async (req, res, next) => {
  try {
    const { ids } = ClearSchema.parse(req.body);
    const count = await clearNotifications(ids, req.session?.username ?? "unknown");
    res.json({ cleared: count });
  } catch (err) { next(err); }
});

export default notificationsRouter;
