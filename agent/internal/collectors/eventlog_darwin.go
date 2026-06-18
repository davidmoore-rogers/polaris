//go:build darwin

package collectors

// macOS has no operator-facing "event log" equivalent the curated audit-Events
// model targets (os_log is a firehose). Return nil so the eventLog stream is a
// no-op on Macs; operators monitor those via the other streams.
func readPlatformEvents(_ map[string]string, _ EventLogFilter) ([]rawEvent, map[string]string, error) {
	return nil, nil, nil
}
