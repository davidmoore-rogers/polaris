-- Poll-counted holds: the consecutive-reading counters a CURRENT-STATE source
-- needs, because it has no sample series the engine could count instead (the
-- Asset columns, the SD-WAN rule table, and the windowed-ratio metrics that are
-- recomputed per tick). `last_reading_at` is that stream's poll anchor as of the
-- last reading that advanced a run: without it the engine's 60-second tick
-- would count five "polls" against a device polled every five minutes.
--
-- Defaults are 0/NULL, which is exactly a row that has never counted anything —
-- every existing rule keeps its wall-clock behaviour until it is re-saved with a
-- poll count (nothing is migrated; `forDurationSec` remains authoritative on a
-- trigger that states no `forPolls`).
ALTER TABLE "notification_rule_states"
  ADD COLUMN IF NOT EXISTS "metRun" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "clearRun" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastReadingAt" TIMESTAMP(3);
