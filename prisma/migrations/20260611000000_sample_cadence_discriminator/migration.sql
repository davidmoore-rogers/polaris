-- Cadence discriminator for selection-aware sample retention.
--
-- Adds a nullable `cadence` ("fast" | "slow") column to the three system-info
-- sample hypertables. Operator-pinned entities (monitoredInterfaces /
-- monitoredStorage / monitoredIpsecTunnels) are re-walked on the fast
-- response-time cadence and stamped "fast"; the full system-info scrape stamps
-- "slow". Retention then keeps "fast" (selected) rows at full retention with
-- rollups and "slow"/unselected rows for only 24h with no rollup.
--
-- IMPORTANT — TimescaleDB / compressed-hypertable note:
--   These tables are hypertables with an active compression policy. Adding a
--   NULLABLE, DEFAULTLESS column is the metadata-only form that TimescaleDB
--   supports even when compressed chunks exist (no chunk rewrite, no
--   decompression). We deliberately do NOT backfill existing rows: there are
--   ~1.2B and they live in compressed chunks (UPDATE is not allowed there).
--   Existing rows keep cadence = NULL and are treated as "slow" everywhere, so
--   the next prune ages them out to the 24h window via drop_chunks.
--   This migration MUST be validated against a restored production-sized
--   snapshot (with IT/DBA) before it runs on prod — compressed-chunk ADD COLUMN
--   behavior is TimescaleDB-version-specific.

ALTER TABLE "asset_interface_samples"    ADD COLUMN "cadence" TEXT;
ALTER TABLE "asset_storage_samples"      ADD COLUMN "cadence" TEXT;
ALTER TABLE "asset_ipsec_tunnel_samples" ADD COLUMN "cadence" TEXT;
