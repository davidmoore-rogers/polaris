//go:build windows

package collectors

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"

	"github.com/polaris/agent/internal/transport"
)

// serviceInventoryOnce enumerates Windows services via one CIM query. State +
// StartMode map onto the same activeState/enabledState fields the systemd path
// uses; loadState/subState/memBytes stay nil (no cheap SCM equivalent).
// Returns nil when the query fails.
func serviceInventoryOnce() []*transport.ServiceSample {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// @(...) forces an array even when a single service is returned.
	const script = `@(Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,StartMode,ProcessId) | ConvertTo-Json -Compress -Depth 3`
	out, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil {
		return nil
	}
	var rows []struct {
		Name        string `json:"Name"`
		DisplayName string `json:"DisplayName"`
		State       string `json:"State"`
		StartMode   string `json:"StartMode"`
		ProcessId   int    `json:"ProcessId"`
	}
	if err := json.Unmarshal(out, &rows); err != nil {
		return nil
	}
	result := make([]*transport.ServiceSample, 0, len(rows))
	for _, r := range rows {
		if r.Name == "" {
			continue
		}
		s := &transport.ServiceSample{Unit: r.Name, Platform: "windows"}
		if r.DisplayName != "" {
			d := r.DisplayName
			s.DisplayName = &d
		}
		if r.State != "" {
			a := strings.ToLower(r.State)
			s.ActiveState = &a
		}
		if r.StartMode != "" {
			e := strings.ToLower(r.StartMode)
			s.EnabledState = &e
		}
		if r.ProcessId > 0 {
			pid := r.ProcessId
			s.MainPid = &pid
		}
		result = append(result, s)
	}
	return result
}
