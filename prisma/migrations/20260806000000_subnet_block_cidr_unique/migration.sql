-- Subnet overlap invariant: DB-level backstop for business rules 1 + 2.
--
-- createSubnet / allocateNextSubnet / bulkAllocate / the DHCP-discovery create
-- all enforce "no overlapping subnets in a block" in application code. Until
-- 2026-08 that was a check-then-insert with nothing serializing the two halves,
-- so two concurrent writers both passed the check and both inserted. The fix has
-- two layers:
--
--   1. A per-block advisory transaction lock taken by every subnet writer
--      (lockBlockForSubnetWrites / createSubnetRowChecked in
--      services/subnetService.ts). This is the exact guard, covering true
--      overlap as well as exact duplicates.
--   2. This UNIQUE index, which catches the exact-duplicate case — the usual
--      race outcome, since two "next available" picks return the SAME cidr —
--      even from a future code path that forgets the lock.
--
-- There is deliberately no exclusion constraint for general overlap: stock
-- PostgreSQL has no GiST-indexable overlap operator for inet/cidr (btree_gist's
-- gist_inet_ops covers the btree operators, not `&&`), so
-- `EXCLUDE (blockId WITH =, inet(cidr) WITH &&)` does not build without a
-- third-party extension. Layer 1 is the real guard.
--
-- An install that already carries duplicate (blockId, cidr) rows from the old
-- race cannot take a UNIQUE index. Rather than fail the migration and block the
-- upgrade, this detects that case, leaves the index off, and raises a WARNING
-- naming the offenders. The `enforceSubnetUniqueIndex` startup job re-attempts
-- the index on every boot, so the index appears on its own once an operator has
-- merged or deleted the duplicates — no second migration needed.

DO $$
DECLARE
  dup_count integer;
  dup_sample text;
BEGIN
  SELECT count(*), string_agg(DISTINCT cidr, ', ' ORDER BY cidr)
    INTO dup_count, dup_sample
  FROM (
    SELECT "blockId", cidr
    FROM "subnets"
    GROUP BY "blockId", cidr
    HAVING count(*) > 1
  ) d;

  IF COALESCE(dup_count, 0) > 0 THEN
    RAISE WARNING 'subnets: % duplicate (blockId, cidr) group(s) present, so subnets_block_cidr_key was NOT created. Duplicate CIDRs: %. Merge or delete the duplicates; the enforceSubnetUniqueIndex startup job adds the index automatically on the next boot after they are gone.',
      dup_count, dup_sample;
  ELSE
    -- IF NOT EXISTS so the statement is re-runnable. Prisma applies a migration
    -- once, but an operator recovering a half-applied migration (or the
    -- enforceSubnetUniqueIndex job having already created the index on a boot
    -- between `git pull` and `migrate deploy`) would otherwise hit a hard
    -- "relation already exists" failure here.
    CREATE UNIQUE INDEX IF NOT EXISTS "subnets_block_cidr_key" ON "subnets" ("blockId", cidr);
  END IF;
END $$;
