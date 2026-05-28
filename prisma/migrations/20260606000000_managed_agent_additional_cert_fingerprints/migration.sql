-- ManagedAgent.additionalServerCertFingerprints — staged pins for zero-downtime
-- cert rotation. Polaris Agents enrolled before this migration kept a single
-- pin in `serverCertFingerprint`; that column stays as the canonical pin and
-- this new column starts empty for every existing row. The Phase 2 dual-pin
-- code accepts EITHER the canonical pin OR any staged pin at enrollment, and
-- bakes the union into agent.conf via the next /config push.
--
-- Additive + nullable-with-default. Safe to run while monitor / discovery
-- workers are live — they don't read this column at all, and the web role
-- only consults it on enroll + /config (both already read the canonical pin
-- and gracefully fall through when the array is empty).
--
-- See cross-cutting/polaris-agent → "Cert pin rotation" in TOUCHES.md for
-- the full rotation workflow.

ALTER TABLE "managed_agents"
  ADD COLUMN "additionalServerCertFingerprints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
