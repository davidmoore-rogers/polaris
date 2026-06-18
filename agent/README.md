# Polaris Agent

Lightweight Go binary installed on remote hosts (Linux/macOS/Windows × amd64/arm64) that pushes monitoring samples back to Polaris. Generic across deployments — per-install identity lives in `agent.conf`.

## Building

```sh
go mod tidy     # one-time: resolve dependency checksums into go.sum
make all        # produce all 6 platform binaries under dist/<version>/
make dev        # local-arch build for quick iteration (./polaris-agent)
```

Binaries are static (`CGO_ENABLED=0`); copying one file to the target host is sufficient.

Dependencies: just one — `github.com/gorilla/websocket` for the outbound pull-side WebSocket. The HTTP push path uses only stdlib `net/http`.

## Configuration

Written by `agentInstallService` on the Polaris server side at install time. Operators don't edit it by hand.

```ini
# /etc/polaris-agent/agent.conf  (Linux/macOS)
# %ProgramData%\Polaris\agent\agent.conf  (Windows)

server_url       = https://polaris.example.com:3000
cert_fingerprint = sha256:ab12cd34...      # leaf SHA-256, pinned at install
bearer_token     = polaris_xK9rT2pQwL...   # populated by /enroll on first run
enrollment_token = polaris_...             # one-shot; consumed on first /enroll
agent_id         = 7f2e9a1c-...            # assetId, used for WS subprotocol
```

Optional knobs (defaults if omitted):

```ini
response_time_interval_sec = 60
heartbeat_interval_sec     = 300
```

## Running

The install script registers the agent as a system service:

| OS | Mechanism |
|---|---|
| Linux | systemd unit at `/etc/systemd/system/polaris-agent.service` (Phase 4) |
| macOS | launchd LaunchDaemon at `/Library/LaunchDaemons/com.polaris.agent.plist` (Phase 4) |
| Windows | Windows Service via `New-Service` (Phase 4) |

For development you can run the binary directly:

```sh
./polaris-agent -conf /path/to/agent.conf
```

## Wire protocol

| Endpoint | Method | Auth |
|---|---|---|
| `/api/v1/agents/enroll` | POST | enrollment token in body (one-shot) |
| `/api/v1/agents/samples` | POST | bearer (Authorization header) |
| `/api/v1/agents/heartbeat` | POST | bearer |
| `/api/v1/agents/config` | GET | bearer; `If-None-Match` short-circuit |
| `/api/v1/agents/ws` | WS upgrade | bearer in `Sec-WebSocket-Protocol` (Phase 3b) |

## Security

- **TLS leaf pinning** — agent does NOT trust system roots; only the SHA-256 baked into `agent.conf` at install time matches. Rotating the pin requires the operator to re-run install with a re-keyed Polaris server.
- **Per-agent bearer** — bound to a single `assetId` server-side. A stolen bearer can only write samples for the one asset it was issued for.
- **Config file mode 0600** — the bearer is the only sensitive material on disk; only the agent's service user reads it.

## Phasing

| Phase | Adds |
|---|---|
| 3a | HTTP push: enroll, samples (responseTime), heartbeat, config-fetch |
| 3b (current) | WebSocket pull side: outbound dial w/ pinned TLS, reconnect-with-backoff, probe-now-request / probe-now-response, refresh-config |
| 4 | Remote install via SSH/WinRM from the Polaris UI |
| 5 | Telemetry / interfaces / storage / LLDP collectors |
| 6 | OS event-log collector (opt-in `eventLog` stream): wevtutil (Windows) / journalctl (Linux), per-channel cursor in `eventlog-cursors.json`, server-pushed enable flag + curation filter honored via `applyServerStreams`. Server curates entries into the audit Events tab. |
| 7 | Process inventory (`processInventory` stream, gated on `processes` stream = agent): gopsutil enumeration aggregated by program name, current-state full-replace into the asset Processes tab. |
| 7b | Per-pinned-program CPU/RAM telemetry (`processTelemetry` stream, 1/min): instantaneous CPU via prime→sleep→read delta over the pinned PIDs, summed by name, into the AssetProcessSample time-series. Pinned set + log config delivered via `/config`'s `pinnedProcesses`. (Process log tailing is the next slice.) |
