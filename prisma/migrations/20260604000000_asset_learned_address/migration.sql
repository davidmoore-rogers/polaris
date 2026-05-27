-- Asset.learnedAddress — auto-discovered street address.
--
-- Nullable so existing rows are unchanged. Populated only on firewall assets
-- discovered through an FMG integration whose `fortigateMonitor.addressMetavar`
-- names a populated per-device address metavariable. Distinct from
-- `learnedLocation` (site/controller label) and `snmpLocation` (raw SNMP
-- sysLocation). Surfaced as "Address" on the asset details General tab.

ALTER TABLE "assets" ADD COLUMN "learnedAddress" TEXT;
