-- Phase 4: nginx terminates TLS for the lifetime of the install. The
-- Setting("https") row stored the listener config for the now-deleted Node
-- HTTPS path (port, certId, keyId, redirectHttp); it's dormant data and the
-- API no longer reads or writes it. Drop the row so backups, audits, and the
-- raw Setting table don't carry a ghost config.
--
-- Setting("certificates") rows with category="server" are left in place on
-- purpose: they may still be present in older installs but are inert (the
-- cert-upload + generate routes are gone). An operator can clean them up
-- manually via SQL if desired; we don't want a migration that destroys
-- backup-restorable cert data without explicit operator action.

DELETE FROM "settings" WHERE "key" = 'https';
