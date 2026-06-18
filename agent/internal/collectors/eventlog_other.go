//go:build !linux && !darwin && !windows

package collectors

// readPlatformEvents fallback for any OS outside the release matrix
// (linux + darwin + windows). Returns nil so a future cross-compile gets a
// clean build, not a missing-symbol error.
func readPlatformEvents(_ map[string]string, _ EventLogFilter) ([]rawEvent, map[string]string, error) {
	return nil, nil, nil
}
