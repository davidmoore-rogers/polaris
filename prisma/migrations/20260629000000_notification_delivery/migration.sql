-- Notification delivery: outbound routing of triggered notifications to
-- email / webhook / web-push recipients.
--
--  * notification_rules.targets — delivery targets (channel + recipientTags /
--    addresses / webhookUrl + kind). In-app stays implicit.
--  * notification_deliveries — one row per (notification, channel, recipient),
--    drained by the deliverNotifications job (pending → sent | failed, ≤3 tries).
--  * push_subscriptions — per-user browser/PWA Web Push subscriptions.

-- ─── notification_rules.targets ───────────────────────────────────────────────

ALTER TABLE "notification_rules"
  ADD COLUMN "targets" JSONB NOT NULL DEFAULT '[]';

-- ─── notification_deliveries ──────────────────────────────────────────────────

CREATE TABLE "notification_deliveries" (
  "id"             TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "channel"        TEXT NOT NULL,
  "target"         TEXT NOT NULL,
  "meta"           JSONB,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt"  TIMESTAMP(3),
  "error"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_deliveries_status_idx" ON "notification_deliveries"("status");
CREATE INDEX "notification_deliveries_notificationId_idx" ON "notification_deliveries"("notificationId");

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId")
  REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── push_subscriptions ───────────────────────────────────────────────────────

CREATE TABLE "push_subscriptions" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "endpoint"   TEXT NOT NULL,
  "p256dh"     TEXT NOT NULL,
  "auth"       TEXT NOT NULL,
  "userAgent"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
