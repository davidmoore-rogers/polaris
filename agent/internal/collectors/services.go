// services.go — current-state service inventory (systemd units on Linux,
// Windows services via SCM). The service DIMENSION: unlike the process
// inventory (keyed by program name, so a Spring Boot app shows up as "java"),
// this enumerates UNITS as first-class entities, so a service backed by a
// shared runtime is visible as itself and oneshot/exited units with no live
// process still appear.
//
// Platform-specific enumeration lives in the build-tagged files
// (services_linux.go / services_windows.go / services_other.go); this file is
// just the exported entry point + shared shaping. The server full-replaces the
// asset's rows per push (persistAssetServices, delete-replace) and derives
// `controllable` from the platform + load state, so the agent only reports raw
// facts.
package collectors

import (
	"sort"
	"strconv"
	"strings"

	"github.com/polaris/agent/internal/transport"
)

// unitDetail is the MainPID + memory pair pulled from `systemctl show`. Lives
// here (untagged) alongside its pure parser so both are unit-testable on any
// OS; the Linux collector is its only real caller.
type unitDetail struct {
	mainPid  int
	memBytes uint64
	hasMem   bool
}

// sysdUnit is the load/active/sub/description tuple parsed from a
// `systemctl list-units` row. Untagged (like unitDetail) so its parser is
// unit-testable on any OS.
type sysdUnit struct {
	Load        string
	Active      string
	Sub         string
	Description string
}

// parseListUnits parses the PLAIN columnar output of
// `systemctl list-units --type=service --all --plain --no-legend`, one unit
// per line:
//
//	<unit> <load> <active> <sub> <description...>
//
// The first four columns are whitespace-free tokens; the description is the
// remainder of the line (may contain spaces). We deliberately parse the table
// form rather than `-o json`: systemctl only emits JSON for these list verbs
// from an interactive session — under a systemd service (how the agent runs)
// it silently falls back to this table format, so JSON parsing returns nothing.
// A leading status glyph ("●", printed for failed/degraded units when --plain
// is not honored) is tolerated. Only *.service rows are kept. Pure (no exec).
func parseListUnits(out string) map[string]sysdUnit {
	m := map[string]sysdUnit{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		// Drop a leading bullet ("●") that older/TTY output prefixes onto
		// failed-unit rows, so the column offsets line up regardless.
		if fields[0] == "●" {
			fields = fields[1:]
		}
		if len(fields) < 4 || !strings.HasSuffix(fields[0], ".service") {
			continue
		}
		desc := ""
		if len(fields) > 4 {
			desc = strings.Join(fields[4:], " ")
		}
		m[fields[0]] = sysdUnit{Load: fields[1], Active: fields[2], Sub: fields[3], Description: desc}
	}
	return m
}

// parseListUnitFiles parses the PLAIN columnar output of
// `systemctl list-unit-files --type=service --no-legend`, one unit per line:
//
//	<unit-file> <state> [<preset>]
//
// Same rationale as parseListUnits (table form, not JSON). Returns unit → state.
func parseListUnitFiles(out string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.HasSuffix(fields[0], ".service") {
			continue
		}
		m[fields[0]] = fields[1]
	}
	return m
}

// parseShowUnits parses `systemctl show` output — blank-line-separated blocks of
// Key=Value lines, keyed by the Id property. Pure (unit-testable without exec).
// MainPID 0 → no main pid; MemoryCurrent uint64-max / non-numeric → unaccounted.
func parseShowUnits(out string) map[string]unitDetail {
	res := map[string]unitDetail{}
	for _, block := range strings.Split(out, "\n\n") {
		var id string
		var d unitDetail
		for _, line := range strings.Split(block, "\n") {
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			switch k {
			case "Id":
				id = strings.TrimSpace(v)
			case "MainPID":
				if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
					d.mainPid = n
				}
			case "MemoryCurrent":
				// systemd reports uint64-max / "[not set]" when unaccounted.
				if n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64); err == nil && n != ^uint64(0) {
					d.memBytes = n
					d.hasMem = true
				}
			}
		}
		if id != "" {
			res[id] = d
		}
	}
	return res
}

// ServiceInventoryOnce enumerates all loaded services/units and returns one
// sample per unit, sorted deterministically (by unit name) so a full-replace
// push is stable across scrapes. Returns nil when the platform has no service
// manager or enumeration fails (a nil push is a deliberate no-op server-side;
// an empty non-nil slice is a valid delete-only scrape).
func ServiceInventoryOnce() []*transport.ServiceSample {
	out := serviceInventoryOnce()
	if out == nil {
		return nil
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Unit < out[j].Unit })
	return out
}
