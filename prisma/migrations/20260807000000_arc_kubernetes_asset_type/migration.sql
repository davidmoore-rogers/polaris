-- Azure Arc phase 4: Arc-enabled Kubernetes.
--
-- Adds the `kubernetes_cluster` built-in asset type. Unlike the Arc phases
-- before it (VMware/SCVMM placement and SQL Server instances, both of which
-- fold into an existing machine's observed blob), a connected cluster is a
-- genuinely new entity and needs its own type.
--
-- ON CONFLICT DO UPDATE adopts a pre-existing operator-created custom type of
-- the same name rather than failing the upgrade — the same posture the vCenter
-- migration (20260709000000) took for `hypervisor`.
--
-- LOCKSTEP: this INSERT alone is not enough. `seedBuiltInAssetTypes` skips any
-- seed whose name is absent from BUILT_IN_ASSET_TYPES, so the name must ALSO
-- be added to src/utils/assetTypes.ts AND to BUILT_IN_SEEDS in
-- src/services/assetTypeService.ts, or fresh Docker volumes and restored
-- backups silently come up without it.
--
-- Type-branching code paths special-case only the Fortinet built-ins, so a
-- cluster gets generic "other"-like behavior everywhere except the Arc
-- surfaces that key on it explicitly (by design).

INSERT INTO "asset_type_defs" ("id", "name", "label", "description", "is_built_in", "is_protected", "updatedAt") VALUES
  (gen_random_uuid()::text, 'kubernetes_cluster', 'Kubernetes Cluster', 'Azure Arc-enabled Kubernetes cluster. Discovered as a single asset; it runs no Polaris Agent and reports no interfaces or storage.', true, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "label"        = EXCLUDED."label",
  "description"  = EXCLUDED."description",
  "is_built_in"  = true,
  "is_protected" = true,
  "updatedAt"    = CURRENT_TIMESTAMP;
