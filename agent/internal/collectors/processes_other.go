//go:build !linux && !windows

package collectors

// resolveServiceUnits is a no-op on platforms without a service manager we map
// (macOS launchd isn't wired). No units → no process is controllable there.
func resolveServiceUnits(_ []int32) map[int32]string {
	return nil
}
