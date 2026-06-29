-- Notification delivery channels registry. Replaces the singleton SMTP / M365 /
-- Web Push `Setting` rows with an operator-managed list of channel integrations
-- (Notifications → Delivery tab), and reworks notification_deliveries to
-- reference a channel by id instead of inlining the destination.

-- ─── notification_channels ────────────────────────────────────────────────────

CREATE TABLE "notification_channels" (
  "id"        TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "type"      TEXT NOT NULL,           -- smtp | oauth_m365 | pushbullet | slack | teams | web_push
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "config"    JSONB NOT NULL DEFAULT '{}',
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_channels_type_idx" ON "notification_channels"("type");

-- ─── notification_deliveries: channel(text) → transport, + channelId FK ─────────

ALTER TABLE "notification_deliveries" RENAME COLUMN "channel" TO "transport";
ALTER TABLE "notification_deliveries" ADD COLUMN "channelId" TEXT;
CREATE INDEX "notification_deliveries_channelId_idx" ON "notification_deliveries"("channelId");
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_channelId_fkey" FOREIGN KEY ("channelId")
  REFERENCES "notification_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
