//go:build !linux && !windows

package collectors

import "fmt"

// RunServiceControl is unsupported off Linux/Windows (no mapped service manager).
func RunServiceControl(_ string, _ string) (string, error) {
	return "", fmt.Errorf("process control is not supported on this platform")
}
