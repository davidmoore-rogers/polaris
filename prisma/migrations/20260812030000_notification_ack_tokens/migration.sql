-- One-click acknowledge links for alert emails and web-push notifications.
--
-- Until now an alert could be acknowledged only through POST /api/v1/alerts/
-- acknowledge, which is session-authenticated and had ZERO frontend call sites
-- — so `escalation.stopOn: "acknowledge"`, offered on every escalation chain,
-- was unreachable in practice. This table backs a link the recipient can click
-- straight out of the message.
--
-- One row per (notification, user recipient), minted at delivery fan-out and
-- consumed once. Only recipients who are configured Polaris users holding
-- alerts:write get a token: an address-book contact is an address, not an
-- account, so there would be nobody to record as the acknowledger.
--
-- tokenHash is base64url(sha256(raw)) rather than the argon2id + indexed-prefix
-- walk ApiToken / the agent tokens use. Those hash operator-visible secrets of
-- unknown entropy; this token is 24 random bytes we mint (192 bits), so there
-- is no dictionary for a work factor to slow down — and minting runs on the
-- alert fan-out path, where argon2's ~50ms/row would spend seconds of blocked
-- CPU on a single large alert in the same process that serves HTTP. The plain
-- digest also makes redemption one indexed lookup instead of a candidate walk,
-- which is why this table has no prefix column.
CREATE TABLE "notification_ack_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_ack_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_ack_tokens_tokenHash_key" ON "notification_ack_tokens"("tokenHash");
CREATE INDEX "notification_ack_tokens_notificationId_idx" ON "notification_ack_tokens"("notificationId");
-- The prune sweep's only predicate.
CREATE INDEX "notification_ack_tokens_expiresAt_idx" ON "notification_ack_tokens"("expiresAt");

ALTER TABLE "notification_ack_tokens" ADD CONSTRAINT "notification_ack_tokens_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_ack_tokens" ADD CONSTRAINT "notification_ack_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Raised by the automation wizard's "Test delivery" buttons rather than by a
-- real trigger. Such an alert always carries ruleId = NULL, because
-- notificationEscalationService sweeps { cleared: false, ruleId: IN enabled }
-- and a test alert with a real ruleId would enter the escalation ladder and
-- start paging people on the next 60s tick. That makes this column the only
-- way to tell a test alert apart from a genuinely rule-less one.
ALTER TABLE "notifications" ADD COLUMN "testRun" BOOLEAN NOT NULL DEFAULT false;
