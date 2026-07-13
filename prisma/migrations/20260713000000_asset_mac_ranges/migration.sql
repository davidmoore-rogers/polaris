-- Add range support to the AssetMacAddress side table. A row with a non-null
-- "macEnd" represents the inclusive contiguous MAC range [mac, macEnd] —
-- written by the interface-scrape fold so a switch with 48 sequentially-
-- allocated port MACs stores one row instead of 48. All existing rows stay
-- single-MAC (macEnd NULL). Both bounds are canonical colon-uppercase, so
-- lexicographic comparison == numeric comparison and range containment is a
-- plain BETWEEN over the existing text columns.
ALTER TABLE "asset_mac_addresses" ADD COLUMN "macEnd" TEXT;
