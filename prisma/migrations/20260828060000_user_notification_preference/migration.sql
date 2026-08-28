-- Per-user notification preference: which delivery method this account wants
-- an alert on. "email" | "push" | "any".
--
-- Defaults to "email" for every existing row, which reproduces the pre-feature
-- behaviour exactly: the flag is only ever consulted by a notify action that
-- opted in AND sits in an action group carrying BOTH methods, and no stored
-- action carries that opt-in yet.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "notification_preference" TEXT NOT NULL DEFAULT 'email';
