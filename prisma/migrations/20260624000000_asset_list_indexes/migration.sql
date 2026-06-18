-- Server-side asset list ordering indexes.
-- createdAt is the default sort on every assets-page load; lastSeen is a common
-- "what's gone stale" sort. Without these the paged ORDER BY ... LIMIT falls
-- back to a full sort as the fleet grows past a few thousand assets.
CREATE INDEX IF NOT EXISTS "assets_createdAt_idx" ON "assets" ("createdAt");
CREATE INDEX IF NOT EXISTS "assets_lastSeen_idx" ON "assets" ("lastSeen");
