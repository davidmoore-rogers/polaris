-- Management-access summary on Asset, read during discovery for Fortinet devices.
-- Shape: { source: "firewall-interface" | "fortiswitch" | "fortiap-profile",
--          interfaceName, profileName, mgmtIp, protocols: string[],
--          https, ssh, snmp, checkedAt }.
-- Single management surface per asset, so a JSON summary fits better than a
-- multi-row current-state table. Monitor/discovery-owned (like lastSystemInfoAt),
-- never projected from AssetSource. Drives the asset slide-over's Open HTTPS /
-- Open SSH buttons and the FortiAP "SNMP not enabled in profile" warning.
ALTER TABLE "assets" ADD COLUMN "managementAccess" JSONB;
