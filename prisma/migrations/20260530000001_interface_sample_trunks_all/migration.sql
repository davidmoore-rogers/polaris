-- trunksAllVlans on AssetInterfaceSample. Distinguishes `set allowed-vlans
-- all` from access ports and explicit-list trunks. Populated only on managed
-- FortiSwitches by the CMDB overlay in monitoringService.collectSystemInfo —
-- reads the FortiOS `allowed-vlans-all` field (newer versions) with fallback
-- to the string sentinel `"all"` in `allowed-vlans` (older versions). Other
-- asset types and the SNMP-only path on non-Fortinet switches stay false.
ALTER TABLE "asset_interface_samples" ADD COLUMN "trunksAllVlans" BOOLEAN NOT NULL DEFAULT FALSE;
