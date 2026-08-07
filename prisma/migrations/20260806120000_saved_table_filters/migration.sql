-- Saved table filters — named, server-persisted snapshots of a list page's
-- TableSF filter + sort state (Assets page → Filters ▾).
--
-- Server-side rather than localStorage because presets are shareable:
-- visibility='public' offers the row to every user who can read the scope,
-- 'private' only to its owner. `scope` names the table ("assets" today) and
-- maps to the RBAC function key that gates it (SAVED_FILTER_SCOPES in
-- services/savedFilterService.ts).
--
-- ownerId is ON DELETE SET NULL, not CASCADE: a shared preset must outlive the
-- account that published it. The unique index treats NULL owners as distinct
-- rows (Postgres NULL semantics), which is what we want — orphaned presets
-- never block a live user from reusing a name.

CREATE TABLE "saved_table_filters" (
    "id"         TEXT NOT NULL,
    "scope"      TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "ownerId"    TEXT,
    "ownerName"  TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "state"      JSONB NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_table_filters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saved_table_filters_scope_ownerId_name_key"
  ON "saved_table_filters"("scope", "ownerId", "name");

CREATE INDEX "saved_table_filters_scope_visibility_idx"
  ON "saved_table_filters"("scope", "visibility");

ALTER TABLE "saved_table_filters"
  ADD CONSTRAINT "saved_table_filters_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
