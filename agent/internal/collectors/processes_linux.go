//go:build linux

package collectors

import (
	"os"
	"strconv"
	"strings"
)

// resolveServiceUnits maps each PID to its systemd unit (e.g. "nginx.service")
// by reading /proc/<pid>/cgroup and pulling the *.service / *.scope segment.
// Cheap (one file read per PID, no exec). PIDs not under a unit are omitted.
func resolveServiceUnits(pids []int32) map[int32]string {
	out := make(map[int32]string, len(pids))
	for _, pid := range pids {
		b, err := os.ReadFile("/proc/" + strconv.Itoa(int(pid)) + "/cgroup")
		if err != nil {
			continue
		}
		if unit := parseSystemdUnit(string(b)); unit != "" {
			out[pid] = unit
		}
	}
	return out
}

// parseSystemdUnit extracts the service/scope unit name from a cgroup file body.
// Handles both cgroup v2 (single "0::/system.slice/nginx.service" line) and v1
// (multiple "N:controller:/system.slice/nginx.service" lines). Returns the
// LAST path segment ending in .service (preferred) or .scope. Pure.
func parseSystemdUnit(cgroup string) string {
	best := ""
	for _, line := range strings.Split(cgroup, "\n") {
		// The path is the part after the last ':'.
		idx := strings.LastIndex(line, ":")
		if idx < 0 {
			continue
		}
		path := line[idx+1:]
		for _, seg := range strings.Split(path, "/") {
			if strings.HasSuffix(seg, ".service") {
				return seg // a .service is the most specific/desirable match
			}
			if strings.HasSuffix(seg, ".scope") {
				best = seg
			}
		}
	}
	return best
}
