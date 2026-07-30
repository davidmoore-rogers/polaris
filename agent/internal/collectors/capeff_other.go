//go:build !linux

package collectors

// SelfCapEff is Linux-only — capability bitmasks don't exist on Windows
// (agents run as LocalSystem) or macOS (LaunchDaemons run as root), and the
// server renders fixed privilege labels for those platforms.
func SelfCapEff() string {
	return ""
}
