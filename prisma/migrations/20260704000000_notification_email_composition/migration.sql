-- Rule-level outbound-email composition + escalation tiers.
-- All columns nullable, no backfill: NULL = pre-feature behavior.
ALTER TABLE "notification_rules" ADD COLUMN "emailComposition" JSONB;
ALTER TABLE "notification_rules" ADD COLUMN "escalation" JSONB;

-- Fire-time template-context snapshot + per-tier escalation progress.
ALTER TABLE "notifications" ADD COLUMN "templateCtx" JSONB;
ALTER TABLE "notifications" ADD COLUMN "escalationState" JSONB;
