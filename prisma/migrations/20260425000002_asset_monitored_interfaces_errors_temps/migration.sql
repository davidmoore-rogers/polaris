-- Asset.monitoredInterfaces: ifNames the operator pinned for fast-cadence polling
ALTER TABLE "assets"
    ADD COLUMN "monitoredInterfaces" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Cumulative interface error counters (IF-MIB ifInErrors / ifOutErrors;
-- FortiOS errors_in / errors_out)
ALTER TABLE "asset_interface_samples"
    ADD COLUMN "inErrors"  BIGINT,
    ADD COLUMN "outErrors" BIGINT;

-- Per-sensor temperature samples (FortiOS sensor-info, SNMP ENTITY-SENSOR-MIB)
CREATE TABLE "asset_temperature_samples" (
    "id"         TEXT         NOT NULL,
    "assetId"    TEXT         NOT NULL,
    "timestamp"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sensorName" TEXT         NOT NULL,
    "celsius"    DOUBLE PRECISION,

    CONSTRAINT "asset_temperature_samples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_temperature_samples_assetId_timestamp_idx"
    ON "asset_temperature_samples" ("assetId", "timestamp");

CREATE INDEX "asset_temperature_samples_assetId_sensorName_timestamp_idx"
    ON "asset_temperature_samples" ("assetId", "sensorName", "timestamp");

ALTER TABLE "asset_temperature_samples"
    ADD CONSTRAINT "asset_temperature_samples_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
