-- Remove the vestigial `reservationPush` RBAC function key.
--
-- It was defined in the function-key catalogue but never enforced by any route
-- guard. DHCP reservation push is gated by the `reservations` key (push happens
-- as part of the reservation create/edit path on a push-eligible subnet) and by
-- the per-integration `pushReservations` toggle (gated by `integrations`), so
-- this key controlled nothing — a confusing second matrix row. Strip it from
-- every role's permission matrix so stored data matches the catalogue.
-- `normalizePermissions` already drops unknown keys on any subsequent role
-- write; this makes existing rows clean immediately. updatedAt is bumped so the
-- in-memory role-snapshot cache refetches.
UPDATE "roles"
  SET "permissions" = "permissions" - 'reservationPush',
      "updatedAt"   = NOW()
  WHERE "permissions" ? 'reservationPush';
