/**
 * src/api/routes/notificationPreference.ts
 *
 * The caller's OWN notification preference — how this account wants to be
 * alerted: email, push, or both.
 *
 *   GET /me/notification-preference  → { preference, options }
 *   PUT /me/notification-preference  → { preference }
 *
 * A `/me/*` route, the /me/dashboard + /me/table-tabs sibling: strictly
 * per-caller, never addressable for another user, no admin surface. Gated
 * `alerts:read` on BOTH verbs — the same gate the push-subscription routes
 * carry, and for the same reason (any viewer may decide how they are alerted;
 * choosing a delivery method is not an alert-management privilege).
 *
 * `options` rides the GET so the two clients render the same three labels from
 * the server's vocabulary instead of each hardcoding their own wording.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { requirePermission } from "../middleware/permissions.js";
import {
  NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCE_LABELS,
  getNotificationPreference,
  setNotificationPreference,
} from "../../services/notificationPreferenceService.js";

const router = Router();

const bodySchema = z.object({ preference: z.enum(NOTIFICATION_PREFERENCES) });

router.get("/", requirePermission("alerts", "read"), async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    res.json({
      preference: await getNotificationPreference(userId),
      options: NOTIFICATION_PREFERENCES.map((p) => ({ value: p, label: NOTIFICATION_PREFERENCE_LABELS[p] })),
    });
  } catch (err) {
    next(err);
  }
});

router.put("/", requirePermission("alerts", "read"), async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    const { preference } = bodySchema.parse(req.body);
    res.json({
      preference: await setNotificationPreference(userId, req.session?.username ?? "unknown", preference),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
