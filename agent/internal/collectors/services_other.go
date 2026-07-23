//go:build !linux && !windows

package collectors

import "github.com/polaris/agent/internal/transport"

// serviceInventoryOnce is a no-op on platforms without a supported service
// manager (macOS/launchd is not yet mapped) — returns nil so the server
// treats it as a no-op push.
func serviceInventoryOnce() []*transport.ServiceSample { return nil }
