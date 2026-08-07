-- Per-user list-page tabs (Assets page tab strip). One row per (user, scope);
-- absent row = the default single tab, materialized client-side and persisted
-- only once the operator changes something.
--
-- UserDashboard pattern, not SavedTableFilter's: strictly per-user UI state, so
-- it CASCADES with the user (nothing here is shared, unlike a public saved
-- filter, which deliberately outlives its author).

CREATE TABLE "user_table_tabs" (
    "userId"    TEXT NOT NULL,
    "scope"     TEXT NOT NULL,
    "tabs"      JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_table_tabs_pkey" PRIMARY KEY ("userId", "scope")
);

ALTER TABLE "user_table_tabs"
  ADD CONSTRAINT "user_table_tabs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
