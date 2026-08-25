-- Clear the retired "http" polling method out of stored monitor settings.
--
-- "http" was a polling method from 2026-08-21 until this change, when the HTTP
-- check it ran became a manufacturer custom widget. `assertPollingCompatible`
-- validates WRITES only, so nothing re-checks a value already in the database:
-- an asset left on the retired method would reach probeAsset, match no branch,
-- and fail every probe — silently false-downing it rather than degrading.
--
-- ICMP is the substitute because it is the universal response-time fallback and
-- reports up/down without content, which is the closest thing to what the
-- operator had. The alternative — NULL, meaning "inherit" — would resolve to a
-- source default that could be REST or SNMP against a device chosen for an HTTP
-- check, so it is the less predictable of the two.
--
-- Only responseTime is touched: the method was responseTime-only, enforced both
-- by isMethodValidForStream and by a per-stream guard in the assets route, so
-- no other column could hold it.
--
-- monitoringService.probeAsset carries a matching runtime fallback for the same
-- value. That is not redundant: this statement cannot reach the JSON tiers
-- (`manualMonitorSettings`, Integration.config per-class blocks) where the
-- resolver may also find it, and the code path covers those.

UPDATE "assets"
   SET "responseTimePolling" = 'icmp'
 WHERE "responseTimePolling" = 'http';

UPDATE "monitor_class_overrides"
   SET "responseTimePolling" = 'icmp'
 WHERE "responseTimePolling" = 'http';
