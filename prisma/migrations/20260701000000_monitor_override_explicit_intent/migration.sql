-- Monitor-override → explicit operator intent.
--
-- The original cutover (20260529000000) re-derived `monitorOverride` as the
-- raw (monitored XOR addAsMonitored) divergence, and a boot job + the
-- integration-save handler re-ran that derivation continuously. The effect:
-- any asset that ended up `monitored=false` for an INCIDENTAL reason while
-- its class flag was ON — a decommission clamp, an asset created before the
-- flag was enabled, an HA standby member — got stamped `monitorOverride=true`
-- and was thereafter permanently skipped by the discovery auto-monitor sweep,
-- with no operator ever having pinned it.
--
-- `monitorOverride` is now an explicit intent bit, written only at the moment
-- of an operator action (see src/services/monitorOverrideService.ts). This is
-- the one-shot heuristic that re-derives existing rows, distinguishing the two
-- divergence shapes:
--
--   monitored=true  & flag=false  → operator turned something ON that the
--                                    sweep would never enable on its own →
--                                    genuine opt-in → KEEP the pin.
--   monitored=false & flag=true   → the incidental / stranded bucket →
--                                    CLEAR the pin so the next discovery
--                                    sweep retakes the asset.
--   (converged shapes)            → no divergence → false.
--
-- A genuine "operator deliberately silenced a device the flag wants on" is
-- indistinguishable from the incidental case and is therefore cleared too;
-- it re-enables monitoring (recoverable — the operator simply re-pins it).
--
-- Only assets discovered by an integration whose type carries the asset's
-- per-class block participate; all others keep monitorOverride=false (the
-- column default, unchanged here).

UPDATE "assets" a
SET "monitorOverride" = (
  COALESCE(a."monitored", false) = true
  AND COALESCE(
    CASE a."assetType"
      WHEN 'firewall'     THEN (i."config" #>> '{fortigateMonitor,addAsMonitored}')::boolean
      WHEN 'switch'       THEN (i."config" #>> '{fortiswitchMonitor,addAsMonitored}')::boolean
      WHEN 'access_point' THEN (i."config" #>> '{fortiapMonitor,addAsMonitored}')::boolean
      WHEN 'workstation'  THEN (i."config" #>> '{workstationMonitor,addAsMonitored}')::boolean
      WHEN 'server'       THEN (i."config" #>> '{serverMonitor,addAsMonitored}')::boolean
      ELSE NULL
    END,
    false
  ) = false
)
FROM "integrations" i
WHERE a."discoveredByIntegrationId" = i."id"
  AND a."assetType" IN ('firewall', 'switch', 'access_point', 'workstation', 'server');
