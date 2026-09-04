-- RBAC tightening, 2026-09-04. Three independent changes that all land in the
-- role matrix or the rows a matrix level now filters:
--
--   1. `credentials` gains the OWNERSHIP dimension (the fourth key to carry it,
--      after subnets / reservations / contacts): write = create + edit/delete/
--      test-with your own rows only, fullwrite = any row. That needs a
--      `createdBy` column on the table.
--   2. `assetsProbe` becomes a READ-ONLY key — a probe dials the device and
--      writes nothing in Polaris, so `read` is the whole grant and the two
--      levels above it were dead radio buttons. Stored matrices are folded
--      down to `read`.
--   3. The outage SIMULATION (POST/DELETE /assets/:id/dependency-test) moved
--      off `assetsProbe=write` onto `assetMonitorSettings=fullwrite` — no data
--      change, but it is why (2) does not lose a capability: the one thing on
--      that key that actually wrote is now gated where its own code comment
--      always claimed it was (admin-only).
--
-- Agent deployment moving from `assets=write` to `assets=fullwrite` (and the
-- integration auto-deploy toggle chaining onto the same grant) is a route-layer
-- change with no stored state, so it has no statement here.

-- 1) Credential ownership. Deliberately NOT backfilled: null = unowned, and an
-- unowned credential is reachable only by a fullwrite caller. Backfilling an
-- owner would hand a write-level operator rows they never created.
ALTER TABLE "credentials" ADD COLUMN "createdBy" TEXT;
CREATE INDEX "credentials_createdBy_idx" ON "credentials"("createdBy");

-- 2) Fold assetsProbe down into its new ladder. Anything at or above `read`
-- becomes `read` (the level that now carries probe-now / SNMP walk / DNS
-- lookup); `none` is left alone. `normalizePermissions` clamps the same way on
-- every subsequent role write, and `permissionOf` clamps on read, so a session
-- snapshot stamped before this deploy resolves correctly too — this statement
-- is what makes the STORED matrix agree with what the UI will render.
UPDATE "roles"
SET "permissions" = jsonb_set("permissions", '{assetsProbe}', '"read"'),
    "updatedAt"   = CURRENT_TIMESTAMP
WHERE "permissions" ->> 'assetsProbe' IN ('write', 'fullwrite');
