-- SD-WAN rules: convert the rules stream from an append-only time-series
-- (detail + hourly + daily rollups, tiered retention) into a CURRENT-STATE
-- table refreshed per scrape — exactly like AssetLldpNeighbor /
-- AssetWirelessStation. We keep one row per (asset, rule) showing the rule's
-- currently-active member; the failover TIMELINE is dropped per product
-- decision (2026-06). This is DESTRUCTIVE and intentional: the rule HISTORY
-- (asset_sdwan_rule_samples + its hourly/daily rollups) is dropped outright.
--
-- The SD-WAN SLA-metrics stream (asset_perf_sla_samples family — perfSla) is
-- left completely untouched as a time-series; only the rules stream changes.
--
-- asset_sdwan_rules is a PLAIN Postgres table (NOT a TimescaleDB hypertable),
-- so a delete-replace-per-asset writer is safe (no compressed-chunk concern).

-- DropTable (rule history — detail + rollups)
DROP TABLE IF EXISTS "asset_sdwan_rule_samples" CASCADE;
DROP TABLE IF EXISTS "asset_sdwan_rule_samples_hourly" CASCADE;
DROP TABLE IF EXISTS "asset_sdwan_rule_samples_daily" CASCADE;

-- CreateTable (current-state)
CREATE TABLE "asset_sdwan_rules" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "ruleId" TEXT,
    "seq" INTEGER,
    "enabled" BOOLEAN,
    "mode" TEXT,
    "criteria" TEXT,
    "healthChecks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dst" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL,
    "selectedMember" TEXT,
    "availableMembers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priorityZones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_sdwan_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "asset_sdwan_rules_assetId_ruleName_key" ON "asset_sdwan_rules"("assetId", "ruleName");
CREATE INDEX "asset_sdwan_rules_assetId_idx" ON "asset_sdwan_rules"("assetId");
