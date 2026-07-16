-- Single-FortiGate scoped re-discovery: when set, the run was scoped to one
-- FMG-managed device and the finalize pass ran in "finalize-scoped" mode
-- (Phase 2b only). NULL = full run (unchanged behavior).
ALTER TABLE "discovery_runs" ADD COLUMN "scopeDeviceName" TEXT;
