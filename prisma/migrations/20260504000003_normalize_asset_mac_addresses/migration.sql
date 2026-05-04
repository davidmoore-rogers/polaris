-- Normalize Asset.macAddresses from a JSON column into a side table.
-- Removes the in-memory JSON merge that every discovery write site did
-- (load array, find-or-push by mac, sort, write back) and replaces it
-- with indexed upserts via the (assetId, mac) unique key. Primary `Asset.macAddress`
-- scalar column stays — that's the asset's "current" MAC. The side table
-- holds the full history, populated by every MAC-aware source.
--
-- API surface unchanged: assets.ts list/get continues to expose
-- `macAddresses: [...]` as a JSON array on the response, serialized from
-- the relation rows.

-- 1. New table
CREATE TABLE "asset_mac_addresses" (
    "id"         TEXT NOT NULL,
    "assetId"    TEXT NOT NULL,
    "mac"        TEXT NOT NULL,
    "source"     TEXT NOT NULL,
    "device"     TEXT,
    "subnetCidr" TEXT,
    "subnetName" TEXT,
    "lastSeen"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeen"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_mac_addresses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_mac_addresses_assetId_mac_key" ON "asset_mac_addresses" ("assetId", "mac");
CREATE INDEX "asset_mac_addresses_assetId_idx" ON "asset_mac_addresses" ("assetId");
CREATE INDEX "asset_mac_addresses_mac_idx" ON "asset_mac_addresses" ("mac");

ALTER TABLE "asset_mac_addresses"
  ADD CONSTRAINT "asset_mac_addresses_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Backfill from the existing JSON column. Forgiving about shape: skips
-- entries without a usable `mac`, defaults missing `source` to `"unknown"`,
-- tolerates malformed `lastSeen` strings by falling back to NOW(). MAC
-- normalized to colon-uppercase before insert. ON CONFLICT DO NOTHING
-- absorbs duplicate MACs within a single asset's array (which would have
-- been a bug pre-migration but exists in the wild from buggy older code).
INSERT INTO "asset_mac_addresses" (
    "id", "assetId", "mac", "source",
    "device", "subnetCidr", "subnetName",
    "lastSeen", "firstSeen"
)
SELECT
    gen_random_uuid()::text,
    a."id",
    -- Normalize: strip non-hex chars, uppercase, then re-format with colons.
    -- Skip rows where the result isn't 12 hex chars.
    upper(regexp_replace(regexp_replace(e->>'mac', '[^0-9A-Fa-f]', '', 'g'),
                         '^(..)(..)(..)(..)(..)(..)$',
                         '\1:\2:\3:\4:\5:\6')),
    COALESCE(NULLIF(e->>'source', ''), 'unknown'),
    NULLIF(e->>'device', ''),
    NULLIF(e->>'subnetCidr', ''),
    NULLIF(e->>'subnetName', ''),
    COALESCE(
      CASE
        WHEN e->>'lastSeen' IS NOT NULL AND length(e->>'lastSeen') > 0
        THEN to_timestamp(e->>'lastSeen', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ELSE NULL
      END,
      CURRENT_TIMESTAMP
    ),
    COALESCE(
      CASE
        WHEN e->>'lastSeen' IS NOT NULL AND length(e->>'lastSeen') > 0
        THEN to_timestamp(e->>'lastSeen', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ELSE NULL
      END,
      CURRENT_TIMESTAMP
    )
FROM "assets" a
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a."macAddresses", '[]'::jsonb)) AS e
WHERE jsonb_typeof(a."macAddresses") = 'array'
  AND e ? 'mac'
  AND e->>'mac' IS NOT NULL
  AND length(regexp_replace(e->>'mac', '[^0-9A-Fa-f]', '', 'g')) = 12
ON CONFLICT ("assetId", "mac") DO NOTHING;

-- 3. Drop the old column. Same Prisma-migrate transaction as the backfill,
-- so a failure during backfill rolls the column drop back too.
ALTER TABLE "assets" DROP COLUMN "macAddresses";
