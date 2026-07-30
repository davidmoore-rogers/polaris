-- ManagedAgent.reportedCapEff — the effective-capability bitmask the agent
-- process ACTUALLY holds (raw CapEff hex from /proc/self/status), reported on
-- heartbeat by agents >= 0.17.1 (Linux only). Verified counterpart to the
-- requested-at-kickoff privilegeTier: a ptrace-tier agent whose mask lacks
-- CAP_DAC_READ_SEARCH (bit 2) is running a unit from before the DAC fix and
-- collects zero Application Map connections until reinstalled. NULL = not yet
-- reported (pre-0.17.1 binary, Windows/macOS, or no heartbeat since upgrade).
ALTER TABLE "managed_agents" ADD COLUMN "reportedCapEff" TEXT;
