-- The `notification.triggered` audit Event became an ACTION ({"type":"event"})
-- so an operator can remove it from a deliberately noisy automation. The engine
-- now writes that Event only when the action is present.
--
-- Every stored automation predates the action and would therefore stop
-- auditing on deploy — silently, and those Events feed the Events tab, the
-- baseline event-trigger automations that watch for them, and the syslog/SFTP
-- archival stream. So append it to every rule whose actions array lacks one.
--
-- Rows with NULL actions (pre-v2, never re-saved) are left alone: their v2 view
-- is built on read by normalizeRuleToV2, which injects the event action while
-- folding legacy `targets` forward. Writing an actions array here would instead
-- promote them to v2 without the rest of that normalization.
--
-- Deliberately NOT applied to `event`/`change`-triggered rules: the event tail
-- writes no Event by design (an automation driven BY Events must not emit one
-- and feed itself), so the action would be dead weight the builder then warns
-- about.

UPDATE "notification_rules"
   SET "actions" = "actions" || '[{"type":"event"}]'::jsonb,
       "updatedAt" = NOW()
 WHERE "actions" IS NOT NULL
   AND jsonb_typeof("actions") = 'array'
   AND NOT ("actions" @> '[{"type":"event"}]'::jsonb)
   AND COALESCE("trigger"->>'type', '') NOT IN ('event', 'change');
