//go:build linux

package collectors

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/polaris/agent/internal/transport"
)

// serviceInventoryOnce enumerates systemd .service units via systemctl. Three
// cheap reads, merged by unit name:
//   - `list-units --all`      → load/active/sub/description (every loaded unit,
//     including inactive-but-loaded + failed).
//   - `list-unit-files`       → enablement (enabled/disabled/static/...).
//   - `show -p Id,MainPID,...`→ MainPID + MemoryCurrent (one batched call).
//
// Returns nil when systemctl is unavailable or the primary enumeration fails
// (server treats a nil push as a no-op). cgo-free; shells out with hard
// timeouts so a wedged systemctl can't stall the collection goroutine.
func serviceInventoryOnce() []*transport.ServiceSample {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return nil
	}

	units := listUnits()
	if units == nil {
		return nil
	}
	enabled := listUnitFiles()          // unit → enablement state; best-effort
	details := showUnits(keysOf(units)) // unit → {mainPid, memBytes}; best-effort

	out := make([]*transport.ServiceSample, 0, len(units))
	for name, u := range units {
		s := &transport.ServiceSample{Unit: name, Platform: "systemd"}
		if u.Description != "" {
			d := u.Description
			s.DisplayName = &d
		}
		if u.Load != "" {
			l := u.Load
			s.LoadState = &l
		}
		if u.Active != "" {
			a := u.Active
			s.ActiveState = &a
		}
		if u.Sub != "" {
			sub := u.Sub
			s.SubState = &sub
		}
		if e, ok := enabled[name]; ok && e != "" {
			s.EnabledState = &e
		}
		if d, ok := details[name]; ok {
			if d.mainPid > 0 {
				pid := d.mainPid
				s.MainPid = &pid
				if comm := readComm(pid); comm != "" {
					s.MainProcess = &comm
				}
			}
			if d.hasMem {
				mem := d.memBytes
				s.MemBytes = &mem
			}
		}
		out = append(out, s)
	}
	return out
}

type sysdUnit struct {
	Load        string `json:"load"`
	Active      string `json:"active"`
	Sub         string `json:"sub"`
	Description string `json:"description"`
}

// listUnits runs `systemctl list-units --type=service --all -o json`. Returns
// nil on failure (distinct from an empty map — a host with zero services).
func listUnits() map[string]sysdUnit {
	out, err := runSystemctl(20*time.Second, "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "-o", "json")
	if err != nil {
		return nil
	}
	var rows []struct {
		Unit        string `json:"unit"`
		Load        string `json:"load"`
		Active      string `json:"active"`
		Sub         string `json:"sub"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(out, &rows); err != nil {
		return nil
	}
	m := make(map[string]sysdUnit, len(rows))
	for _, r := range rows {
		if r.Unit == "" || !strings.HasSuffix(r.Unit, ".service") {
			continue
		}
		m[r.Unit] = sysdUnit{Load: r.Load, Active: r.Active, Sub: r.Sub, Description: r.Description}
	}
	return m
}

// listUnitFiles maps unit → enablement (enabled/disabled/static/masked/...).
// Best-effort: an empty map just means the enablement column stays blank.
func listUnitFiles() map[string]string {
	out, err := runSystemctl(20*time.Second, "list-unit-files", "--type=service", "--no-legend", "--no-pager", "-o", "json")
	if err != nil {
		return map[string]string{}
	}
	var rows []struct {
		UnitFile string `json:"unit_file"`
		State    string `json:"state"`
	}
	if err := json.Unmarshal(out, &rows); err != nil {
		return map[string]string{}
	}
	m := make(map[string]string, len(rows))
	for _, r := range rows {
		if r.UnitFile != "" {
			m[r.UnitFile] = r.State
		}
	}
	return m
}

// showUnits batches `systemctl show <units> -p Id,MainPID,MemoryCurrent` into a
// single call and parses the blank-line-separated property blocks. Best-effort.
func showUnits(units []string) map[string]unitDetail {
	res := map[string]unitDetail{}
	if len(units) == 0 {
		return res
	}
	args := append([]string{"show", "-p", "Id", "-p", "MainPID", "-p", "MemoryCurrent", "--no-pager"}, units...)
	out, err := runSystemctl(25*time.Second, args...)
	if err != nil {
		return res
	}
	return parseShowUnits(string(out))
}

// readComm returns the program name of a PID from /proc/<pid>/comm ("" on miss).
func readComm(pid int) string {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func runSystemctl(timeout time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return exec.CommandContext(ctx, "systemctl", args...).Output()
}

func keysOf(m map[string]sysdUnit) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
