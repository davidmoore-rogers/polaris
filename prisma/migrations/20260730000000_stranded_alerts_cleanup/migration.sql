-- Stranded-alert cleanup + severity-band backfill.
--
-- 1) Backfill notification_rule_states.firingSeverity (added by
--    20260726000000_automation_severity_bands with no backfill). A firing row
--    that predates the bands upgrade carries NULL, which the engine reads as
--    "at the BASE severity" — an alert that fired at a higher severity could
--    then never de-escalate while the value sat in the base band (it kept its
--    old severity, e.g. critical, until fully resolved). Adopt the live
--    notification's severity as the row's current band.
UPDATE "notification_rule_states" s
SET "firingSeverity" = n."severity"
FROM "notifications" n
WHERE s."notificationId" = n."id"
  AND s."state" = 'firing'
  AND s."firingSeverity" IS NULL;

-- 2) Disabled rules: the engine only evaluates enabled rules, so alerts that
--    were active when a rule was disabled sat uncleared forever (still counted
--    by every dashboard widget). The rule service now clears on disable; this
--    heals rows stranded before that fix. Soft-clear preserves history.
UPDATE "notifications" n
SET "cleared" = true, "clearedBy" = 'system:rule-disabled', "clearedAt" = now()
FROM "notification_rules" r
WHERE n."ruleId" = r."id"
  AND r."enabled" = false
  AND n."cleared" = false;

DELETE FROM "notification_rule_states" s
USING "notification_rules" r
WHERE s."ruleId" = r."id"
  AND r."enabled" = false;

-- 3) Deleted rules: ruleId went NULL (SetNull) and the cascade dropped the
--    state rows, so nothing could ever auto-clear these. The rule service now
--    clears before delete; heal the pre-fix strays.
UPDATE "notifications"
SET "cleared" = true, "clearedBy" = 'system:rule-deleted', "clearedAt" = now()
WHERE "ruleId" IS NULL
  AND "cleared" = false;

-- 4) Baseline message templates: the seeded interface/IPsec rules are
--    dimensioned (one alert per interface/tunnel) but their templates never
--    named the dimension ("a monitored interface is down" — which one?). Only
--    byte-identical (unedited) templates are rewritten; operator-edited
--    templates are untouched. Seeding is seed-once, so existing installs only
--    get this via the migration.
UPDATE "notification_rules"
SET "messageTemplate" = '{asset}: monitored interface {dimension} is down'
WHERE "messageTemplate" = '{asset}: a monitored interface is down';

UPDATE "notification_rules"
SET "messageTemplate" = '{asset}: IPsec tunnel {dimension} is down'
WHERE "messageTemplate" = '{asset}: an IPsec tunnel is down';
