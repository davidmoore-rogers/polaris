// servicelog.go — tail journalctl for operator-pinned UNITS (Phase 2, service
// dimension). The service-tab counterpart of processlog.go: instead of a
// program's journal (_COMM=<name>), it reads a systemd unit's journal
// (journalctl -u <unit>) for each unit in Asset.monitoredServices.
//
// Cursors live in servicelog-cursors.json next to agent.conf — a SEPARATE file
// from processlog-cursors.json so the two loops (different goroutines) never
// race on a shared read-modify-write. First run seeds each unit at its tail
// cursor (no historical dump). Linux-only via readJournaldUnit (a no-op stub
// elsewhere — Windows service logs ride the Event Log stream).
package collectors

import (
	"os"
	"path/filepath"

	"github.com/polaris/agent/internal/transport"
)

func serviceLogCursorPath(stateDir string) string {
	return filepath.Join(stateDir, "servicelog-cursors.json")
}

func loadServiceLogCursors(stateDir string) map[string]string {
	b, err := os.ReadFile(serviceLogCursorPath(stateDir))
	if err != nil {
		return map[string]string{}
	}
	return parseCursors(b) // reuse eventlog.go's tolerant codec
}

func saveServiceLogCursors(stateDir string, cursors map[string]string) error {
	b, err := marshalCursors(cursors)
	if err != nil {
		return err
	}
	tmp := serviceLogCursorPath(stateDir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, serviceLogCursorPath(stateDir))
}

// ServiceLogOnce tails every pinned unit's journal since its cursor and returns
// the new lines as wire samples. Mutates + persists the cursor map. Best-effort:
// a per-unit failure is skipped, not fatal. Returns nil when nothing is pinned.
func ServiceLogOnce(stateDir string, units []string, maxPerUnit int) []*transport.ServiceLogSample {
	if len(units) == 0 {
		return nil
	}
	if maxPerUnit <= 0 {
		maxPerUnit = defaultMaxLogLinesPerProcess
	}
	cursors := loadServiceLogCursors(stateDir)
	var out []*transport.ServiceLogSample
	for _, unit := range units {
		key := "journald-unit:" + unit
		lines, newCursor := readJournaldUnit(unit, cursors[key], maxPerUnit, cursors[key] == "")
		if newCursor != "" {
			cursors[key] = newCursor
		}
		src := "journald:-u " + unit
		for _, l := range lines {
			s := src
			sample := &transport.ServiceLogSample{Timestamp: l.Timestamp, Unit: unit, Message: l.Message, Source: &s}
			if l.Level != "" {
				lvl := l.Level
				sample.Level = &lvl
			}
			out = append(out, sample)
		}
	}
	_ = saveServiceLogCursors(stateDir, cursors)
	return out
}
