-- Switch-port VLAN config on AssetInterfaceSample (detail tier only).
-- Populated by the FortiSwitch path in monitoringService.collectSystemInfoSnmp
-- by overlaying the parent FortiGate's managed-switch CMDB ports table onto
-- the SNMP-collected interface rows.
--
-- nativeVlan: untagged PVID (FortiOS port.vlan)
-- taggedVlans: resolved tagged set (allowed-vlans minus untagged-vlans),
--              expanded to integer ids
--
-- Rollup tables intentionally skip these — VLAN config is current-state,
-- not a counter, so the hourly/daily aggregate shape doesn't apply.
ALTER TABLE "asset_interface_samples" ADD COLUMN "nativeVlan"  INTEGER;
ALTER TABLE "asset_interface_samples" ADD COLUMN "taggedVlans" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
