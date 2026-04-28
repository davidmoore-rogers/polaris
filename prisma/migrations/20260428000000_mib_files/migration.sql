-- MibFile: SNMP MIB modules uploaded by an admin from Server Settings →
-- Identification. Used to resolve vendor-specific OIDs during monitoring.
-- manufacturer NULL  → generic/shared MIB (loaded for every probe).
-- manufacturer SET   → device MIB (loaded only for assets matching the vendor).
-- model NULL with manufacturer SET → applies to all models from that vendor.
CREATE TABLE "mib_files" (
    "id"           TEXT NOT NULL,
    "filename"     TEXT NOT NULL,
    "moduleName"   TEXT NOT NULL,
    "manufacturer" TEXT,
    "model"        TEXT,
    "contents"     TEXT NOT NULL,
    "imports"      TEXT[] DEFAULT ARRAY[]::TEXT[],
    "size"         INTEGER NOT NULL,
    "notes"        TEXT,
    "uploadedBy"   TEXT,
    "uploadedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mib_files_pkey" PRIMARY KEY ("id")
);

-- Composite uniqueness: same module name from same vendor + model can only
-- be uploaded once. Postgres treats NULLs as distinct in unique indexes, so
-- two generic MIBs with the same moduleName are accepted by this constraint
-- alone — that's filtered separately at the service layer.
CREATE UNIQUE INDEX "mib_files_manufacturer_model_moduleName_key"
    ON "mib_files"("manufacturer", "model", "moduleName");

CREATE INDEX "mib_files_manufacturer_model_idx"
    ON "mib_files"("manufacturer", "model");

CREATE INDEX "mib_files_moduleName_idx"
    ON "mib_files"("moduleName");
