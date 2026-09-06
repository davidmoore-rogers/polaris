-- Asset types registry cutover: replaces the hardcoded `AssetType` Postgres
-- enum with an operator-extensible `asset_type_defs` table. The eight
-- historical enum values (server / switch / router / firewall / workstation
-- / printer / access_point / other) are seeded as `is_built_in=true,
-- is_protected=true` rows so existing installs see no behavior change.
--
-- Asset.assetType becomes a free-form TEXT column validated at write time
-- against the registry by the service layer. MonitorClassOverride.assetType
-- was already TEXT — no column change there.
--
-- Code that switches on assetType string literals (dependencyTreeService,
-- fortinetTopology branches, polling source defaults, topology rendering,
-- inferAssetTypeFromOs) only special-cases the eight built-in names. Custom
-- types fall through to "other"-like generic behavior by design. Documented
-- as a known limitation in polaris-domain-model -> assets-core.md (AssetTypeDef).
--
-- Asset.assetType holds the registry row's `name` literal — not an FK. A
-- non-FK string column lets us keep historical values safely if an admin
-- ever renames a custom type (rename is a separate operation that touches
-- both the registry row and every Asset row referencing the old name; the
-- service layer enforces this transactionally). Built-in rows can't be
-- renamed or deleted (is_protected=true), so behavior special-cases keyed
-- on the eight built-in names remain stable.

-- 1) Create the registry table
CREATE TABLE "asset_type_defs" (
    "id"            TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "label"         TEXT NOT NULL,
    "description"   TEXT,
    "is_built_in"   BOOLEAN NOT NULL DEFAULT false,
    "is_protected"  BOOLEAN NOT NULL DEFAULT false,
    "created_by"    TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "asset_type_defs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_type_defs_name_key" ON "asset_type_defs"("name");

-- 2) Seed the eight built-in types. Labels match the human-facing display
-- strings the frontend has been using; descriptions are short reminders so
-- the Manage-types UI tells operators what the historical bucket is for.
INSERT INTO "asset_type_defs" ("id", "name", "label", "description", "is_built_in", "is_protected", "updatedAt") VALUES
  (gen_random_uuid()::text, 'server',       'Server',        'Physical or virtual host running server workloads.',                   true, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'switch',       'Switch',        'Managed Layer-2/3 switch (FortiSwitch and other vendors).',            true, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'router',       'Router',        'Routing appliance (non-firewall).',                                    true, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'firewall',     'Firewall',      'Perimeter / branch firewall. FortiGates land here.',                   true, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'workstation',  'Workstation',   'Desktop / laptop endpoint.',                                           true, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'printer',      'Printer',       'Network printer / multi-function device.',                             true, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'access_point', 'Access Point',  'Wireless access point (FortiAPs and other vendors).',                  true, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'other',        'Other',         'Default bucket for assets that do not fit the built-in categories.',   true, true, CURRENT_TIMESTAMP);

-- 3) Convert Asset.assetType from enum to TEXT. The USING clause casts the
-- enum value to its text label, which preserves the literal value on every
-- existing row. The default flips from `'other'::AssetType` to `'other'`.
ALTER TABLE "assets" ALTER COLUMN "assetType" DROP DEFAULT;
ALTER TABLE "assets" ALTER COLUMN "assetType" TYPE TEXT USING "assetType"::TEXT;
ALTER TABLE "assets" ALTER COLUMN "assetType" SET DEFAULT 'other';

-- 4) Safety: every existing Asset.assetType value must reference a seeded
-- registry row. Fresh installs all map to the eight built-ins by construction;
-- this guards against a pre-existing custom enum value sneaking in via an
-- earlier hand-edit migration.
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM "assets" a
  LEFT JOIN "asset_type_defs" d ON d."name" = a."assetType"
  WHERE d."id" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'asset_types_registry_cutover: % assets reference an assetType not seeded in asset_type_defs', orphan_count;
  END IF;
END $$;

-- 5) Drop the now-unused AssetType enum
DROP TYPE "AssetType";
