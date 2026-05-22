-- Monitor-override cutover.
--
-- Replaces the legacy `monitoredOperatorSet` ("operator ever touched this")
-- with `monitorOverride` ("operator's current `monitored` choice diverges
-- from the integration's per-class addAsMonitored"). The new field models
-- convergence: the moment the operator's choice matches the integration's
-- current flag the override auto-clears, so a fleet-wide auto-monitor flip
-- on or off can sweep affected assets cleanly while still protecting
-- explicit operator overrides.
--
-- Backfill rule: monitorOverride = (monitored XOR addAsMonitored) for the
-- asset's resolved class, where addAsMonitored is read from the
-- discovering integration's config JSON. Assets with no
-- discoveredByIntegrationId, or whose assetType doesn't map to a per-class
-- block, default to false.

ALTER TABLE "assets" ADD COLUMN "monitorOverride" BOOLEAN NOT NULL DEFAULT false;

UPDATE "assets" a
SET "monitorOverride" = (
  a."monitored" IS DISTINCT FROM COALESCE(
    CASE a."assetType"
      WHEN 'firewall'     THEN (i."config" #>> '{fortigateMonitor,addAsMonitored}')::boolean
      WHEN 'switch'       THEN (i."config" #>> '{fortiswitchMonitor,addAsMonitored}')::boolean
      WHEN 'access_point' THEN (i."config" #>> '{fortiapMonitor,addAsMonitored}')::boolean
      WHEN 'workstation'  THEN (i."config" #>> '{workstationMonitor,addAsMonitored}')::boolean
      WHEN 'server'       THEN (i."config" #>> '{serverMonitor,addAsMonitored}')::boolean
      ELSE NULL
    END,
    false
  )
)
FROM "integrations" i
WHERE a."discoveredByIntegrationId" = i."id"
  AND a."assetType" IN ('firewall', 'switch', 'access_point', 'workstation', 'server');

ALTER TABLE "assets" DROP COLUMN "monitoredOperatorSet";
