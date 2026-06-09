-- Drop the ON DELETE CASCADE foreign key from every append-only sample/rollup
-- time-series table to Asset.
--
-- Why: these tables are TimescaleDB hypertables. A cascade DELETE (from any
-- asset deletion — merge jobs, manual delete, decommission) that matched rows
-- in a COMPRESSED chunk forced TimescaleDB to decompress the whole chunk into
-- its rowstore heap, leaving multi-GB of un-truncatable low-density bloat (prod
-- incident 2026-06-08). There is no compression-safe way to delete specific
-- rows from a compressed chunk, so we stop trying: deleting an Asset now leaves
-- its sample rows orphaned (assetId points at a gone Asset, never queried), and
-- they age out the only compression-safe way — whole-chunk drop_chunks on the
-- normal retention schedule. assetId stays as a plain indexed column.
--
-- DROP CONSTRAINT is metadata-only: instant, no table/chunk rewrite.

-- DropForeignKey
ALTER TABLE "asset_monitor_samples" DROP CONSTRAINT IF EXISTS "asset_monitor_samples_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_telemetry_samples" DROP CONSTRAINT IF EXISTS "asset_telemetry_samples_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_interface_samples" DROP CONSTRAINT IF EXISTS "asset_interface_samples_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_temperature_samples" DROP CONSTRAINT IF EXISTS "asset_temperature_samples_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_ipsec_tunnel_samples" DROP CONSTRAINT IF EXISTS "asset_ipsec_tunnel_samples_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_perf_sla_samples" DROP CONSTRAINT IF EXISTS "asset_perf_sla_samples_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_sdwan_rule_samples" DROP CONSTRAINT IF EXISTS "asset_sdwan_rule_samples_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_custom_widget_samples" DROP CONSTRAINT IF EXISTS "asset_custom_widget_samples_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_storage_samples" DROP CONSTRAINT IF EXISTS "asset_storage_samples_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_monitor_samples_hourly" DROP CONSTRAINT IF EXISTS "asset_monitor_samples_hourly_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_monitor_samples_daily" DROP CONSTRAINT IF EXISTS "asset_monitor_samples_daily_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_telemetry_samples_hourly" DROP CONSTRAINT IF EXISTS "asset_telemetry_samples_hourly_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_telemetry_samples_daily" DROP CONSTRAINT IF EXISTS "asset_telemetry_samples_daily_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_temperature_samples_hourly" DROP CONSTRAINT IF EXISTS "asset_temperature_samples_hourly_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_temperature_samples_daily" DROP CONSTRAINT IF EXISTS "asset_temperature_samples_daily_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_interface_samples_hourly" DROP CONSTRAINT IF EXISTS "asset_interface_samples_hourly_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_interface_samples_daily" DROP CONSTRAINT IF EXISTS "asset_interface_samples_daily_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_storage_samples_hourly" DROP CONSTRAINT IF EXISTS "asset_storage_samples_hourly_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_storage_samples_daily" DROP CONSTRAINT IF EXISTS "asset_storage_samples_daily_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_ipsec_tunnel_samples_hourly" DROP CONSTRAINT IF EXISTS "asset_ipsec_tunnel_samples_hourly_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_ipsec_tunnel_samples_daily" DROP CONSTRAINT IF EXISTS "asset_ipsec_tunnel_samples_daily_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_perf_sla_samples_hourly" DROP CONSTRAINT IF EXISTS "asset_perf_sla_samples_hourly_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_perf_sla_samples_daily" DROP CONSTRAINT IF EXISTS "asset_perf_sla_samples_daily_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_sdwan_rule_samples_hourly" DROP CONSTRAINT IF EXISTS "asset_sdwan_rule_samples_hourly_assetId_fkey";

-- DropForeignKey
ALTER TABLE "asset_sdwan_rule_samples_daily" DROP CONSTRAINT IF EXISTS "asset_sdwan_rule_samples_daily_assetId_fkey";

