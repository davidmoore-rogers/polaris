-- Index asset_fortigate_sightings by the IP the sighting recorded.
--
-- Every existing consumer reaches these rows through assetId (the asset
-- slide-over's sightings list, the freshest-gate resolution), so the table has
-- never needed an IP-keyed index. The Add Asset form's IP cross-reference asks
-- the opposite question -- "which gate has seen THIS address" -- which without
-- this index is a sequential scan on a table carrying one row per (asset,
-- gate), run from a debounced keystroke handler.
CREATE INDEX IF NOT EXISTS "asset_fortigate_sightings_ipAddress_idx"
  ON "asset_fortigate_sightings" ("ipAddress");
