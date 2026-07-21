-- Automations redesign: rename the notification RBAC keys and seed the new
-- script-execution key.
--
--   notifications          -> alerts                (view/ack/clear triggered instances)
--   notificationManagement -> automationManagement  (automation + delivery-channel CRUD)
--   + automationScripts                             (script registry + script actions)
--
-- `automationScripts` is RCE-equivalent (server scripts run as the polaris
-- service user; agent scripts run as root/LocalSystem on managed assets), so
-- it is seeded `fullwrite` ONLY for admin-equivalent roles (users=fullwrite
-- AND roles=fullwrite — the same predicate as isAdminEquivalentPermissions /
-- the lastAdminEquivalent guard) and `none` everywhere else, including the
-- seeded api-* token roles.
--
-- Every row is rewritten (not just rows carrying the old keys) so the new
-- automationScripts key is present on all matrices; updatedAt is bumped so
-- in-memory role-snapshot caches refetch. Runtime code additionally resolves
-- the legacy key names from pre-deploy session snapshots via
-- permissions.ts:LEGACY_KEY_ALIASES, so live sessions keep working.
UPDATE "roles"
  SET "permissions" =
        ("permissions" - 'notifications' - 'notificationManagement')
        || jsonb_build_object('alerts',
             COALESCE("permissions"->'notifications', '"none"'::jsonb))
        || jsonb_build_object('automationManagement',
             COALESCE("permissions"->'notificationManagement', '"none"'::jsonb))
        || jsonb_build_object('automationScripts',
             CASE WHEN "permissions"->>'users' = 'fullwrite'
                   AND "permissions"->>'roles' = 'fullwrite'
                  THEN '"fullwrite"'::jsonb
                  ELSE '"none"'::jsonb END),
      "updatedAt" = NOW();
