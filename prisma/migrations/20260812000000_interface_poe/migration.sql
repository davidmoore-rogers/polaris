-- PoE per-interface state from POWER-ETHERNET-MIB (RFC 3621).
--
-- asset_interface_samples and its two rollups are TimescaleDB hypertables with
-- a compression policy. Plain nullable ADD COLUMN is metadata-only and safe on
-- compressed chunks; adding a DEFAULT is NOT (historically it forces a rewrite,
-- and rewriting a compressed chunk is the bloat failure mode recorded against
-- these tables). No backfill for the same reason -- the standing rule is to
-- never row-UPDATE sample rows that could sit in a compressed chunk. Existing
-- rows simply read NULL, which is also what a non-PoE or REST-polled device
-- writes going forward.

ALTER TABLE "asset_interface_samples"        ADD COLUMN "poeStatus"     TEXT;
ALTER TABLE "asset_interface_samples"        ADD COLUMN "poeClass"      TEXT;

ALTER TABLE "asset_interface_samples_hourly" ADD COLUMN "lastPoeStatus" TEXT;
ALTER TABLE "asset_interface_samples_hourly" ADD COLUMN "lastPoeClass"  TEXT;

ALTER TABLE "asset_interface_samples_daily"  ADD COLUMN "lastPoeStatus" TEXT;
ALTER TABLE "asset_interface_samples_daily"  ADD COLUMN "lastPoeClass"  TEXT;
