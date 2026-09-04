-- Network Discovery visibility — a saved Discovery becomes private or public,
-- so one operator can build a sweep another operator runs. The SavedDashboard /
-- SavedTableFilter model applied to `network_scans`.
--
-- Three parts:
--
-- 1. Columns. `visibility` ('private' | 'public') and `ownerId` (the User the
--    row belongs to). `createdBy` already held the username snapshot that
--    SavedDashboard calls `ownerName`, so it is reused rather than duplicated;
--    ownerId is what ownership is DECIDED on, createdBy is what survives the
--    account. SET NULL, not CASCADE — a shared Discovery outlives the account
--    that published it, and an orphan is then manageable only at fullwrite.
--
-- 2. Name uniqueness moves from global to per-owner. Two operators may each
--    keep a private "Plant 3 sweep", and refusing the second with a 409 that
--    names a row the caller cannot see is both a dead end and a disclosure.
--    Existing names are globally unique, so nothing can collide on the way in.
--
-- 3. Backfill. Every EXISTING Discovery is visible to every networkScan:read
--    holder today, so they migrate as 'public' — the new 'private' default
--    governs rows created from here on, and silently hiding other operators'
--    saved work would be the wrong way to ship a sharing feature. ownerId is
--    resolved from `createdBy` where it names a live account; a token-created
--    or since-deleted author leaves it NULL (an orphan, still public).
--
-- No RBAC key is added: `networkScan` already exists, its `write` level already
-- gates create/edit/delete/run, and PUBLISHING deliberately needs nothing extra
-- (networkadmin and assetsadmin hold write, not fullwrite, and they are exactly
-- the roles that author Discoveries — requiring fullwrite to share one would
-- put the feature out of reach of everyone it is for). What fullwrite buys is
-- editing or deleting SOMEONE ELSE'S row.

ALTER TABLE "network_scans"
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN "ownerId"    TEXT;

-- ─── Backfill (before the unique index, so it sees the final ownerId) ───────

UPDATE "network_scans" SET "visibility" = 'public';

UPDATE "network_scans" AS s
   SET "ownerId" = u."id"
  FROM "users" AS u
 WHERE u."username" = s."createdBy"
   AND s."createdBy" IS NOT NULL;

-- ─── Indexes ────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "network_scans_name_key";

-- The name is the operator's handle within their own set. NULLs compare as
-- distinct in Postgres, so orphaned / token-created rows are not constrained
-- against each other — acceptable: nothing overwrites by name on those paths.
CREATE UNIQUE INDEX "network_scans_ownerId_name_key" ON "network_scans"("ownerId", "name");
-- The list's other arm: "every public row", with no owner to narrow it.
CREATE INDEX "network_scans_visibility_idx" ON "network_scans"("visibility");

ALTER TABLE "network_scans"
  ADD CONSTRAINT "network_scans_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
