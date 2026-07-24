-- Severity bands (value-driven severity escalation) for automations.
--
-- notification_rules gains two nullable JSON columns:
--   severityBands — higher tiers stacked on the base trigger threshold/severity
--     (tier 0). Each band: { threshold, severity, actions[], escalation? }. As
--     the metric climbs, the alert's severity escalates and re-notifies with the
--     entered band's actions. NULL = single-severity (pre-band) behavior.
--   bandNotify — per-automation notify policy for band transitions:
--     { onIncrease, onDecrease, onResolved, resolvedMode, resolvedActions? }.
--     NULL = defaults (notify on increase + resolved via reuse).
--
-- notification_rule_states gains firingSeverity — the severity band the active
-- alert is currently in, so the engine can detect increase/decrease/same
-- transitions across ticks. NULL for pre-band / single-severity alerts.
ALTER TABLE "notification_rules" ADD COLUMN "severityBands" JSONB;
ALTER TABLE "notification_rules" ADD COLUMN "bandNotify" JSONB;
ALTER TABLE "notification_rule_states" ADD COLUMN "firingSeverity" TEXT;
