-- Fast-confirm re-probe cadence (business rule 30): how quickly a monitor
-- failure or recovery run is re-probed while it is still being confirmed.
-- Tier-2 (per class) column only, mirroring failureThreshold — the tier-3
-- integration/manual values live in JSON blobs and need no migration, and
-- there is deliberately no per-asset column.
--
-- NULL = inherit from the tier below; the hardcoded floor is 10 seconds, so
-- every existing install keeps that default until an operator changes it.
ALTER TABLE "monitor_class_overrides"
  ADD COLUMN IF NOT EXISTS "fastConfirmIntervalSec" INTEGER;
