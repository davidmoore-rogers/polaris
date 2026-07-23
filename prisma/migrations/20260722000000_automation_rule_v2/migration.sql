-- Automation rule-shape v2.
--
-- notification_rules gains two nullable JSONB columns:
--   reset   — { mode: "manual"|"auto"|"timed", clearThreshold?, sustainSec?, afterSec? }
--             supersedes clearBehavior/clearAfterSec; auto mode gains hysteresis
--             (separate clear threshold) + clear-sustain (recovered-for duration).
--   actions — [{ type: "notify"|"api_call"|"script", ... }]
--             supersedes `targets` as the unified fired-outcome list.
--
-- NULL = pre-v2 row: readers normalize via normalizeRuleToV2() and the
-- migrateAutomationRuleShape one-shot startup job persists the converted
-- shape. Legacy columns are retained (and kept mirrored on save) so pre-wizard
-- UIs and restored pre-upgrade backups stay coherent; no data rewrite here.
ALTER TABLE "notification_rules"
  ADD COLUMN "reset"   JSONB,
  ADD COLUMN "actions" JSONB;

-- Recovery-sustain timer for the engine's firing state (reset.sustainSec):
-- stamped when the condition first reads recovered, nulled on re-meet /
-- hysteresis dead band. Distinct from conditionMetSince (pending-side debounce).
ALTER TABLE "notification_rule_states"
  ADD COLUMN "recoveredSince" TIMESTAMP(3);
