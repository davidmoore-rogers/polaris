// Package collectors holds the per-stream sample producers. Phase 3 ships
// the response-time collector end-to-end; telemetry / interfaces / storage
// land in Phase 5 (each has platform-specific code paths — PDH counters on
// Windows, /proc on Linux, sysctl/IOKit on macOS — and that's where the
// agent's footprint grows).
//
// The response-time stream measures the round-trip from the agent to the
// Polaris server (NOT a process-local liveness signal — that flat-zero
// shape was confusing operators since it told them nothing about whether
// the host could actually reach Polaris). The caller passes a probe
// function that performs one HTTP call to Polaris (a /heartbeat ping is
// what the agent uses); we time the call wall-clock and shape the result
// into a server-side sample row. When the probe errors, success=false +
// responseTimeMs=null = the standard "packet loss" signal in the existing
// chart, and the server's five-state machine flips warning/down via the
// same path the periodic puller uses.
package collectors

import (
	"time"

	"github.com/shirou/gopsutil/v3/host"

	"github.com/polaris/agent/internal/transport"
)

// ResponseTimeOnce runs one agent → Polaris round-trip via the caller-
// supplied probe function and shapes the result into a server-side
// sample row. The probe is typically client.Heartbeat — bearer-gated,
// cheap server-side (single DB update), runs through the same pinned
// TLS transport the rest of the agent uses, so a TLS / cert / firewall
// failure surfaces the same way real traffic would. Returns success
// with the elapsed ms on a successful probe; success=false with the
// error message and a nil responseTimeMs on failure (packet-loss
// shape that the System tab chart already renders as a dropped sample).
func ResponseTimeOnce(probe func() error) *transport.ResponseTimeSample {
	start := time.Now()
	err := probe()
	elapsedMs := int(time.Since(start).Milliseconds())

	sample := &transport.ResponseTimeSample{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Success:   err == nil,
	}
	if err == nil {
		sample.ResponseTimeMs = &elapsedMs
	} else {
		msg := err.Error()
		sample.Error = &msg
	}

	// Host uptime rides the response-time push (server stamps it onto
	// Asset.lastUptime* via the same recordProbeResult path SNMP/FortiOS use).
	// Reported even on a failed probe — the host is clearly up if the agent ran.
	if up, uerr := host.Uptime(); uerr == nil {
		sample.UptimeSeconds = &up
	}
	return sample
}
