-- Notification severity vocabulary expanded from info/warning/error to
-- notice / informational / warning / serious / critical. severity is a free
-- String column (no DB enum), so this is a data-only remap of existing rows so
-- they stay valid against the new Zod enum on the next write:
--   info  -> informational
--   error -> critical
--   warning stays warning; values already in the new set are untouched.
-- (Audit Event.level is a separate vocabulary and is NOT changed here.)

UPDATE "notification_rules"
  SET "severity" = CASE "severity"
    WHEN 'info'  THEN 'informational'
    WHEN 'error' THEN 'critical'
    ELSE "severity"
  END
  WHERE "severity" IN ('info', 'error');

UPDATE "notifications"
  SET "severity" = CASE "severity"
    WHEN 'info'  THEN 'informational'
    WHEN 'error' THEN 'critical'
    ELSE "severity"
  END
  WHERE "severity" IN ('info', 'error');
