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
//
// Taking the LAST .service rather than the first matters for delegated
// hierarchies: a workload under
// "/system.slice/containerd.service/kubepods/.../app.service" belongs to
// app.service, and returning the outer containerd.service would attribute every
// container on the host to one unit.
func parseSystemdUnit(cgroup string) string {
	service := ""
	scope := ""
	for _, line := range strings.Split(cgroup, "\n") {
		// The path is the part after the last ':'.
		idx := strings.LastIndex(line, ":")
		if idx < 0 {
			continue
		}
		path := line[idx+1:]
		for _, seg := range strings.Split(path, "/") {
			if strings.HasSuffix(seg, ".service") {
				service = seg // keep scanning — the deepest .service wins
			}
			if strings.HasSuffix(seg, ".scope") {
				scope = seg
			}
		}
	}
	if service != "" {
		return service // a .service is the most specific/desirable match
	}
	return scope
}
