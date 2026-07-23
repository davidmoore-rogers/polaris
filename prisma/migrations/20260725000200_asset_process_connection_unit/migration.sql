-- Service dimension (Phase 3): attribute a mapped connection to its owning
-- systemd unit / Windows service, so the Services detail panel + Application
-- Map can group sockets by UNIT (not just program name).
--
-- Deterministic per process; set on insert, never bumped on conflict — so it is
-- NOT part of the business-key unique index. Default "" keeps the column total
-- (matching the sentinel convention on the other business-key columns) and
-- backfills existing rows harmlessly.

ALTER TABLE "asset_process_connections" ADD COLUMN "unit" TEXT NOT NULL DEFAULT '';
