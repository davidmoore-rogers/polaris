-- Event.levelRank — numeric severity (0=info, 1=warning, 2=error) stamped at
-- write time from `level`. The Events list endpoint's sortBy=level dispatches
-- to orderBy: { levelRank } so severity sort matches operator expectations
-- rather than alphabetical (error < info < warning). Room for -1=debug /
-- 3=critical later. The `level` string column stays as the display source of
-- truth; this is index/sort-only.
--
-- Three composite indexes back the new server-side sort/filter UX on the
-- Events page (per-column sort headers + multi-select level filter at
-- 235k–350k row scale): (levelRank, timestamp) for severity sort within
-- the 7-day retention window, (actor, timestamp) and (resourceName, timestamp)
-- so per-user / per-resource filters do an Index Scan instead of a Sort plan.
-- Existing indexes (timestamp, action, resourceType, level) already cover the
-- other whitelist columns.
--
-- Backfill: `levelRank` for existing rows is computed from `level` in the same
-- migration. 235k rows complete in seconds. Default 0 covers any in-flight
-- inserts during the migration window — the live writer also stamps the
-- column going forward, so the default only ever applies to writes that
-- bypass logEvent (none in-tree today).

ALTER TABLE "events"
  ADD COLUMN "levelRank" INTEGER NOT NULL DEFAULT 0;

UPDATE "events"
  SET "levelRank" = CASE "level"
    WHEN 'error'   THEN 2
    WHEN 'warning' THEN 1
    ELSE 0
  END;

CREATE INDEX "events_levelRank_timestamp_idx"    ON "events" ("levelRank", "timestamp");
CREATE INDEX "events_actor_timestamp_idx"        ON "events" ("actor", "timestamp");
CREATE INDEX "events_resourceName_timestamp_idx" ON "events" ("resourceName", "timestamp");
