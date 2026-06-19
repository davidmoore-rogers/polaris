//go:build windows

package collectors

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// RunServiceControl manages a Windows service via `net` (synchronous stop/start)
// + reports state via `sc query`. restart = stop then start. `net` blocks until
// the transition completes and returns non-zero on failure, so we get a real
// success/fail signal (unlike `sc stop` which is async). The agent's service
// account must have rights to control the target service.
func RunServiceControl(action, target string) (string, error) {
	if !validControlAction(action) {
		return "", fmt.Errorf("unsupported action %q", action)
	}
	if !validControlTarget(target) {
		return "", fmt.Errorf("invalid service name %q", target)
	}
	switch action {
	case "stop":
		if err := netSvc("stop", target); err != nil {
			return winSvcState(target), err
		}
	case "start":
		if err := netSvc("start", target); err != nil {
			return winSvcState(target), err
		}
	case "restart":
		if err := netSvc("stop", target); err != nil {
			return winSvcState(target), fmt.Errorf("restart: stop failed: %w", err)
		}
		if err := netSvc("start", target); err != nil {
			return winSvcState(target), fmt.Errorf("restart: start failed: %w", err)
		}
	}
	return winSvcState(target), nil
}

func netSvc(sub, target string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "net", sub, target).CombinedOutput()
	if err != nil {
		return fmt.Errorf("net %s %s: %v: %s", sub, target, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// winSvcState parses `sc query <svc>` for the STATE word (RUNNING/STOPPED/…).
func winSvcState(target string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "sc", "query", target).Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "STATE") {
			// "        STATE              : 4  RUNNING"
			fields := strings.Fields(line)
			if len(fields) > 0 {
				return strings.ToLower(fields[len(fields)-1])
			}
		}
	}
	return ""
}
