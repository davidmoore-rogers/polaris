-- Add AssetIpsecTunnelSample.parentInterface — the FortiOS phase1-interface
-- CMDB `interface` field (e.g. "wan1"), used by the System tab to nest
-- tunnel rows under their parent in the Interfaces table. Existing rows
-- predate the collector change in 65a9914 / c3467d6 so we leave them NULL;
-- the next system-info pass repopulates them.
ALTER TABLE "asset_ipsec_tunnel_samples"
  ADD COLUMN "parentInterface" TEXT;
