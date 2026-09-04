-- Saved dashboards — a named, shareable snapshot of ONE dashboard canvas, the
-- SavedTableFilter pattern applied to the Dashboard page.
--
-- 1. saved_dashboards — one row per named dashboard: name + owner + visibility
--    + the `layout` blob (a single dashboard's column stack). A "public" row is
--    offered to every caller who can read the registry, INCLUDING the
--    unauthenticated Dash wallboard, which is the whole point: a NOC screen is
--    published once and every wallboard can load it.
--
-- 2. Seeds the new RBAC function key onto every existing role's matrix:
--      savedDashboards — read  = list (own + public) + keep your OWN private
--                                dashboards, which is what the ungated
--                                /me/dashboard already allows;
--                        write = PUBLISH one (it reaches operators who never
--                                built it, and the unauthenticated wallboard);
--                        fullwrite = delete anyone's (housekeeping).
--    Deliberately its own key rather than riding an existing page's gate the
--    way SAVED_FILTER_SCOPES does: the Dashboard page has no function key at
--    all (it is gated per WIDGET), so there was nothing to inherit — and
--    publishing to an unauthenticated wallboard is exactly the capability an
--    admin may want to withhold from someone who may still build their own
--    dashboards. The gate (requirePermission) reads the stored matrix with no
--    admin bypass, so admin MUST be seeded explicitly. updatedAt is bumped so
--    the in-memory role-snapshot cache refetches.

-- ─── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE "saved_dashboards" (
  "id"         TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "ownerId"    TEXT,
  "ownerName"  TEXT NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'private',
  "layout"     JSONB NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "saved_dashboards_pkey" PRIMARY KEY ("id")
);

-- The name is the operator's handle AND the overwrite key (same owner + name =
-- update, so the UI never has to choose between POST and PUT).
CREATE UNIQUE INDEX "saved_dashboards_ownerId_name_key" ON "saved_dashboards"("ownerId", "name");
-- The wallboard's read is "every public row", with no owner to narrow it.
CREATE INDEX "saved_dashboards_visibility_idx" ON "saved_dashboards"("visibility");

-- SET NULL, not CASCADE: a published dashboard outlives the account that
-- published it (the SavedTableFilter rule). ownerName is the surviving label.
ALTER TABLE "saved_dashboards"
  ADD CONSTRAINT "saved_dashboards_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── RBAC function-key seed ─────────────────────────────────────────────────

UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{savedDashboards}', '"none"', true),
      "updatedAt"   = NOW()
  WHERE NOT ("permissions" ? 'savedDashboards');
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{savedDashboards}', '"fullwrite"', true),
      "updatedAt"   = NOW()
  WHERE "name" = 'admin';
-- readonly and user get read: they can load a published dashboard and keep
-- private ones of their own, but not publish to everybody.
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{savedDashboards}', '"read"', true),
      "updatedAt"   = NOW()
  WHERE "name" IN ('readonly', 'user');
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{savedDashboards}', '"write"', true),
      "updatedAt"   = NOW()
  WHERE "name" IN ('networkadmin', 'assetsadmin');
