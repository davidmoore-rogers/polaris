-- Turn asset_arp_entries from delete-replace into ACCUMULATE + AGE, so the tab
-- can answer "who was at this address last Tuesday" instead of only "right
-- now" -- and so a retention window has something to retain.
--
-- Row volume is why this is an interval-per-binding table rather than a
-- row-per-scrape time-series: at the 600s system-info cadence a snapshot table
-- would be ~52M rows/month across a 40-gate fleet, while a binding that
-- persists all month is ONE row here whose lastSeen is bumped. The cost is
-- that history is an interval, not a timeline: a MAC that flips away and back
-- between two scrapes is invisible, and a binding that recurs after a gap
-- collapses into one row spanning it.
--
-- ifName becomes NOT NULL with '' meaning "the device attributed this to no
-- interface". Nullable would be more honest in isolation, but it is part of
-- the business key, and Postgres treats NULLs as DISTINCT in a unique index --
-- so every unattributed binding would insert a fresh duplicate on every single
-- scrape rather than conflicting with itself, which is unbounded growth on the
-- exact rows nobody is watching. The '' sentinel never escapes the service
-- layer: the route maps it back to null on the way out.

UPDATE "asset_arp_entries" SET "ifName" = '' WHERE "ifName" IS NULL;

ALTER TABLE "asset_arp_entries" ALTER COLUMN "ifName" SET DEFAULT '';
ALTER TABLE "asset_arp_entries" ALTER COLUMN "ifName" SET NOT NULL;

-- The range filter ("seen in the last 12 hours") and the retention prune both
-- read lastSeen; the prune is fleet-wide so it wants lastSeen leading, the tab
-- is per-asset so it wants assetId leading. Two indexes, both cheap on a table
-- this size.
CREATE INDEX "asset_arp_entries_assetId_lastSeen_idx"
  ON "asset_arp_entries" ("assetId", "lastSeen");
CREATE INDEX "asset_arp_entries_lastSeen_idx"
  ON "asset_arp_entries" ("lastSeen");
