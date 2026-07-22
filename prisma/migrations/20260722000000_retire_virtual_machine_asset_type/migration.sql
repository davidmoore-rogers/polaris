-- Retire the `virtual_machine` built-in asset type (2026-07). vCenter-
-- discovered VMs are typed plain `server` — the VM identity lives in the
-- Asset.virtualization blob + the vcenter-vm AssetSource row, and the vCenter
-- integration's per-class config keeps its vmMonitor block (dispatched by
-- integration type, not by a dedicated asset type). `hypervisor` stays.
--
-- Ordering: consumers first, registry row last, so a crash mid-migration
-- never leaves assets typed with a name the registry no longer knows.

-- 1) Retype existing VM assets.
UPDATE "assets" SET "assetType" = 'server' WHERE "assetType" = 'virtual_machine';

-- 2) Pending vCenter asset conflicts snapshot the proposed type in JSON;
--    rewrite so accepting an old conflict doesn't fail write-time registry
--    validation.
UPDATE "conflicts"
SET "proposedAssetFields" = jsonb_set("proposedAssetFields", '{assetType}', '"server"')
WHERE "proposedAssetFields" ->> 'assetType' = 'virtual_machine';

-- 3) Monitor class overrides are keyed by assetType (unique per
--    (integrationId, assetType), where integrationId NULL = manual scope).
--    Retype a virtual_machine override to server where that slot is free;
--    where a server override already exists for the same scope, the server
--    row wins and the virtual_machine row is dropped.
UPDATE "monitor_class_overrides" o
SET "assetType" = 'server'
WHERE o."assetType" = 'virtual_machine'
  AND NOT EXISTS (
    SELECT 1 FROM "monitor_class_overrides" s
    WHERE s."assetType" = 'server'
      AND s."integrationId" IS NOT DISTINCT FROM o."integrationId"
  );
DELETE FROM "monitor_class_overrides" WHERE "assetType" = 'virtual_machine';

-- 4) Operator-defined JSON that can reference the type by name: tag
--    auto-assignment criteria ({ rules: [{ field:"assetType", values[] }] })
--    and notification-rule scopes ({ assetTypes: [...] }). A JSON-string
--    text replace is deliberate — it covers both shapes without depending
--    on rule ordering; a literal "virtual_machine" value in some other rule
--    field is not a realistic collision.
UPDATE "tags"
SET "criteria" = replace("criteria"::text, '"virtual_machine"', '"server"')::jsonb
WHERE "criteria"::text LIKE '%"virtual_machine"%';

UPDATE "notification_rules"
SET "scope" = replace("scope"::text, '"virtual_machine"', '"server"')::jsonb
WHERE "scope"::text LIKE '%"virtual_machine"%';

-- 5) Drop the registry row (seedBuiltInAssetTypes no longer self-heals it).
DELETE FROM "asset_type_defs" WHERE "name" = 'virtual_machine';
