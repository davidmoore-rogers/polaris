-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "monitoredOperatorSet" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "probeTimeoutMs" INTEGER;

-- CreateTable
CREATE TABLE "monitor_class_overrides" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT,
    "assetType" TEXT NOT NULL,
    "intervalSeconds" INTEGER,
    "failureThreshold" INTEGER,
    "probeTimeoutMs" INTEGER,
    "telemetryIntervalSeconds" INTEGER,
    "systemInfoIntervalSeconds" INTEGER,
    "sampleRetentionDays" INTEGER,
    "telemetryRetentionDays" INTEGER,
    "systemInfoRetentionDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitor_class_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monitor_class_overrides_assetType_idx" ON "monitor_class_overrides"("assetType");

-- CreateIndex
CREATE UNIQUE INDEX "monitor_class_overrides_integrationId_assetType_key" ON "monitor_class_overrides"("integrationId", "assetType");

-- AddForeignKey
ALTER TABLE "monitor_class_overrides" ADD CONSTRAINT "monitor_class_overrides_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "asset_lldp_neighbors_asset_iface_chassis_port_key" RENAME TO "asset_lldp_neighbors_assetId_localIfName_chassisId_portId_key";
