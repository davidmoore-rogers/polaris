-- A saved topology layout is a restore point, not just the live positions.
--
-- Device Map topology drags already persist: a drag lands in `positions` ~1s
-- later and every operator sees it. What there was no way to express is "this
-- arrangement is the good one" -- so the only escape from an experiment that
-- went wrong was Reset, which drops all the way back to the column solver's
-- baseline and discards every deliberate placement with it.
--
-- `savedPositions` is the blob as it stood the last time an operator clicked
-- Save, with who and when alongside it. It is written ONLY by that explicit
-- action; the debounced drag save keeps writing `positions` alone and never
-- touches it. NULL means this (site, view) has never been saved, which is
-- what greys out "Reset to last save" in the Reset menu -- and it is the
-- state every existing row starts in, so nothing is backfilled.
--
-- The two resets differ in what survives: "last save" copies savedPositions
-- back over positions (the restore point stays, so it can be used again),
-- while "baseline" clears positions and keeps savedPositions when there is
-- one -- an operator who resets to baseline must still be able to change
-- their mind. A row with no restore point is deleted outright, which is the
-- pre-existing behavior.
ALTER TABLE "topology_layouts" ADD COLUMN IF NOT EXISTS "saved_positions" JSONB;
ALTER TABLE "topology_layouts" ADD COLUMN IF NOT EXISTS "saved_by" TEXT;
ALTER TABLE "topology_layouts" ADD COLUMN IF NOT EXISTS "saved_at" TIMESTAMP(3);
