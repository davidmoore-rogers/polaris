//go:build !windows

package main

// tryRunAsWindowsService is a no-op stub on every platform that isn't Windows.
// The Windows-specific implementation lives in service_windows.go and dispatches
// to the Windows Service Control Manager. On Unix the agent is run by systemd /
// launchd via SIGTERM, so no equivalent scaffolding is needed.
func tryRunAsWindowsService(_ string) bool {
	return false
}
