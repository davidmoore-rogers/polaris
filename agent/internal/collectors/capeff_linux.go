//go:build linux

package collectors

import (
	"os"
)

// SelfCapEff returns the agent process's effective capability bitmask as the
// raw hex string from /proc/self/status ("0000000000080000"-style), "" when
// unreadable. Reported on heartbeat so the server can render the VERIFIED
// privilege state — the ManagedAgent.privilegeTier column is only the tier
// requested at install kickoff, and a unit written by a pre-CAP_DAC_READ_SEARCH
// server grants less than the tier promises (the SYS_PTRACE-only regression,
// prod 2026-07-29). Decoding stays server-side so future capability changes
// don't need an agent release.
func SelfCapEff() string {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return ""
	}
	return parseCapEff(string(b))
}
