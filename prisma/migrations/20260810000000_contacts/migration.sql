-- Address book: named email addresses Polaris can route alerts to, each
-- optionally owning a set of devices.
--
-- 1. contacts — email (unique, stored lower-cased) + name/description, plus the
--    MaintenanceSchedule target shape: assetCriteria (tagAssignmentService
--    vocabulary) unioned with explicit assetIds pins. That union is what makes
--    "notify the contacts responsible for the triggering device" resolvable at
--    fire time against a single asset.
-- 2. Seeds the new RBAC function key onto every existing role's matrix:
--      contacts — the address book. Ownership-dimensioned like subnets /
--                 reservations: read = browse, write = add + edit/delete the
--                 rows you created (createdBy), fullwrite = manage anyone's.
--    The gate (requirePermission) reads the stored matrix with no admin bypass,
--    so admin MUST be seeded explicitly. updatedAt is bumped so the in-memory
--    role-snapshot cache refetches.

-- ─── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE "contacts" (
  "id"            TEXT NOT NULL,
  "email"         TEXT NOT NULL,
  "name"          TEXT,
  "description"   TEXT,
  "assetCriteria" JSONB,
  "assetIds"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- One row per address. Writes lower-case before insert, so this also enforces
-- case-insensitive uniqueness.
CREATE UNIQUE INDEX "contacts_email_key" ON "contacts"("email");

-- The ownership gate filters by createdBy on every write-level list/edit.
CREATE INDEX "contacts_createdBy_idx" ON "contacts"("createdBy");

-- ─── RBAC function-key seed ─────────────────────────────────────────────────

-- contacts: default none for any role missing it, then raise the built-ins.
-- admin manages everyone's; readonly browses; the three write-capable built-ins
-- get "write" so an operator can add contacts and curate their own without
-- being able to delete a colleague's.
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{contacts}', '"none"', true),
      "updatedAt"   = NOW()
  WHERE NOT ("permissions" ? 'contacts');
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{contacts}', '"fullwrite"', true),
      "updatedAt"   = NOW()
  WHERE "name" = 'admin';
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{contacts}', '"read"', true),
      "updatedAt"   = NOW()
  WHERE "name" = 'readonly';
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{contacts}', '"write"', true),
      "updatedAt"   = NOW()
  WHERE "name" IN ('networkadmin', 'assetsadmin', 'user');
