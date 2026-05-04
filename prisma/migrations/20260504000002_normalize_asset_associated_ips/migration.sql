-- Normalize Asset.associatedIps from a JSON column into a side table.
-- Read-modify-write of the JSON column on every system-info pass costs
-- two DB round-trips per asset; the side table lets the persist layer
-- delete-and-replace non-manual entries in a single transaction. The
-- read paths (bulk DNS, single DNS lookup, LLDP match index, assets
-- list/get response) join the relation directly.
--
-- API surface unchanged: assets.ts continues to expose the same
-- `associatedIps: [...]` JSON array on the response, serialized from
-- the relation rows.

-- 1. New table
CREATE TABLE "asset_associated_ips" (
    "id"            TEXT NOT NULL,
    "assetId"       TEXT NOT NULL,
    "ip"            TEXT NOT NULL,
    "source"        TEXT NOT NULL,
    "interfaceName" TEXT,
    "mac"           TEXT,
    "ptrName"       TEXT,
    "ptrTtl"        INTEGER,
    "ptrFetchedAt"  TIMESTAMP(3),
    "lastSeen"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeen"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_associated_ips_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_associated_ips_assetId_ip_key" ON "asset_associated_ips" ("assetId", "ip");
CREATE INDEX "asset_associated_ips_assetId_idx" ON "asset_associated_ips" ("assetId");
CREATE INDEX "asset_associated_ips_ip_idx" ON "asset_associated_ips" ("ip");

ALTER TABLE "asset_associated_ips"
  ADD CONSTRAINT "asset_associated_ips_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Backfill from the existing JSON column. Runs once at deploy. Forgiving
-- about shape: skips entries without a usable `ip`, defaults missing
-- `source` to `"manual"` (mirrors the prior frontend default), tolerates
-- malformed `lastSeen` / `ptrFetchedAt` / `ptrTtl` strings by leaving them
-- null. ON CONFLICT DO NOTHING absorbs duplicate IPs within a single
-- asset's array (which would have been a bug pre-migration but exists in
-- the wild).
INSERT INTO "asset_associated_ips" (
    "id", "assetId", "ip", "source",
    "interfaceName", "mac", "ptrName", "ptrTtl", "ptrFetchedAt",
    "lastSeen", "firstSeen"
)
SELECT
    gen_random_uuid()::text,
    a."id",
    e->>'ip',
    COALESCE(NULLIF(e->>'source', ''), 'manual'),
    NULLIF(e->>'interfaceName', ''),
    NULLIF(e->>'mac', ''),
    NULLIF(e->>'ptrName', ''),
    CASE
      WHEN e->>'ptrTtl' ~ '^[0-9]+$' THEN (e->>'ptrTtl')::int
      ELSE NULL
    END,
    CASE
      WHEN e->>'ptrFetchedAt' IS NOT NULL AND length(e->>'ptrFetchedAt') > 0
      THEN to_timestamp(e->>'ptrFetchedAt', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE NULL
    END,
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
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a."associatedIps", '[]'::jsonb)) AS e
WHERE jsonb_typeof(a."associatedIps") = 'array'
  AND e ? 'ip'
  AND e->>'ip' IS NOT NULL
  AND length(e->>'ip') > 0
ON CONFLICT ("assetId", "ip") DO NOTHING;

-- 3. Drop the old column. Prisma migrate runs this in the same transaction
-- as the backfill above, so a backfill failure rolls back the column
-- removal too — no half-migrated state.
ALTER TABLE "assets" DROP COLUMN "associatedIps";
