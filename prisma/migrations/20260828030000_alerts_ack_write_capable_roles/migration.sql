-- Acknowledging an alert is allowed for everyone except read-only.
--
-- The `alerts` key ladder is read=view / write=acknowledge / fullwrite=clear,
-- and the built-in roles already matched that policy (admin+assetsadmin
-- fullwrite, networkadmin+user write, readonly read). Custom roles did not:
-- `alerts` came out of the role editor at whatever the admin picked, and the
-- pre-2026-06 backfill defaulted roles missing the key to plain `read` — so an
-- operator who could edit assets, push reservations or run discovery could see
-- an alert and not acknowledge it.
--
-- This raises `alerts` to `write` for every role that already holds write or
-- fullwrite on ANY other function key: if you may change something in Polaris,
-- you may acknowledge an alert about it. Roles that hold no write anywhere are
-- genuinely read-only and keep their level — the built-in `readonly` role by
-- construction (every key is read or none), plus any custom view-only role.
-- Roles already at write/fullwrite are untouched.
--
-- One-time data bump, not a runtime floor: the level stays admin-editable in
-- the Roles editor afterward. `updatedAt` is bumped so the in-memory
-- role-snapshot cache (bumpRoleVersion / permissions.ts) refetches and live
-- sessions pick the level up on their next request.
UPDATE "roles" r
   SET "permissions" = jsonb_set(r."permissions", '{alerts}', '"write"', true),
       "updatedAt"   = NOW()
 WHERE COALESCE(r."permissions"->>'alerts', 'none') IN ('none', 'read')
   AND EXISTS (
     SELECT 1
       FROM jsonb_each_text(r."permissions") AS p(key, value)
      WHERE p.key <> 'alerts'
        AND p.value IN ('write', 'fullwrite')
   );
