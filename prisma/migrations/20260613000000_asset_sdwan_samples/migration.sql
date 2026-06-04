-- SD-WAN monitoring sample streams. FortiOS only — populated by
-- monitoringService.collectSdwanFortinet on the system-info cadence, gated by
-- Integration.config.pullSdwan. Two streams, each with detail + hourly + daily
-- tiers (mirrors the IPsec tunnel sample pipeline):
--   perfSla   — per (health-check, WAN-member link) latency/jitter/packet-loss
--               gauges from /api/v2/monitor/virtual-wan/health-check.
--   sdwanRule — per service-rule member-selection timeline from
--               /api/v2/cmdb/system/sdwan (+ runtime selection when resolvable).
-- Plain Postgres tables (no TimescaleDB hypertable, consistent with every other
-- sample table). Composite PKs include the time column for partition-friendliness.

-- CreateTable
CREATE TABLE "asset_perf_sla_samples" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "healthCheck" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "latencyMs" DOUBLE PRECISION,
    "jitterMs" DOUBLE PRECISION,
    "packetLoss" DOUBLE PRECISION,
    "latencyThresholdMs" DOUBLE PRECISION,
    "jitterThresholdMs" DOUBLE PRECISION,
    "packetLossThreshold" DOUBLE PRECISION,
    "cadence" TEXT,

    CONSTRAINT "asset_perf_sla_samples_pkey" PRIMARY KEY ("id","timestamp")
);

-- CreateTable
CREATE TABLE "asset_sdwan_rule_samples" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    "cadence" TEXT,

    CONSTRAINT "asset_sdwan_rule_samples_pkey" PRIMARY KEY ("id","timestamp")
);

-- CreateTable
CREATE TABLE "asset_perf_sla_samples_hourly" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "healthCheck" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "stateUpCount" INTEGER NOT NULL DEFAULT 0,
    "stateDownCount" INTEGER NOT NULL DEFAULT 0,
    "avgLatencyMs" DOUBLE PRECISION,
    "minLatencyMs" DOUBLE PRECISION,
    "maxLatencyMs" DOUBLE PRECISION,
    "avgJitterMs" DOUBLE PRECISION,
    "minJitterMs" DOUBLE PRECISION,
    "maxJitterMs" DOUBLE PRECISION,
    "avgPacketLoss" DOUBLE PRECISION,
    "minPacketLoss" DOUBLE PRECISION,
    "maxPacketLoss" DOUBLE PRECISION,
    "lastBucketSampleAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_perf_sla_samples_hourly_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_perf_sla_samples_daily" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "healthCheck" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "stateUpCount" INTEGER NOT NULL DEFAULT 0,
    "stateDownCount" INTEGER NOT NULL DEFAULT 0,
    "avgLatencyMs" DOUBLE PRECISION,
    "minLatencyMs" DOUBLE PRECISION,
    "maxLatencyMs" DOUBLE PRECISION,
    "avgJitterMs" DOUBLE PRECISION,
    "minJitterMs" DOUBLE PRECISION,
    "maxJitterMs" DOUBLE PRECISION,
    "avgPacketLoss" DOUBLE PRECISION,
    "minPacketLoss" DOUBLE PRECISION,
    "maxPacketLoss" DOUBLE PRECISION,
    "lastBucketSampleAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_perf_sla_samples_daily_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_sdwan_rule_samples_hourly" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "ruleName" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "statusUpCount" INTEGER NOT NULL DEFAULT 0,
    "statusDownCount" INTEGER NOT NULL DEFAULT 0,
    "selectionChangeCount" INTEGER NOT NULL DEFAULT 0,
    "lastSelectedMember" TEXT,
    "lastStatus" TEXT,
    "lastMode" TEXT,
    "lastAvailableMembers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastBucketSampleAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_sdwan_rule_samples_hourly_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_sdwan_rule_samples_daily" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "ruleName" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "statusUpCount" INTEGER NOT NULL DEFAULT 0,
    "statusDownCount" INTEGER NOT NULL DEFAULT 0,
    "selectionChangeCount" INTEGER NOT NULL DEFAULT 0,
    "lastSelectedMember" TEXT,
    "lastStatus" TEXT,
    "lastMode" TEXT,
    "lastAvailableMembers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastBucketSampleAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_sdwan_rule_samples_daily_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateIndex
CREATE INDEX "asset_perf_sla_samples_assetId_timestamp_idx" ON "asset_perf_sla_samples"("assetId", "timestamp");
CREATE INDEX "asset_perf_sla_samples_assetId_healthCheck_link_timestamp_idx" ON "asset_perf_sla_samples"("assetId", "healthCheck", "link", "timestamp");
CREATE INDEX "asset_sdwan_rule_samples_assetId_timestamp_idx" ON "asset_sdwan_rule_samples"("assetId", "timestamp");
CREATE INDEX "asset_sdwan_rule_samples_assetId_ruleName_timestamp_idx" ON "asset_sdwan_rule_samples"("assetId", "ruleName", "timestamp");

CREATE INDEX "asset_perf_sla_samples_hourly_assetId_bucketStart_idx" ON "asset_perf_sla_samples_hourly"("assetId", "bucketStart");
CREATE INDEX "asset_perf_sla_samples_hourly_assetId_healthCheck_link_buck_idx" ON "asset_perf_sla_samples_hourly"("assetId", "healthCheck", "link", "bucketStart");
CREATE UNIQUE INDEX "asset_perf_sla_samples_hourly_bucketStart_assetId_healthChe_key" ON "asset_perf_sla_samples_hourly"("bucketStart", "assetId", "healthCheck", "link");

CREATE INDEX "asset_perf_sla_samples_daily_assetId_bucketStart_idx" ON "asset_perf_sla_samples_daily"("assetId", "bucketStart");
CREATE INDEX "asset_perf_sla_samples_daily_assetId_healthCheck_link_bucke_idx" ON "asset_perf_sla_samples_daily"("assetId", "healthCheck", "link", "bucketStart");
CREATE UNIQUE INDEX "asset_perf_sla_samples_daily_bucketStart_assetId_healthChec_key" ON "asset_perf_sla_samples_daily"("bucketStart", "assetId", "healthCheck", "link");

CREATE INDEX "asset_sdwan_rule_samples_hourly_assetId_bucketStart_idx" ON "asset_sdwan_rule_samples_hourly"("assetId", "bucketStart");
CREATE INDEX "asset_sdwan_rule_samples_hourly_assetId_ruleName_bucketStar_idx" ON "asset_sdwan_rule_samples_hourly"("assetId", "ruleName", "bucketStart");
CREATE UNIQUE INDEX "asset_sdwan_rule_samples_hourly_bucketStart_assetId_ruleNam_key" ON "asset_sdwan_rule_samples_hourly"("bucketStart", "assetId", "ruleName");

CREATE INDEX "asset_sdwan_rule_samples_daily_assetId_bucketStart_idx" ON "asset_sdwan_rule_samples_daily"("assetId", "bucketStart");
CREATE INDEX "asset_sdwan_rule_samples_daily_assetId_ruleName_bucketStart_idx" ON "asset_sdwan_rule_samples_daily"("assetId", "ruleName", "bucketStart");
CREATE UNIQUE INDEX "asset_sdwan_rule_samples_daily_bucketStart_assetId_ruleName_key" ON "asset_sdwan_rule_samples_daily"("bucketStart", "assetId", "ruleName");

-- AddForeignKey
ALTER TABLE "asset_perf_sla_samples" ADD CONSTRAINT "asset_perf_sla_samples_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_sdwan_rule_samples" ADD CONSTRAINT "asset_sdwan_rule_samples_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_perf_sla_samples_hourly" ADD CONSTRAINT "asset_perf_sla_samples_hourly_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_perf_sla_samples_daily" ADD CONSTRAINT "asset_perf_sla_samples_daily_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_sdwan_rule_samples_hourly" ADD CONSTRAINT "asset_sdwan_rule_samples_hourly_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_sdwan_rule_samples_daily" ADD CONSTRAINT "asset_sdwan_rule_samples_daily_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
