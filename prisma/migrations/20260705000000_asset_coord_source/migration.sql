-- Provenance marker for Asset.latitude/longitude. "manual" = operator-typed
-- coordinates via the asset edit form; discovery skips its projected coord
-- write while set. NULL = discovery-owned (or unset). Existing rows stay
-- NULL — all pre-existing coords were discovery-stamped.
ALTER TABLE "assets" ADD COLUMN "coordSource" TEXT;
