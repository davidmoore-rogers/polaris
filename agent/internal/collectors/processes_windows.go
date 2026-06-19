//go:build windows

package collectors

import (
	"context"
	"encoding/csv"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// resolveServiceUnits maps each PID to its backing Windows service short-name
// via one `tasklist /svc` call (PID → service list). A process not hosting a
// service is omitted (→ not controllable). When a PID hosts multiple services
// (e.g. svchost), the first is used. Cgo-free; lighter + more service-account-
// friendly than PowerShell.
func resolveServiceUnits(pids []int32) map[int32]string {
	want := make(map[int32]bool, len(pids))
	for _, p := range pids {
		want[p] = true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// /fo csv /nh → "ImageName","PID","Service1,Service2" (or "N/A").
	out, err := exec.CommandContext(ctx, "tasklist", "/svc", "/fo", "csv", "/nh").Output()
	if err != nil {
		return nil
	}
	return parseTasklistSvc(string(out), want)
}

// parseTasklistSvc parses `tasklist /svc /fo csv /nh` output into a PID→service
// map, keeping only the wanted PIDs. The services column is comma-separated
// within the single CSV field; "N/A" means none. Pure given its inputs.
func parseTasklistSvc(out string, want map[int32]bool) map[int32]string {
	res := make(map[int32]string)
	r := csv.NewReader(strings.NewReader(out))
	r.FieldsPerRecord = -1 // tolerate ragged rows
	records, err := r.ReadAll()
	if err != nil {
		return res
	}
	for _, rec := range records {
		if len(rec) < 3 {
			continue
		}
		pid64, err := strconv.ParseInt(strings.TrimSpace(rec[1]), 10, 32)
		if err != nil {
			continue
		}
		pid := int32(pid64)
		if len(want) > 0 && !want[pid] {
			continue
		}
		svc := strings.TrimSpace(rec[2])
		if svc == "" || svc == "N/A" {
			continue
		}
		// First service when a PID hosts several (svchost groups).
		if i := strings.IndexByte(svc, ','); i >= 0 {
			svc = strings.TrimSpace(svc[:i])
		}
		if svc != "" {
			res[pid] = svc
		}
	}
	return res
}
