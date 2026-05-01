-- Operator-uploaded device icons. Used by the Device Map's topology graph
-- (and potentially other render surfaces) to represent specific hardware
-- models or asset types. Resolution at render time: model exact match
-- (manufacturer/model), then model alone, then assetType — see
-- deviceIconService.resolveIconForAsset().

CREATE TABLE "device_icons" (
    "id"         TEXT         NOT NULL,
    "scope"      TEXT         NOT NULL,
    "key"        TEXT         NOT NULL,
    "filename"   TEXT         NOT NULL,
    "mimeType"   TEXT         NOT NULL,
    "data"       BYTEA        NOT NULL,
    "size"       INTEGER      NOT NULL,
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_icons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_icons_scope_key_key" ON "device_icons" ("scope", "key");
CREATE INDEX "device_icons_scope_idx" ON "device_icons" ("scope");
