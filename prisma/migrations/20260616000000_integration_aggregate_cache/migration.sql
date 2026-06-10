-- Precomputed "By name" checklist sources for the Auto-Monitor interface/storage
-- cards. Refreshed at the end of every successful discovery run so the edit-modal
-- pickers load instantly instead of running a fleet-wide DISTINCT ON over the
-- sample tables on every modal open. Both nullable; the GET routes fall back to a
-- live compute while these are NULL (the window before the first post-feature
-- discovery run for each integration).
ALTER TABLE "integrations" ADD COLUMN "interfaceAggregateCache" JSONB;
ALTER TABLE "integrations" ADD COLUMN "storageAggregateCache" JSONB;
