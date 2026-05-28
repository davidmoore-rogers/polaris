-- Phase 4: nginx terminates TLS for the lifetime of the install. The
-- Setting("https") row stored the listener config for the now-deleted Node
-- HTTPS path (port, certId, keyId, redirectHttp); it's dormant data and the
-- API no longer reads or writes it. Drop the row so backups, audits, and the
-- raw Setting table don't carry a ghost config.
--
-- Legacy category="server" entries inside Setting("certificates") are
-- cleaned up in the follow-up migration 20260608000000_drop_legacy_server_certs.

DELETE FROM "settings" WHERE "key" = 'https';
