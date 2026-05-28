-- Phase 4 follow-up: remove dormant category="server" entries from the
-- Setting("certificates") JSONB array. After Phase 4 nginx terminates TLS
-- for the lifetime of the install, the server-leaf cert lives at
-- POLARIS_PROXY_CERT_PATH on disk; the legacy in-DB entries were left in
-- place during Phase 4 for rollback safety but the route surface that read
-- or wrote them is gone, so they're load-bearing for nothing.
--
-- CA entries (category="ca") stay — outbound TLS to LDAP / SMTP / archive
-- targets still consults them.
--
-- Safe on installs that never used the in-DB cert path: the WHERE filter
-- yields zero matches and the UPDATE is a no-op.

UPDATE "settings"
SET "value" = COALESCE(
  (
    SELECT jsonb_agg(elem)
    FROM jsonb_array_elements("value") AS elem
    WHERE elem->>'category' IS DISTINCT FROM 'server'
  ),
  '[]'::jsonb
),
"updatedAt" = NOW()
WHERE "key" = 'certificates'
  AND jsonb_typeof("value") = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements("value") AS elem
    WHERE elem->>'category' = 'server'
  );
