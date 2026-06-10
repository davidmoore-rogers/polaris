-- Interface L3 addressing mode (static / dhcp / pppoe).
--
-- Adds a nullable `addressingMode` column to the interface-sample hypertable.
-- Populated only on the FortiOS REST path from CMDB `system/interface.mode`;
-- SNMP and the Polaris Agent have no equivalent and leave it NULL (rendered as
-- "—" in the System-tab interface table, like the FortiSwitch-only VLAN
-- columns). Config metadata — surfaced only in the live snapshot, never rolled
-- up, so the rollup tables are intentionally untouched.
--
-- IMPORTANT — TimescaleDB / compressed-hypertable note:
--   `asset_interface_samples` is a hypertable with an active compression
--   policy. A NULLABLE, DEFAULTLESS column is the metadata-only form that
--   TimescaleDB supports even when compressed chunks exist (no chunk rewrite,
--   no decompression). Existing rows are not backfilled (UPDATE is disallowed
--   on compressed chunks and they age out via drop_chunks anyway), so they
--   keep addressingMode = NULL. Validate against a restored production-sized
--   snapshot (with IT/DBA) before running on prod — compressed-chunk ADD COLUMN
--   behavior is TimescaleDB-version-specific.

ALTER TABLE "asset_interface_samples" ADD COLUMN "addressingMode" TEXT;
