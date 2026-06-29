/**
 * src/api/routes/pushSubscriptions.ts
 *
 * Per-user Web Push subscription management + VAPID public-key handoff.
 *   GET    /push-subscriptions/key   — the server VAPID public key (for PushManager.subscribe)
 *   POST   /push-subscriptions       — store/refresh the caller's subscription
 *   DELETE /push-subscriptions       — remove a subscription by endpoint
 *
 * Gated by notifications=read (any viewer may opt into push). A subscription is
 * owned by the session user; the deliverNotifications web_push channel routes
 * to a user's endpoints when a rule's recipientTags match that user.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requirePermission } from "../middleware/permissions.js";
import { getWebPushConfig } from "../../services/notificationConfigService.js";

const router = Router();

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
});

router.get("/key", requirePermission("notifications", "read"), async (_req, res, next) => {
  try {
    const cfg = await getWebPushConfig();
    res.json({ enabled: cfg.enabled && !!cfg.publicKey, publicKey: cfg.enabled ? cfg.publicKey : "" });
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("notifications", "read"), async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    const { endpoint, keys } = subscribeSchema.parse(req.body);
    const userAgent = (req.get("user-agent") ?? "").slice(0, 500) || null;
    const now = new Date();
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent, lastSeenAt: now },
      // Re-subscribe may move the endpoint to a different user (shared machine) —
      // re-own it and refresh the keys.
      update: { userId, p256dh: keys.p256dh, auth: keys.auth, userAgent, lastSeenAt: now },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete("/", requirePermission("notifications", "read"), async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    const endpoint = z.string().url().max(2000).parse(req.body?.endpoint);
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
