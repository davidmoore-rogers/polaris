-- Statuses that cannot be monitor-enabled (business rule 10, widened).
--
-- Pre-cutover only `decommissioned` and `disabled` forced `monitored=false`;
-- `storage` (on a shelf) and `quarantined` (deliberately isolated at the
-- FortiGate, so every probe fails BY DESIGN) could sit monitored and firing
-- down alerts about the isolation working. The clamp now covers all four
-- (src/utils/assetInvariants.ts:UNMONITORABLE_STATUSES, enforced in src/db.ts).

-- Parks `monitored` across a quarantine the way statusBeforeQuarantine parks
-- the status, so releasing a quarantine hands the device back to the network
-- WITH monitoring, instead of silently unwatched.
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "monitoredBeforeQuarantine" BOOLEAN;

-- Park the flag for assets that are quarantined AND still monitored right now,
-- BEFORE the sweep below clears it — otherwise their release would pop status
-- back with monitoring off and no record that it had ever been on.
UPDATE "assets"
   SET "monitoredBeforeQuarantine" = TRUE
 WHERE "status" = 'quarantined'
   AND "monitored" = TRUE
   AND "monitoredBeforeQuarantine" IS NULL;

-- One-shot reconcile of existing rows: the clamp only fires on writes, so
-- rows that reached an unmonitorable status before this migration keep
-- polling until something touches them.
UPDATE "assets"
   SET "monitored" = FALSE,
       "consecutiveFailures" = 0
 WHERE "monitored" = TRUE
   AND "status" IN ('decommissioned', 'disabled', 'storage', 'quarantined');
