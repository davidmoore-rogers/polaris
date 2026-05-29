// Polaris Agent — pushes monitoring samples to Polaris over HTTPS with a
// pinned-leaf TLS handshake. Generic binary across deployments; per-install
// identity (server URL, cert pin, bearer) lives entirely in agent.conf.
//
// Lifecycle:
//
//  1. Load agent.conf. If no bearer is present, run /enroll using the
//     one-shot enrollment_token. On success, persist the bearer to
//     agent.conf and remove the enrollment_token.
//  2. Start the collect loop (response-time samples on a fixed interval).
//  3. Start the heartbeat loop (less frequent).
//  4. Run until SIGTERM. Graceful shutdown flushes the last in-flight
//     sample push, if any.
//
// Phase 3 ships steps 1+2+3 with one collector (response-time). Phases
// 4+5 add the SSH/WinRM install path (server side) and the rest of the
// collectors + the WebSocket pull side. Each phase is independently
// deployable; nothing in this binary's surface changes for the operator.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/polaris/agent/internal/collectors"
	"github.com/polaris/agent/internal/config"
	"github.com/polaris/agent/internal/transport"
)

// version is stamped at build time via -ldflags='-X main.version=<x>'.
// Default value is the literal contents of agent/VERSION at the moment
// of code-edit. Both `make all` (which reads VERSION via $(shell cat …))
// and the in-app build path (which reads it via Node's fs.readFile)
// stamp the same value here. `polaris-agent --version` reports it; the
// agent /heartbeat surfaces it server-side as ManagedAgent.agentVersion.
var version = "0.0.0-unstamped"

const (
	defaultResponseTimeIntervalSec = 60
	defaultHeartbeatIntervalSec    = 300
	// Telemetry default mirrors the server's tier-3 default for SNMP/REST
	// polled assets (60 s). System info (interfaces + storage) defaults
	// to 600 s — the OS readings change slowly and the full enumeration
	// has more overhead than a CPU snapshot.
	defaultTelemetryIntervalSec    = 60
	defaultInterfacesIntervalSec   = 600
	defaultStorageIntervalSec      = 600
)

func main() {
	confPath := flag.String("conf", config.DefaultPath(), "path to agent.conf")
	flag.Parse()

	// On Windows, the binary may be launched by the Service Control Manager
	// (sc.exe / Start-Service) rather than from a console. tryRunAsWindowsService
	// detects that case via svc.IsWindowsService and hands off to the SCM
	// dispatcher (which calls runAgent from inside its Execute method).
	// On non-Windows or when run from a console, the stub returns false and
	// we fall through to the standard signal-driven main loop. See
	// service_windows.go for the Windows-only handler implementation.
	if tryRunAsWindowsService(*confPath) {
		return
	}

	ctx, cancel := signalContext()
	defer cancel()
	runAgent(ctx, *confPath)
}

// runAgent is the shared agent runtime — loads config, enrolls if needed,
// starts every collect / heartbeat / WS goroutine, and blocks on ctx until
// the caller cancels it. Callable from both main() (console / Unix daemon
// path) and the Windows Service handler's Execute() (under SCM).
func runAgent(ctx context.Context, confPath string) {
	cfg, err := config.Load(confPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		log.Fatalf("invalid config: %v", err)
	}

	client := transport.NewClient(cfg.ServerURL, cfg.Pins(), cfg.BearerToken)
	// Stamp the ldflag-set version into the client so /enroll and
	// /heartbeat report the version this binary was built at.
	client.AgentVersion = version

	// Step 1: enroll if we don't have a bearer yet.
	if cfg.BearerToken == "" {
		if err := enroll(cfg, client); err != nil {
			log.Fatalf("enrollment failed: %v", err)
		}
	}

	// Step 2 + 3 + 4: three independent loops.
	//   - responseTimeLoop pushes samples on a fixed interval.
	//   - heartbeatLoop bumps lastSeenAt + reads any config etag change.
	//   - wsLoop holds the outbound WebSocket open for on-demand probes.
	// Each runs on its own goroutine so a stall in one doesn't starve
	// the others (a probe-now stuck behind a hung-host check would
	// silently block heartbeats otherwise).
	go responseTimeLoop(ctx, cfg, client)
	go heartbeatLoop(ctx, cfg, client)
	go telemetryLoop(ctx, cfg, client)
	go interfacesLoop(ctx, cfg, client)
	go storageLoop(ctx, cfg, client)
	go systemInfoLoop(ctx, cfg, client)
	go wsLoop(ctx, cfg, client)

	<-ctx.Done()
	log.Println("Polaris Agent: shutting down")
}

// enroll posts the one-shot token to /api/v1/agents/enroll, persists the
// returned bearer, and updates the in-memory client. Mutates cfg in place.
func enroll(cfg *config.Config, client *transport.Client) error {
	if cfg.EnrollmentToken == "" {
		return errAndExit("no enrollment_token in agent.conf — has /enroll already succeeded?")
	}
	hostname, _ := os.Hostname()
	resp, err := client.Enroll(&transport.EnrollRequest{
		EnrollmentToken:           cfg.EnrollmentToken,
		Hostname:                  hostname,
		ServerCertFingerprintSeen: cfg.CertFingerprint,
	})
	if err != nil {
		return err
	}
	log.Printf("enrolled — assetId=%s", resp.AssetID)

	cfg.BearerToken = resp.Bearer
	cfg.EnrollmentToken = "" // one-shot is now consumed
	cfg.AgentID = resp.AssetID
	if err := cfg.Save(); err != nil {
		return errAndExit("enrollment succeeded but persisting agent.conf failed: " + err.Error())
	}
	client.SetBearer(resp.Bearer)
	return nil
}

func responseTimeLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	interval := time.Duration(cfg.ResponseTimeIntervalSec) * time.Second
	if interval == 0 {
		interval = defaultResponseTimeIntervalSec * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()

	// Fire once immediately so the operator sees a sample within seconds
	// of starting the agent rather than waiting one full interval.
	pushOne(client)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pushOne(client)
		}
	}
}

func pushOne(client *transport.Client) {
	// Time the round-trip from agent to Polaris via a /heartbeat ping —
	// that's what operators actually want to know ("how reachable is
	// this host's path to Polaris right now"), not a process-local
	// liveness noop. Heartbeat is the right probe target: bearer-gated,
	// cheap server-side, runs through the same pinned TLS transport
	// the rest of the agent uses (so a TLS / cert / firewall failure
	// surfaces the same way real traffic would).
	sample := collectors.ResponseTimeOnce(func() error {
		_, err := client.Heartbeat()
		return err
	})
	_, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "responseTime",
		Samples: []*transport.ResponseTimeSample{sample},
	})
	if err != nil {
		// Best-effort logging — repeated failures should be visible in
		// the host's journal but mustn't crash the agent (transient 5xx
		// is normal during Polaris restart).
		log.Printf("push responseTime sample: %v", err)
	}
}

func heartbeatLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	interval := time.Duration(cfg.HeartbeatIntervalSec) * time.Second
	if interval == 0 {
		interval = defaultHeartbeatIntervalSec * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()

	_, _ = client.Heartbeat() // immediate one so the UI sees us live on startup
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, err := client.Heartbeat(); err != nil {
				log.Printf("heartbeat: %v", err)
			}
		}
	}
}

// telemetryLoop pushes a CPU+memory+temperatures sample on its own
// cadence (default 60 s, configurable via telemetry_interval_sec in
// agent.conf). The collector blocks ~1 s during CPU sampling so the
// returned percentage reflects a real delta; running on a separate
// goroutine keeps it from delaying the response-time loop.
func telemetryLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	interval := time.Duration(cfg.TelemetryIntervalSec) * time.Second
	if interval == 0 {
		interval = defaultTelemetryIntervalSec * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	pushTelemetryOne(client)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pushTelemetryOne(client)
		}
	}
}

func pushTelemetryOne(client *transport.Client) {
	sample := collectors.TelemetryOnce()
	_, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "telemetry",
		Samples: []*transport.TelemetrySample{sample},
	})
	if err != nil {
		log.Printf("push telemetry sample: %v", err)
	}
}

// interfacesLoop pushes per-NIC counter samples (default 600 s).
// Slower cadence than telemetry because the full enumeration is
// heavier and interface state changes slowly compared to CPU load.
// Operators wanting sub-minute history on a specific NIC pin it via
// monitoredInterfaces and the server's fast-cadence path picks it up.
func interfacesLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	interval := time.Duration(cfg.InterfacesIntervalSec) * time.Second
	if interval == 0 {
		interval = defaultInterfacesIntervalSec * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	pushInterfacesOne(client)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pushInterfacesOne(client)
		}
	}
}

func pushInterfacesOne(client *transport.Client) {
	samples := collectors.InterfacesOnce()
	if len(samples) == 0 {
		return
	}
	_, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "interfaces",
		Samples: samples,
	})
	if err != nil {
		log.Printf("push interfaces samples: %v", err)
	}
}

// storageLoop pushes per-mountpoint usage samples (default 600 s).
// disk.Usage can block briefly on a sluggish filesystem; gopsutil's
// Partitions(false) filters out the network mounts and pseudo-fs that
// most often cause those stalls.
func storageLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	interval := time.Duration(cfg.StorageIntervalSec) * time.Second
	if interval == 0 {
		interval = defaultStorageIntervalSec * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	pushStorageOne(client)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pushStorageOne(client)
		}
	}
}

func pushStorageOne(client *transport.Client) {
	samples := collectors.StorageOnce()
	if len(samples) == 0 {
		return
	}
	_, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "storage",
		Samples: samples,
	})
	if err != nil {
		log.Printf("push storage samples: %v", err)
	}
}

// systemInfoLoop pushes host identity (hostname / OS / vendor / model
// / serial) on the heartbeat cadence (default 300 s). Host identity
// doesn't change between firmware updates, so most pushes are no-ops
// server-side (same observed blob → same projection → no Asset write).
// Cheaper than its own cadence + matches the operator's intuition
// that "agent is alive AND I know what it is" is one signal.
func systemInfoLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	interval := time.Duration(cfg.HeartbeatIntervalSec) * time.Second
	if interval == 0 {
		interval = defaultHeartbeatIntervalSec * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	pushSystemInfoOne(client)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pushSystemInfoOne(client)
		}
	}
}

func pushSystemInfoOne(client *transport.Client) {
	info := collectors.SystemInfoOnce(version)
	body := &transport.SystemInfoBody{
		Hostname:      info.Hostname,
		OS:            info.OS,
		OSVersion:     info.OSVersion,
		KernelVersion: info.KernelVersion,
		KernelArch:    info.KernelArch,
		Manufacturer:  info.Manufacturer,
		Model:         info.Model,
		SerialNumber:  info.SerialNumber,
		BiosVersion:   info.BiosVersion,
		PrimaryMAC:    info.PrimaryMAC,
		PrimaryIP:     info.PrimaryIP,
		AgentVersion:  info.AgentVersion,
	}
	if err := client.PushSystemInfo(body); err != nil {
		log.Printf("push system-info: %v", err)
	}
}

// wsLoop holds the outbound WebSocket to Polaris open. Server-pushed
// frames land in handleServerFrame: `probe-now-request` runs the relevant
// collector synchronously and writes a `probe-now-response` back through
// the same socket; `refresh-config` triggers a /config refetch via the
// HTTP transport.
func wsLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	dialer, err := transport.NewWSDialer(cfg.ServerURL, cfg.Pins(), cfg.BearerToken)
	if err != nil {
		log.Printf("ws: dialer setup failed: %v", err)
		return
	}
	dialer.RunWithReconnect(ctx, func(_ context.Context, conn *transport.WSConn, f *transport.Frame) error {
		switch f.Type {
		case "hello":
			// Server says it accepted the upgrade. Nothing to do.
			return nil
		case "refresh-config":
			// Server is telling us something changed (operator edited
			// cadences, staged a cert pin, etc.). Best-effort refetch —
			// failure here just means we'll see the change at the next
			// normal poll.
			resp, err := client.FetchConfig("")
			if err != nil {
				log.Printf("ws: refresh-config: fetch failed: %v", err)
				return nil
			}
			// Phase 2 dual-pin: if the server's pin set differs from what we
			// have on disk, save the new pin set and exit cleanly so systemd
			// cycles us with the updated agent.conf live. The reconnect
			// post-restart establishes new TLS with the updated pin set,
			// which is what lets the agent survive a cert rotation initiated
			// by the operator AFTER the staging push. See cross-cutting/
			// polaris-agent → "Cert pin rotation" in TOUCHES.md.
			if resp != nil && len(resp.CertFingerprints) > 0 {
				if cfg.SetPins(resp.CertFingerprints) {
					if err := cfg.Save(); err != nil {
						log.Printf("ws: refresh-config: failed to save updated pin set: %v", err)
						return nil
					}
					log.Printf("ws: refresh-config: pin set updated (%d pins) — exiting for systemd restart",
						len(resp.CertFingerprints))
					os.Exit(0)
				}
			}
			return nil
		case "probe-now-request":
			// Operator clicked "Probe now" on the asset details page.
			// Run the appropriate collector synchronously and emit the
			// response frame keyed by request id.
			var payload struct {
				Stream string `json:"stream"`
			}
			_ = json.Unmarshal(f.Payload, &payload)
			var resp transport.ResponseTimeSample
			if payload.Stream == "responseTime" {
				resp = *collectors.ResponseTimeOnce(func() error {
					_, err := client.Heartbeat()
					return err
				})
			}
			resPayload, _ := json.Marshal(map[string]interface{}{
				"success":        resp.Success,
				"responseTimeMs": resp.ResponseTimeMs,
				"error":          resp.Error,
			})
			return conn.SendFrame(&transport.Frame{
				Type:    "probe-now-response",
				ID:      f.ID,
				Payload: resPayload,
			})
		default:
			log.Printf("ws: unrecognized frame type %q", f.Type)
			return nil
		}
	})
}

func signalContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	sigc := make(chan os.Signal, 1)
	signal.Notify(sigc, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigc
		cancel()
	}()
	return ctx, cancel
}

func errAndExit(msg string) error {
	log.Fatal(msg)
	return nil // unreached
}
