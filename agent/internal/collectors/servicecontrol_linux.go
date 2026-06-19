//go:build linux

package collectors

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// RunServiceControl runs systemctl <action> <unit> and returns the post-action
// active state (`systemctl is-active`). Returns an error (with stderr) on a
// non-zero systemctl exit. The agent's service account must be able to manage
// the unit (root, or a polkit rule for systemctl) — a permission failure
// surfaces as the returned error.
func RunServiceControl(action, target string) (string, error) {
	if !validControlAction(action) {
		return "", fmt.Errorf("unsupported action %q", action)
	}
	if !validControlTarget(target) {
		return "", fmt.Errorf("invalid unit name %q", target)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "systemctl", action, target).CombinedOutput()
	state := linuxUnitState(target)
	if err != nil {
		return state, fmt.Errorf("systemctl %s %s: %v: %s", action, target, err, strings.TrimSpace(string(out)))
	}
	return state, nil
}

func linuxUnitState(target string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "systemctl", "is-active", target).Output()
	return strings.TrimSpace(string(out))
}
