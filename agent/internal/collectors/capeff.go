package collectors

import "strings"

// parseCapEff extracts the CapEff hex value from a /proc/<pid>/status body.
// Pure — split from the file read for unit testing. Returns "" when the line
// is absent (non-Linux content, truncated read).
func parseCapEff(status string) string {
	for _, line := range strings.Split(status, "\n") {
		if !strings.HasPrefix(line, "CapEff:") {
			continue
		}
		return strings.TrimSpace(strings.TrimPrefix(line, "CapEff:"))
	}
	return ""
}
