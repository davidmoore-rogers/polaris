-- AssetWirelessStation gains a derived `band` column ("2.4GHz" | "5GHz" |
-- "6GHz"). Band is resolved at scrape time by joining each station's radioId
-- to FORTINET-FORTIAP-MIB::fapRadioTable (fapRadioType + fapRadioChannelOper).
-- Nullable + additive — existing rows backfill on the next system-info scrape.
ALTER TABLE "asset_wireless_stations" ADD COLUMN "band" TEXT;
