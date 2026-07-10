-- vCenter integration: VMs, ESXi hosts, datastores.
--
-- 1) `vcenter_datastores` — current-state datastore inventory, one row per
--    (integration, datastore MoRef), delete-replaced per discovery run
--    (AssetSdwanRule / AssetLldpNeighbor pattern; plain table, NOT a
--    hypertable — no history by design).
-- 2) `assets.virtualization` — per-asset current-state virtualization blob
--    (fortinetTopology precedent), single writer = syncVcenterDevices.
-- 3) Two new built-in asset types: `virtual_machine` (vCenter-discovered VMs)
--    and `hypervisor` (ESXi hosts). ON CONFLICT DO UPDATE adopts a
--    pre-existing operator-created custom type of the same name instead of
--    failing; type-branching code paths only special-case the eight
--    historical built-ins, so these two get generic "other"-like behavior
--    everywhere except the vCenter-specific surfaces (by design).

-- 1) Current-state datastore table
CREATE TABLE "vcenter_datastores" (
    "id"               TEXT NOT NULL,
    "integrationId"    TEXT NOT NULL,
    "moref"            TEXT NOT NULL,
    "name"             TEXT NOT NULL,
    "dsType"           TEXT,
    "capacityBytes"    BIGINT,
    "freeBytes"        BIGINT,
    "provisionedBytes" BIGINT,
    "accessible"       BOOLEAN,
    "hostMorefs"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "backing"          JSONB,
    "backingLabel"     TEXT,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "vcenter_datastores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vcenter_datastores_integrationId_moref_key" ON "vcenter_datastores"("integrationId", "moref");
CREATE INDEX "vcenter_datastores_integrationId_idx" ON "vcenter_datastores"("integrationId");

ALTER TABLE "vcenter_datastores"
  ADD CONSTRAINT "vcenter_datastores_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "integrations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) Per-asset virtualization blob
ALTER TABLE "assets" ADD COLUMN "virtualization" JSONB;

-- 3) New built-in asset types. DO UPDATE (not DO NOTHING) so an operator-
-- created custom type of the same name is adopted as the built-in — it keeps
-- its id (Asset.assetType references the name, not the id) and gains the
-- protected flags; label/description converge on the canonical strings.
INSERT INTO "asset_type_defs" ("id", "name", "label", "description", "is_built_in", "is_protected", "updatedAt") VALUES
  (gen_random_uuid()::text, 'virtual_machine', 'Virtual Machine', 'vCenter-discovered virtual machine. Carries a VM→host dependency link and hypervisor-view telemetry.', true, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'hypervisor',      'Hypervisor',      'Virtualization host (ESXi). Parents its VMs in the dependency tree; datastores render on its details view.', true, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "label"        = EXCLUDED."label",
  "description"  = EXCLUDED."description",
  "is_built_in"  = true,
  "is_protected" = true,
  "updatedAt"    = CURRENT_TIMESTAMP;
