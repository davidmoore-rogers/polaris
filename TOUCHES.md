# Polaris — Touches Index

A lookup index for cross-cutting invariants and per-service relationships in the Polaris codebase. Answers the question **"if I change X, what else touches it?"** without reading every consumer.

This file complements [CLAUDE.md](CLAUDE.md) — CLAUDE.md is the narrative architecture doc; this is the relationship/dependency map.

## How to use

1. **Before changing a service or a shared invariant**, find its section here.
2. Walk the **Used by** / **Writers** / **Readers** lists to see what depends on the thing you're touching.
3. Run through the **When changing this** checklist before opening a PR.
4. **Keep this file current.** Per CLAUDE.md's commit-review rule, every commit re-reads `TOUCHES.md` for staleness — if your change moved writers/readers, broke an invariant, or invalidated a checklist item, fix it in the same commit.

## Format

**Per-service** sections:
- **What it owns** — one-sentence responsibility
- **Public API** — exported symbols
- **Cross-service deps** — other `src/services/*` files this one imports
- **Used by** — external callers (`file → symbol — purpose`)
- **Invariants** — rules every caller must respect
- **When changing this** — pre-merge checklist

**Cross-cutting** sections swap **Used by** for separate **Writers** / **Readers** lists since the concern spans many files.

> **Reference convention:** code references are `path/file.ts → symbolName()` — we deliberately omit line numbers because they drift constantly on large files. Grep the symbol name to locate it.

## Sections

- [Cross-cutting concerns](#cross-cutting-concerns) (18)
- [Per-service touches](#per-service-touches) — alphabetical; covers the highest-traffic of the 65 services in `src/services/` (not every service has a section)

---

# Cross-cutting concerns

## cross-cutting/five-state-monitor-machine

**What it is:** Asset.monitorStatus ∈ {up, warning, recovering, down, unknown} driven by consecutiveFailures/consecutiveSuccesses counters (see "Five-state monitor machine" in CLAUDE.md).

**Writers** (files that mutate or emit this state):
- `src/services/monitoringService.ts` — runProbeFor() updates Asset.monitorStatus/consecutiveFailures/consecutiveSuccesses after each probe result, stamps Asset.monitorStatusChangedAt whenever monitorStatus changes value (any-to-any, not just up↔down), emits monitor.status_changed Event on transitions INTO up/warning/down (not recovering/unknown, never per-poll), fires propagateAfterStatusChange() — but only on the confirmed up/down edge, NOT on the warning edge — to push the change into descendant dependencySuppressed state
- `src/jobs/monitorAssets.ts` — Light/heavy ticking loops invoke runMonitorPass() which dispatches probe collection
- `src/jobs/backfillMonitorStatusChangedAt.ts` — One-shot startup (60s after boot): seeds Asset.monitorStatusChangedAt for pre-existing warning/down/recovering assets from the latest monitor.status_changed Event when one is still within the 7-day retention window
- `src/api/routes/assets.ts` — recordProbeResult() on manual /probe-now endpoint
- `src/api/routes/assets.ts` — PUT /assets/:id validateMonitorConfig handler resets consecutiveFailures on manual disable
- `src/db.ts` — Prisma extension clampMonitoredForStatus() forces monitored=false and resets consecutiveFailures when status flips to decommissioned/disabled

**Readers** (files that consume it):
- `public/js/assets.js` — Status pill renderer colors by monitorStatus (green/amber/blue/red/grey)
- `public/js/assets.js` — intermittency-bar client-side replay engine reads monitorStatus to color per-sample cells
- `src/services/monitoringService.ts:runMonitorPass()` — Heavy-cadence suppression gate: telemetry/systemInfo only run when monitorStatus==="up" AND !dependencySuppressed; probe interval doubles when dependencySuppressed (parent down)
- `src/services/dependencyTreeService.ts` — reconcileDependencySuppression() reads monitorStatus to evaluate "all-down" suppression — only the confirmed-down edge propagates (warning/recovering do NOT)
- `src/api/routes/map.ts` — Device Map topology endpoint reads monitorStatus for FortiGate/switch/AP health coloring via monitorStatusToHealth()
- `src/jobs/monitorAssets.ts` — Queue eligibility check consults monitorStatus + dependencySuppressed
- `src/api/routes/dashboard.ts` — `/dashboard/summary` reads `monitored=true AND monitorStatus in (warning, down)` for the Monitor Alerts card and orders by `monitorStatusChangedAt asc nulls last` so the oldest outages surface first
- `public/js/dashboard.js` — Monitor Alerts card renders the duration since monitorStatusChangedAt; re-ticks the label every 30s without re-fetching

**Invariants:**
- State machine accepts only {up, warning, recovering, down, unknown}; no other string values permitted.
- Transition to "down" happens when consecutiveFailures ≥ failureThreshold; to "up" when consecutiveSuccesses ≥ failureThreshold (same threshold both directions).
- "recovering" is the transient mid-recovery state (was-down, now succeeding). Exits to "up" once the success threshold is crossed.
- "warning" is mid-degradation (was-up, now accumulating failures but below threshold). Exits to "down" when threshold crossed, back to "up" on success.
- monitor.status_changed Event is edge-triggered: it fires on the transition INTO up / warning / down (so an operator sees the first successful poll, the first warning, and the first down — plus recovery, which is a →up edge). It never fires per-poll (up→up etc. are suppressed by previousStatus===nextStatus) and never fires for the intermediate "recovering"/"unknown" states. Level is "info" for →up, "warning" for →warning and →down. propagateAfterStatusChange() and triggerRetryAfterStatusChange() are decoupled from the event: they fire from a SEPARATE guard gated to the confirmed up/down edge only (a "warning" edge logs an event but does NOT propagate suppression or kick the retry job) — dependency suppression still follows the confirmed-down edge, never the flap.
- monitorStatusChangedAt is stamped on EVERY transition (any-to-any), independent of the Event audit trail. The column is the source for the Dashboard's "how long has this been warning/down" duration. Backfill from the Event log seeds it from the latest monitor.status_changed Event still within the 7-day window; older outages render "—".
- Heavy cadences (telemetry/systemInfo/fastFiltered) are suppressed when monitorStatus ≠ "up" OR dependencySuppressed. The probe runs at 2× cadence when dependencySuppressed AND responseTimePolling !== "disabled".
- Response-time probe runs in every state; it's the cheap path that detects recovery.

**When changing this:**
- Verify every state assignment matches the rules above (no bypass paths).
- Check assets.js intermittency-bar replay logic replays the five-state machine forward correctly (must use same failureThreshold).
- Confirm monitor.status_changed Event audit trail only has →up / →warning / →down transitions (never →recovering, →unknown, or same-state per-poll repeats = bug).
- Test manual /probe-now against a down asset — should advance consecutiveSuccesses and possibly transition to recovering within one call.
- Check Map topology endpoint colors match asset list Status pills (monitorStatusToHealth must be consistent).
- Verify clamp logic in db.ts doesn't interfere: disable should reset, but re-enable (flip to active) should not auto-resume monitoring.
- If touching the cadence dispatch (runMonitorPass / publishDueWork): mirror EVERY change in BOTH `src/services/monitoringService.ts` AND `src/jobs/monitorAssets.ts` — they're parallel implementations and must stay in lock-step.

---

## cross-cutting/asset-source-projection

**What it is:** Multi-source asset discovery unified via AssetSource rows and deriveAssetSources() / projectAssetFromSources() pure functions (see "Asset projection priority table" in CLAUDE.md).

**Writers** (files that mutate or emit this state):
- `src/db.ts` — Prisma extension shadowWriteAssetSources() upserts AssetSource rows on every asset.create/update/upsert when assetTag/tags/discoveredByIntegrationId change
- `src/api/routes/integrations.ts` — upsertFortigateFirewallAssetSource() / upsertFortinetInfraAssetSource() for FMG/FortiGate firewall/switch/AP discovery
- `src/api/routes/integrations.ts` — Entra/Intune upsert paths (buildEntraSource / buildIntuneFdmSource + upsertEntraIntuneSources)
- `src/api/routes/integrations.ts` — fortigate-endpoint AssetSource stamping on DHCP endpoint discovery
- `src/api/routes/integrations.ts` — Active Directory / Windows Server discovery paths upsert ad / windowsserver source rows
- `src/jobs/backfillAssetSources.ts` — One-shot startup: derives sources from legacy assetTag / sid: / ad-guid: tag conventions
- `src/utils/assetSourceDerivation.ts` — deriveAssetSources() implements source derivation rules for both shadow-write and backfill
- `src/services/assetMergeService.ts` — mergeAssets() re-binds ALL of an absorbed asset's AssetSource rows onto the survivor (operator-driven merge, `POST /assets/:id/merge`) — the inverse of the per-source Split (`POST /assets/:id/sources/:sourceId/split`, which re-binds ONE source onto a fresh asset). Both rely on the global `(sourceKind, externalId)` uniqueness so a re-bind can never collide. Unlike the automatic `mergeDuplicateHostnameAssets` job / `acceptAssetConflict`, merge PRESERVES the ghost's sources (re-bind) rather than cascade-deleting them.

**Readers** (files that consume it):
- `src/utils/assetProjection.ts` — projectAssetFromSources() reads AssetSource rows and applies priority rules to build ProjectedAsset shape
- `src/api/routes/assets.ts` — Asset read endpoints attach AssetSource rows in the assetSources relation
- `src/services/projectionDriftService.ts` — Compares projectAssetFromSources() output against Asset field values to detect drift
- Discovery paths use projectAssetFromSources() output as the source of truth for Asset field writes (Phase 3b.1 cutover pending)

**Invariants:**
- Every AssetSource row must have sourceKind + externalId (unique key); created/updated by discovery or the shadow-write extension.
- inferred=true rows are backfill skeletons; projection ignores them (they predate real discovery).
- observed JSON blob is owned by the discovery pathway that explicitly writes it (Phase 2+); shadow-write never touches observed on update, only on initial create.
- Priority rules in projectAssetFromSources() are immutable for production stability; tuned from shadow-drift logs and locked with operators.
- Fortinet infrastructure (firewall/switch/AP) sources are derived from serial + manufacturer + assetType during backfill; discovery writes explicit "fortigate-firewall" / "fortiswitch" / "fortiap" source rows.
- `fortiswitch` observed blob owns `baseMac` — management MAC of the FortiLink-peer interface, captured by cross-joining `/api/v2/monitor/switch-controller/detected-device` rows where `is_fortilink_peer===true` AND `switch_id===<this switch's switch-id>` against the `managed-switch/status` roster, done inside the per-FortiGate detected-device loop in BOTH `fortimanagerService.ts` (Step 3d.5) and `fortigateService.ts` (Chain C / Step 3e.5). Stamped on `Asset.macAddress` + `macAddressRows` at create time AND reconciled into `AssetMacAddress` on update so the next discovery cycle's MAC-keyed dedup paths (Phase 7 device-inventory, Phase 7.5 MAC-table enrichment, and the FortiSwitch lookup's MAC fallback) recognize the switch and never spawn a phantom `fortigate-endpoint` asset alongside it. One-shot job `mergeFortiswitchEndpointGhosts` handles historical orphans created before this capture landed; the broader periodic `mergeDuplicateHostnameAssets` (boot + every 30 min) catches the post-baseMac shape (switch already has its MAC, but a sibling `fortigate-endpoint` row with the same hostname still exists) AND every other duplicate-hostname pattern (workstation ghosts from multi-MAC devices, Phase-1 backfill `manual`-only leftovers, FortiAP equivalents) by grouping on `lower(hostname)` and picking a canonical by source-kind tier.
- fortigate-endpoint source is stamped on endpoint-type assets discovered via DHCP; marked as infra if assetType is "firewall"/"switch"/"access_point".
- `fortigate-firewall` observed blob owns the THREE coord tiers (`snmpGeocodedLatitude/Longitude`, `metavarLatitude/Longitude`, `latitude/longitude`) plus `snmpLocation`. Latitude/longitude projection rules walk the three tiers in that order on the SAME source kind, validating each (lat,lng) pair as a whole via `isValidGeoCoord` so a half-valid tier falls through instead of mixing values. `snmpLocation` is its own projected field (string).
- HA-cluster firewalls (a-p / a-a) get one `fortigate-firewall` source row PER physical member, keyed on each member's own stable serial. The observed blob carries member-specific `serial` / `hostname` / `mgmtIp` plus cluster-wide `haMode` / `haRole` / `haPeerSerial`. The standby member's `mgmtIp` is null (cluster IP only reaches the active member). Phase 3 fan-out keys each member's Asset lookup on its OWN serial — never on `device.sn` which flips on failover.
- `fortigate-firewall` carries `mgmtMac` (the management-interface MAC, scalar identity) + `interfaceMacs` (**every physical interface MAC**). Both read from `/api/v2/cmdb/system/interface` — fetched WITHOUT a name filter so all interface MACs are captured — on the SAME query that resolves `mgmtIp` (zero extra REST calls), in `fortigateService.ts` (standalone + FMG-direct, which delegates here) AND the FMG proxy-lane interface query in `fortimanagerService.ts` (`fields:["name","ip","macaddr"]`, no filter). Normalized via `normalizeMacOrNull` / `normalizeMacsDistinct` (`src/utils/mac.ts` — colon-uppercase, all-zero loopback/tunnel MACs dropped, deduped). The union (mgmt MAC first) is stamped on `Asset.macAddress` (= mgmt MAC) + all of them into `macAddressRows` at create AND reconciled into `AssetMacAddress` on update (mirrors the `fortiswitch` baseMac pattern), **primary HA member only** (undefined for the standby — the MACs belong to the active box). Purpose: get the firewall into discovery's in-memory `byMac` index keyed on EVERY interface MAC, so Phase 7 device-inventory / Phase 7.5 MAC-table recognize it no matter which interface a peer FortiGate sighted (the ghost MAC isn't always the mgmt interface) and never spawn a duplicate `fortigate-endpoint`. `mgmtMac` + `interfaceMacs` are recorded in the observed blob for the Sources tab but are NOT projection-owned (`macAddress` is written directly, like `learnedLocation`). Pre-existing firewall ghosts converge via `mergeDuplicateHostnameAssets`. Note: a firewall asset can now carry many MAC rows (one per physical port); the asset details modal renders them in the contained `All MACs (N)` block.

**When changing this:**
- Modify priority rules only if tuned against real drift logs and agreed with operators (don't guess).
- If adding a new discovery source kind, pair it with an AssetSource upsert in the discovery path AND update deriveAssetSources() rules for backfill coverage.
- Adding a new mergeable Asset scalar field? Add it to `MERGEABLE_FIELDS` in `src/services/assetMergeService.ts` AND the `_mergeCompareFields` list in `public/js/assets.js` (they must stay in sync — the modal and the service agree on what's diffable/winner-pickable).
- Test shadow-write: create an asset with assetTag, verify AssetSource row exists; update assetTag, verify the row is refreshed.
- Run projectionDriftService on next discovery cycle and check pino logs for "asset.projection.drift" — should be silent on stable sources.
- Verify backfill catches the new source kind: run startup job, spot-check a few assets have the right AssetSource rows.

---

## cross-cutting/polling-method-resolver

**What it is:** Four-tier cascade resolving which polling method (REST API / SNMP / WinRM / SSH / ICMP / Disabled / Polaris Agent) is used for each asset's response-time / telemetry / system-info / fastFiltered probes (see "Monitor Settings Hierarchy" + "Polling-method compatibility matrix" in CLAUDE.md). The `"agent"` method short-circuits the periodic puller (probeAsset / collectTelemetry / collectSystemInfo / collectFastFiltered all early-return) because the Polaris Agent on the host pushes its own samples via `POST /api/v1/agents/samples`.

**Writers** (files that mutate or emit this state):
- `src/api/routes/assets.ts` — PUT /assets/:id sets per-asset override columns (responseTimePolling / cpuMemoryPolling / temperaturePolling / interfacesPolling / lldpPolling / storagePolling); also `lldpIntervalSec` / `storageIntervalSec` (Phase 2 carve-out).
- `src/api/routes/monitorSettings.ts` — POST/PUT MonitorClassOverride upserts class-tier overrides. **As of Phase 2, integration-scoped writes (`integrationId !== null`) are rejected with 400** — manual scope only.
- `src/api/routes/integrations.ts` — Integration config JSON holds tier-3 `monitorSettings` (flat baseline) PLUS Phase 2 per-class `streams` blocks under `<klass>Monitor.streams.<stream>` (FMG/FortiGate: fortigateMonitor/fortiswitchMonitor/fortiapMonitor; AD/Entra/WinSrv: workstationMonitor/serverMonitor).
- `src/api/routes/serverSettings.ts` — PUT /server-settings updates tier-4 manualMonitorSettings Setting
- `src/jobs/migrateMonitorSettingsPerClass.ts` (Phase 2) — One-shot startup migration seeding per-class streams from the flat baseline + folding historical integration-scoped MonitorClassOverride rows + deleting absorbed rows. Idempotent via `monitorSettingsPerClassMigratedAt` Setting marker. Invalidates the resolver cache at the end.
- `src/services/monitoringService.ts:resolveMonitorSettings / resolveMonitorSettingsWithProvenance` — Only readers; these are pure resolvers, not writers. **Phase 2 cache key is `${integrationId}:${assetType}`** so each per-class branch caches independently; `invalidateMonitorSettingsCache({integrationId})` without assetType walks every `<integrationId>:*` entry.

**Readers** (files that consume it):
- `src/services/monitoringService.ts:runMonitorPass` — per-stream (probe/telemetry/systemInfo/fastFiltered) dispatch branches consult resolved settings to pick method + timeout + retry logic
- `src/jobs/monitorAssets.ts` — publishDueWork() and light/heavy loops call resolveMonitorSettings() to determine which assets are due for each cadence
- `public/js/assets.js` — Asset Monitoring tab UI renders manual override tier (per-asset dropdowns + per-stream SNMP credential pickers + per-stream MIB pickers); class override editor renders all three sub-rows (polling, credential, MIB) per stream
- `public/js/integrations.js` — Integration Monitoring tab renders the integration tier as **per-class subtabs** (FortiGate/FortiSwitch/FortiAP for FMG+FortiGate; Workstations/Servers for AD/Entra/WinSrv) each wrapping a **per-stream subtab strip** (Response Time / CPU/Memory / Temperature / Interfaces / LLDP / Storage). Each stream subtab carries polling-method dropdown + credential picker + interval + timeout (failure threshold only on Response Time). Class overrides have moved to the Assets-page Monitoring Settings modal. **Phase 2 save handler**: per-class subtabs serialize their own stream values into `Integration.config.<klass>Monitor.streams.<stream>` (FMG/FortiGate via `_readFortigateMonitorBlock("…", {klass, isPrimary})` + `_readClassMonitorBlock("…", {klass, isPrimary, includeStorage?})`; AD/Entra/WinSrv still use the legacy flat path in the current UI iteration). Helper: `_readClassStreamSubtabs(klass, isPrimary, includeStorage)`. **Phase 2 load handler**: `_classStreamsBlockFor(klass, opts)` picks the matching per-class block from opts; `_classSettingsOverlay(flatSettings, classStreams)` overlays it onto the flat baseline before passing to each stream subtab so each class's own saved values render. Canonical helper: `_classStreamSubtabHTML(idPrefix, sourceKind, klass, stream, settings, credentials, isPrimary, opts)` — see `TEMPLATES.md` "Polling methods section (per-stream subtab strip)" entry for the full contract. Per-source-default label generator: `_polarisSourceDefaultPolling(source, stream)` + `_polarisSourceLabel(source, fmgDirectMode)`. Class subtab spec: `_CLASS_SUBTAB_SPECS`. Form readers: `_polarisReadPollingFourStream` / `_polarisReadCredFourStream` / `_polarisReadMibFourStream`. Geographic Location (pullSnmpLocation / pushGeocodedCoords) now lives in its own top-level tab on FMG + standalone FortiGate, NOT under Monitoring. ICMP is rendered only on Response Time stream dropdowns (filtered in `_polarisPollingDropdownHTML`); backend write-time check in `monitorSettings.ts:assertPollingCompatible` mirrors this.
- `src/api/routes/assets.ts` — GET /assets/:id/effective-monitor-settings endpoint returns full resolved stack + provenance (used by System tab intermittency-bar replay, by per-stream chart badges to label which tier supplied each polling method — see _streamBadgeText in public/js/assets.js — AND by the stale-data banner threshold; the three callers in assets.js cache `eff.resolved` in `_effectiveResolvedByAssetId` so banner slots can re-evaluate against the class/integration cadence after first paint)
- `src/api/routes/assets.ts` — GET /assets/:id exposes `discoveredByIntegration.useProxy` (FMG only) so the System tab chart badges can render "Proxy via <fmg>" vs "Direct" without a second round-trip; integration `config` otherwise stripped to keep API tokens out of the response
- **Raw-SQL readers (NOT type-checked against Prisma schema)** — these hardcode the per-stream column names in `prisma.$queryRawUnsafe` strings; a schema column rename will compile clean but 500 at runtime:
  - `src/services/capacityService.ts` — `telemetryEligibleSQL` reads `"cpuMemoryPolling"`; `systemInfoEligibleSQL` reads `"interfacesPolling"`. Used to project steady-state DB size.
  - `src/services/capacityAdvisorService.ts:readApplicableCounts` — same two columns, used to compute per-cadence worker recommendations.

**Invariants:**
- Resolver applies the four-tier cascade strictly in order: per-asset → class-override → integration → manual, first non-null wins.
- Resolved method must be compatible with the asset's source kind (checked by isPollingMethodCompatible against COMPATIBILITY matrix in pollingCompatibility.ts).
- If a higher tier specifies an incompatible method, it silently falls through to the next tier (never error; don't break monitoring).
- Compatibility matrix is locked per CLAUDE.md "Polling-method compatibility matrix"; breaches must go through the design process.
- AD-discovered assets default to ICMP for response-time unless the operator picks winrm/ssh on the per-asset tier (bind-creds fallback at probe time).
- FMG/FortiGate-discovered firewalls default to REST API on response-time / telemetry / interfaces and `disabled` on LLDP (FortiOS REST `lldp-neighbors` is empty on most fleets — operators flip back to `rest_api` if their fleet has it enabled).
- `"agent"` is never a source default — only an opt-in via the operator. Compatible only with AD / Entra / Windows Server / Manual sources (NOT fortimanager / fortigate). When set, probeAsset returns `finish(start, true)` synthetic-success, recordProbeResult early-returns to skip the state machine, and the three collect* dispatchers return `{supported: false}` — the agent on the host is the sole writer for those streams.

**When changing this:**
- Compatibility matrix changes require design review and manual tier updates across the codebase (four UI surfaces).
- If adding a new polling method, update: pollingCompatibility.ts, monitoringService.ts dispatch branches, all four UI tiers (assets.js / integrations.js / serverSettings.js), and test tier resolution.
- Verify fallthrough logic: resolve a method that's incompatible for an asset's source and confirm it doesn't get used (add a test to monitoringService).
- Check every stream independently: one asset might have responseTimePolling=snmp, cpuMemoryPolling=rest_api, temperaturePolling=snmp, systemInfoPolling=icmp; all valid per source.
- Audit UI disable-logic matches the matrix (if a source doesn't support REST API, the dropdown should not offer it).
- **Renaming a per-stream column requires updating the raw-SQL readers listed above** — Prisma's typed queries get rewritten automatically by the generated client, but `prisma.$queryRawUnsafe` strings don't. Cross-reference `cross-cutting/schema-migrations-and-prisma-client-lifecycle` for the full rename checklist.

---

## cross-cutting/polaris-agent

**What it is:** Polaris-managed agent installed on remote hosts that pushes monitoring samples back to Polaris over HTTPS and holds a long-lived outbound WebSocket for on-demand probes. New `"agent"` polling-method value (7th) compatible only with AD / Entra / Windows Server / Manual sources. One `ManagedAgent` row per asset, FK cascade. See CLAUDE.md "Polaris Agent polling-method" / "Polaris Agent API surface" and the plan at `~/.claude/plans/the-app-needs-a-glowing-knuth.md`.

**Writers** (state that mutates ManagedAgent / agent.* events):
- `src/services/agentChannelService.ts` — in-memory `Map<managedAgentId, WebSocket>` session manager. `attach()` registers + schedules 30s heartbeat pings + bumps wsConnectedAt + emits `agent.connected`. `detach()` clears the timer, rejects any pending probe-now promises, closes the socket, bumps wsDisconnectedAt + emits `agent.disconnected`. `sendProbeNow(stream, timeoutMs)` is the server-→agent verb used by /probe-now in agent-mode; `refreshConfig()` sends a `refresh-config` frame so the agent re-fetches /config immediately. Idempotent: replacing an existing session for the same agentId closes the old socket.
- `src/api/routes/agentsWs.ts` — `attachAgentWsUpgradeHandler(server)` wires `http.Server.on("upgrade", ...)` to validate the bearer carried in `Sec-WebSocket-Protocol: polaris-agent.v1.bearer.<token>`, then hands the socket to `agentChannelService.attach`. Mounted on the loopback HTTP listener in src/app.ts; agent WS upgrades come in via nginx's proxy_pass with `Upgrade`/`Connection` headers preserved by the reference config. Bearer never echoed back on the upgrade response — the client `ws` library accepts a no-protocol response by default.
- `agent/cmd/polaris-agent/main.go` — host-side Go binary; loads agent.conf, runs /enroll on first boot (persists returned bearer back to agent.conf via Save), then ticks the response-time collect loop + heartbeat loop + outbound WS loop until SIGTERM. Generic across deployments; per-install identity (server URL, cert pin, bearer) lives entirely in agent.conf. Agent runtime lives in `runAgent(ctx, confPath)` so the Windows Service handler can call it under the SCM. The storage and interfaces push functions (`pushStorageOne`, `pushInterfacesOne`) run their OS-level collectors (`StorageOnce`, `InterfacesOnce`) in a sub-goroutine guarded by a 30 s `time.After` select — `statfs()`/ioctl syscalls can block indefinitely on a hung filesystem or unresponsive network interface, and without this guard the loop goroutine freezes and stops sending all subsequent samples while appearing connected (heartbeat runs independently). **Diagnostic verbose logging:** setting `verbose = true` in agent.conf (`Config.Verbose`, latched into the package-level `verbose` in `runAgent`) makes every sample push log its lifecycle — telemetry emits the full connect→send→validate(accepted/rejected)→disconnect narrative; responseTime/interfaces/storage emit a one-line `sent: … -> accepted=N rejected=N`. Off by default (success paths are silent). Server-side counterpart: `POLARIS_AGENT_SAMPLE_LOG=1` on the web role logs each inbound `/samples` push in `src/api/routes/agents.ts` (received count + first telemetry values + enqueued count) — pair the two to trace a round-trip and localize loss to agent-collect / transport / server-accept / buffer-write.
- `agent/cmd/polaris-agent/service_windows.go` (+ `service_other.go` stub) — Windows Service Control Manager integration via `golang.org/x/sys/windows/svc`. On Windows the entry point calls `svc.IsWindowsService()` first; if true, dispatches to `svc.Run(...)` which calls `Execute(args, r, status)` on the `polarisService` handler. The handler reports StartPending → Running, spawns `runAgent` in a goroutine, then translates SCM `Stop`/`Shutdown` requests into `context.Cancel`. Without this scaffolding, the SCM kills the process after ~30 s because plain Go binaries don't call `StartServiceCtrlDispatcher`. Non-Windows stub returns false so main() falls through to the SIGTERM-driven path.
- `agent/internal/transport/ws.go` — outbound WebSocket client using `gorilla/websocket`. NewWSDialer wires TLS pinning (same `pinned.TLSConfig` used by HTTP) + carries the bearer in subprotocol. RunWithReconnect loops Dial + Run with exponential-backoff + full-jitter; never gives up.
- `agent/internal/config/config.go` — Load/Save the INI-style agent.conf. Save() is atomic (write-tempfile + rename) and chmods 0600.
- `agent/internal/transport/client.go` — HTTP client that fires Enroll / PushSamples / Heartbeat / FetchConfig. Bearer stored on the Client struct; SetBearer() called once after enrollment.
- `agent/internal/pinned/tls.go` — VerifyPeerCertificate that compares the leaf SHA-256 against the pin from agent.conf. tls.Config has InsecureSkipVerify=true so the standard chain check (which consults system roots) is skipped — pin verification is the only thing that fires.
- **Cert pin source.** The pin embedded in `ManagedAgent.serverCertFingerprint` at install kickoff comes from `certInfo.getServerCertFingerprint()`, which reads the same cert file nginx serves (`POLARIS_PROXY_CERT_PATH`). Phase 2's dual-pin column (`additionalServerCertFingerprints[]`) lets operators stage a new pin via the Maintenance card before rolling nginx's cert.

### Cert pin rotation (Phase 2 dual-pin)

**What it is:** zero-downtime server-cert rotation across the agent fleet. Each `ManagedAgent` row carries `serverCertFingerprint` (canonical / first pin) + `additionalServerCertFingerprints String[]` (operator-staged additional pins). The union is the agent's trust set. Migration: `20260606000000_managed_agent_additional_cert_fingerprints` (additive, NOT NULL DEFAULT `ARRAY[]::TEXT[]`).

**Writers** (places that mutate the pin set):
- `POST /server-settings/agents/cert-pins/bulk-add` (`src/api/routes/serverSettings.ts`) — appends to `additionalServerCertFingerprints` on every active agent that doesn't already have it. Fires `refreshConfig(managedAgentId)` per agent so online agents apply within seconds. Emits one `agent.cert_pin_staged_bulk` Event with `{pin, added, alreadyPresent, totalActive}`.
- `POST /server-settings/agents/cert-pins/bulk-remove` — removes from the union (canonical OR additional). When the canonical pin is removed and at least one staged pin remains, the FIRST staged pin is promoted to canonical (so the legacy `cert_fingerprint` line still reflects "the current cert"). Skips any agent where removal would leave zero pins (`lastPinSkipped: N`). Emits `agent.cert_pin_retired_bulk`.
- `agentInstallService.renderAgentConf` reads `row.serverCertFingerprint` + `row.additionalServerCertFingerprints` and serializes the union as `cert_fingerprints = pin1,pin2,...` PLUS the legacy `cert_fingerprint = <canonical>` line for downgrade compatibility with pre-Phase-2 agent binaries.

**Readers** (server side):
- `POST /api/v1/agents/enroll` (`src/api/routes/agents.ts`) — checks the agent's observed fingerprint against the union `[serverCertFingerprint, ...additionalServerCertFingerprints]`. Mismatch on the entire set fails enrollment with `agent.install_failed`.
- `GET /api/v1/agents/config` (`src/api/routes/agents.ts`) — ships `certFingerprints` (the union) in the response payload alongside cadence/stream settings. The ETag covers `certFingerprints` so a pin-only change still invalidates the 304 cache.

**Readers** (Go agent side):
- `agent/internal/config/config.go` — `Load` parses `cert_fingerprints` (comma-separated, lower-cased, whitespace-trimmed); falls back to legacy `cert_fingerprint` (single) when the new key is absent. `Pins()` is the canonical accessor; `SetPins()` diffs against the current set and returns true on change. `Save()` always writes BOTH keys so a downgrade to a pre-Phase-2 binary keeps the canonical pin live.
- `agent/internal/pinned/tls.go` — `VerifyPeerCertificate(expected []string)` accepts the presented cert if its SHA-256 matches ANY pin in the set. Malformed entries are silently skipped (good pin in a noisy set still works); an all-malformed set produces a verifier that always rejects.
- `agent/cmd/polaris-agent/main.go` — when the WS `refresh-config` frame arrives, the agent fetches `/agents/config`, compares the returned `certFingerprints` against `cfg.CertFingerprints` via `cfg.SetPins`, saves `agent.conf` if changed, then calls `os.Exit(0)` so systemd cycles the process with the new pin set live.

**Invariants:**
- The union (canonical + additional) MUST never be empty for any active `ManagedAgent` row — bulk-remove enforces this with `lastPinSkipped`. An empty pin set bricks the agent's TLS dialer until manual reinstall.
- The order of the union (canonical first, additional in array order) becomes the order of `cert_fingerprints` in agent.conf. The Go agent's `Pins()` preserves order; the legacy `cert_fingerprint` reader sees the canonical (first) pin.
- `additionalServerCertFingerprints` is a SET semantically — bulk-add is idempotent (no duplicates); bulk-remove takes one pin at a time.

**Operator workflow** (Maintenance card → Polaris Agent → "Cert pin rotation"):
1. Stage new pin → `bulk-add` propagates fleet-wide → online agents apply via WS push within seconds, offline agents apply on next /config poll then exit-for-restart.
2. Rotate the server cert (nginx reload OR Polaris HTTPS hot-rotate). Agents keep working — both pins are trusted.
3. Wait for every agent to heartbeat. The Maintenance UI shows per-pin canonical/staged counts so the operator can confirm uptake.
4. Retire old pin → `bulk-remove` promotes a staged pin to canonical on every agent → agents apply, restart, re-narrow trust to the new pin only.

**When changing this:**
- ADDING a new field that affects the pin set: schema migration + Prisma client regen + `agentInstallService.renderAgentConf` + Go agent's config parsing/saving + Go agent's `pinned.VerifyPeerCertificate`. ALL FIVE in lockstep — or agents and server disagree on what trust set is active.
- ADDING a new endpoint that mutates the pin set: include `refreshConfig(managedAgentId)` per affected agent (online agents apply fast), log an `agent.cert_pin_*` Event (audit trail), enforce the "non-empty union" invariant in the route handler (don't trust callers).
- CHANGING the agent.conf wire format: both `agentInstallService.renderAgentConf` and `agent/internal/config/config.go` Load/Save in lockstep. Phase 2 keeps the legacy `cert_fingerprint` line for one release cycle of downgrade safety — don't drop it without a major version bump.
- `src/api/routes/assets.ts:POST /:id/agent/install` — create row in `pending` (stamping `installCredentialId` + `installTransport` so retry/uninstall/upgrade can replay the same transport); capture cert pin; emit `agent.install_kickoff`; fire `agentInstallService.startInstall` async. Validates that the credential type matches the resolved transport (`ssh` cred for SSH; `winrm` cred for WinRM); refuses `transport=winrm` on non-Windows.
- `src/api/routes/assets.ts:DELETE /:id/agent` — synchronous revokeBearer + (force) hard-delete or (default) fire `agentInstallService.startUninstall` async; emits `agent.revoked` synchronously, then `agent.uninstalled` / `agent.uninstall_failed` from the async path.
- `src/services/agentInstallService.ts:startInstall` — async transport-aware install. Dispatches on `(osPlatform, installTransport)`. SSH-to-Linux/macOS: SFTP upload binary + conf + installer script to /tmp, `sudo -n bash` the installer. WinRM-to-Windows: PowerShell installer via `-EncodedCommand`; the script downloads the binary over HTTPS from `/api/v1/agents/binary/:filename` with a cert-pin validation callback. SSH-to-Windows: SAME PowerShell installer, SFTP'd to `C:/Windows/Temp/polaris-agent-install.ps1` (UTF-8 with BOM so PS5.1 decodes non-ASCII correctly) then invoked via `powershell.exe -ExecutionPolicy Bypass -File <path>` (requires OpenSSH Server on the target). Cannot use `-EncodedCommand` here because the base64-encoded UTF-16LE payload overflows cmd.exe's 8191-char command-line limit — the WinRM path doesn't go through cmd.exe so it stays on `-EncodedCommand`. All three paths transition `pending → uploading → enrolling`. Failure lands as `installStatus="failed" + installError + agent.install_failed` event.
- `src/services/agentInstallService.ts:startUninstall` / `startUpgrade` — async mirrors that branch on the same `(osPlatform, installTransport)` tuple as install, replaying the transport the original install used.
- `src/services/agentAutoDeployService.ts:runAutoDeployForClass` — discovery-time auto-deploy for AD/Entra workstation/server classes. Creates the same `pending` ManagedAgent row the manual `/agent/install` route does (osPlatform/arch/installTransport/serverCertFingerprint/installCredentialId) then fires `startInstall`. **Reuses the manual install machinery — DO NOT diverge from the `/agent/install` row-creation contract; if that route's required ManagedAgent fields change, change here too.** Eligibility filter is `managedAgent: { is: null }` (one row per asset = idempotent; never re-kicks). Driven from `integrations.ts:runWorkstationServerAgentAutoDeploy` (post-sync pass) which reads `config.{workstationMonitor,serverMonitor}.agentDeploy` and checks `checkAutoDeployPreconditions()` once. Opt-in (default off); bounded by `agentDeploy.maxConcurrent` (cap 20) minus in-flight + `RUN_CEILING=200`.
- `src/utils/winrm.ts:winrmRunOne` — minimal WS-Management WinRS client. CreateShell → RunCommand → poll Receive until `CommandState=Done` → DeleteShell (always in finally). Used only by agentInstallService Windows-via-WinRM path; not for monitoring probes (those use the lightweight Identify-only path in monitoringService.probeWinRm).
- `src/api/routes/agents.ts:agentsBinaryRouter` — `GET /api/v1/agents/binary/:filename`. Public, whitelist-checked against `data/agents/manifest.json` (only filenames the manifest declares for the current version are served; everything else 404s). Directory-traversal protected. Both Windows install paths download from here via the embedded `Invoke-PolarisPinnedDownload` PS helper, which talks straight to nginx over a `System.Net.Sockets.TcpClient` + `SslStream` + raw HTTP/1.1 — bypasses HttpWebRequest / Invoke-WebRequest because the latter's HKCU-dependent proxy resolution and ALPN/HTTP2 negotiation are flaky under powershell.exe launched non-interactively over OpenSSH on Windows.
- `public/js/assets.js:assetAgentSubpanelHTML` / `_wireAgentSubpanel` — System-tab Polaris Agent sub-panel renderer + button wiring. Visible only when the operator has expressed intent (an agent exists OR at least one per-asset *Polling column is "agent"). Auto-polls every 3 s while installStatus is one of pending / uploading / enrolling / uninstalling; stops when the modal closes (checked via the `#asset-agent-panel`'s `data-asset-id` sentinel).
- `public/js/assets.js:_openInstallAgentModal` — install modal using canonical `openModal(title, body, footerHTML)` + bound primary-button onclick (validation can hold the modal open). On Windows, exposes a WinRM/SSH transport radio that swaps the cred picker between winrm-typed and ssh-typed credentials; on Linux/macOS only the SSH cred picker is shown. POSTs `{credentialId, osPlatform, arch, transport}` to `/agent/install`. OS pre-fills from `Asset.os`.
- `public/js/assets.js:_confirmUninstallAgent` — wraps `showConfirm` Promise; on resolve(true) calls `api.assets.deleteAgent(id, {force})`.
- `src/api/routes/agents.ts:POST /enroll` — consumes the enrollment token, mints a long-lived bearer, transitions installStatus → "active"; emits `agent.enrolled`. Cert-pin mismatch sets installStatus="failed" and emits `agent.install_failed`.
- `src/services/agentTokenService.ts:verifyBearer` — runs on EVERY bearer-gated call; best-effort bumps `lastSeenAt`/`lastSeenIp`, AND self-heals a stuck `installStatus="enrolling"` → `"active"`. This covers the re-install/re-push case where `startInstall` reset status to "enrolling" but the agent reused the bearer already in agent.conf and short-circuited `/enroll` (so nothing else would ever flip it active). Scoped to "enrolling" only — never touches upgrading/uninstalling/failed states.
- `src/api/routes/agents.ts:POST /samples` — bumps lastSeenAt (via verifyBearer) + lastTelemetryAt / lastSystemInfoAt per stream; calls recordProbeResult({fromAgent:true}) for the responseTime stream so the five-state machine runs on agent-pushed RTTs.
- `src/api/routes/agents.ts:POST /system-info` — upserts the `polaris-agent` AssetSource row (externalId = managedAgent.id, observed = full host identity blob), then re-projects hostname / serialNumber / manufacturer / model / os / osVersion against all sources for the asset. Also writes MAC inline: normalize `primaryMac` → colon-upper, merge into `AssetMacAddress` via `reconcileMacAddresses` preserving entries from other sources, set `Asset.macAddress` to the freshest entry by `lastSeen`. MAC isn't owned by `projectAssetFromSources` — every discovery path writes it inline; the agent path matches that convention. Opportunistically bumps `ManagedAgent.agentVersion` when the body carries it.
- `src/api/routes/agents.ts:POST /heartbeat` — refresh agentVersion + bump lastSeenAt.
- `src/services/agentTokenService.ts` — `mintEnrollmentToken` (10-min TTL), `consumeEnrollmentToken` (atomic swap → bearer + stamps asset's 5 per-stream `*Polling` columns to `"agent"` in the same transaction so the active agent owns every stream), `revokeBearer` (sets bearerRevokedAt).
- `src/api/routes/agents.ts:GET /config` (write side) — self-heals polling-method drift. When any of `responseTimePolling` / `cpuMemoryPolling` / `temperaturePolling` / `interfacesPolling` / `lldpPolling` / `storagePolling` isn't `"agent"`, re-stamps all six, invalidates the monitor-settings cache for the asset's scope, and emits `monitor.polling_overridden_by_agent` (info) with the prior values. Covers historical assets enrolled before consumeEnrollmentToken stamped polling columns (pre-commit d43b9d8) and any post-enroll operator clears. Idempotent — once stamped, subsequent /config polls find no drift and skip the write.

**Readers** (consume state):
- `src/api/middleware/auth.ts:requireAgentBearer` — verifies the bearer against the ManagedAgent token store and attaches `{managedAgentId, assetId}` to `req.managedAgent`. Used by every `/api/v1/agents/*` route except `/enroll`.
- `src/api/routes/agents.ts:GET /config` — resolves the asset's monitor settings via `resolveMonitorSettings` and returns the per-stream `enabled` (true when that stream is `polling==="agent"`), cadences, and timeouts; carries an ETag so the agent can short-circuit unchanged polls.
- `src/services/monitoringService.ts:probeAsset / collectTelemetry / collectHardwareSensors / collectSystemInfo / collectFastFiltered` — early-return on agent-mode so the periodic puller doesn't touch hosts that the agent owns.
- `src/services/monitoringService.ts:recordProbeResult` — agent-mode guard skipped only when `opts.fromAgent === true`.

**Invariants:**
- ManagedAgent.assetId is `@unique` — one agent install per asset. Reinstall is "delete row + new install."
- Bearer is bound to the assetId at issuance; the /samples handler stamps `req.managedAgent.assetId` server-side and ignores any client-supplied assetId on the wire.
- Cert pin is captured at install kickoff via `certInfo.getServerCertFingerprint()`, which reads `POLARIS_PROXY_CERT_PATH`. Install REFUSES when no fingerprint is available (cert file unreadable, no encrypted transport to pin).
- Enrollment token is one-shot (consumed atomically) and TTL'd to 10 minutes. After consumption it's NULLed on the row; the install state moves to `active` and stays there until DELETE.
- `recordProbeResult` and `record*Result` early-return on agent-mode UNLESS `opts.fromAgent === true` — defends against the synthetic periodic-tick clobbering the agent's real signal.

**When changing this:**
- New sample stream: add Zod variant to `SamplesBodySchema`, map to enqueue helper, mirror in the Go agent collector (Phase 3+).
- New ManagedAgent column: update Prisma model + the route GET /:id/agent response shape (which strips hash fields explicitly).
- Cert-pin algorithm change: update `certInfo.getServerCertFingerprint()` AND the Go agent's TLS verifier in lockstep — server pin AND agent pin both compute fingerprint the same way (sha256 of leaf DER).
- New /agents/* route: decide whether it's public (mount under `agentsEnrollRouter`) or bearer-gated (mount under `agentsRouter`). Both are wired in `src/api/router.ts` BEFORE the blanket `requireAuth` gate.

**Agent code changes MUST bump `agent/VERSION`.** The agent has its own
version string (decoupled from Polaris's version) tracked in the one-line
text file `agent/VERSION`. Any commit that touches files under
`agent/cmd/polaris-agent/`, `agent/internal/collectors/`,
`agent/internal/transport/`, `agent/internal/pinned/`, or `agent/go.mod`
MUST also bump `agent/VERSION` (semver: patch for fixes, minor for new
features, major for breaking wire-protocol changes). The version flows
through three places:

1. Stamped into the binary via `-ldflags='-X main.version=...'` so
   `polaris-agent` reports it and the agent's /heartbeat sends it as
   `ManagedAgent.agentVersion`.
2. Used as the directory name under `data/agents/<version>/` so a
   rebuild produces a new directory rather than overwriting the old
   binaries (the per-version cleanup helper retains a rollback target).
3. Compared by the auto-build job (`src/jobs/autoBuildAgents.ts`) at
   boot. The job fires Build ONLY when `manifest.currentVersion !==
   agent/VERSION` (and a manifest exists, and Go is installed, and the
   `agent.autoBuildOnVersionMismatch` Setting isn't false). Polaris
   patch releases that don't touch agent/ produce zero auto-build
   noise — the load-bearing decoupling.

Forgetting to bump VERSION means:
- The auto-build won't fire.
- Upgrade buttons on installed agents stay hidden (they compare
  `managedAgent.agentVersion` against `manifest.currentVersion`).
- Operators won't see the new behavior until they manually click Build.

When bumping `agent/go.mod`'s `go 1.x` directive, also bump the install
scripts' Go-version pin in `deploy/setup-{rhel,ubuntu,windows}{,-nodb}.{sh,ps1}`
and the Dockerfile's `golang-go` source (currently bookworm-backports)
in lockstep, or operators will get cryptic "missing go.sum entry"
errors when the build runs.

The rebuild + redistribute paths after bumping VERSION:
1. **From the UI:** Server Settings → Maintenance → Polaris Agent →
   Build. Polaris regenerates all 6 binaries using the installed Go
   toolchain. The auto-build job does this for you on the next server
   boot. Existing installed agents do NOT auto-upgrade — operators
   trigger that per-asset via the Upgrade button on the asset details
   modal OR fleet-wide via the "Upgrade all out-of-date" line on the
   Maintenance Polaris Agent card.
2. **From a shell:** `make -C agent all` then copy `dist/<version>/*`
   into `<STATE_DIR>/data/agents/<version>/` + update `manifest.json`.

---

## cross-cutting/polaris-agent-build

**What it is:** In-app build pipeline that produces the six platform
agent binaries (linux/darwin/windows × amd64/arm64) and writes the
`manifest.json` consumed by the install/upgrade flows. Runs `go build`
directly in a child process (no `make` dependency — Windows hosts don't
ship GNU make). FIFO queue (depth 3) + per-build cancellation + post-
build auto-prune + boot-time auto-build are layered on top.

**Writers** (state that mutates):
- `src/services/agentBuildService.ts` — owns everything: state map,
  FIFO queue, mutex, per-build child-process handle, version reads,
  manifest writes, post-build prune. Exports:
  - `goAvailable()` — runs `go version`, no cache. UI / route gate on this.
  - `startBuild({actor})` — queues or runs immediately. 400 on no-Go,
    409 on queue-full (`BuildQueueFullError`). Emits `agent.build.started`
    (immediate) or `agent.build.queued` (enqueued).
  - `cancelBuild(buildId, actor)` — three branches: queued (splice from
    queue), in-flight (SIGTERM + SIGKILL after 5s grace, set
    `state.cancelled` so runBuild sees CancelledError), already-finished
    (`BuildAlreadyFinishedError` → route 409). Emits `agent.build.cancelled`.
  - `pruneOldAgentVersions()` — policy is keep-current + keep-in-use +
    keep-last-N (env `POLARIS_AGENT_KEEP_VERSIONS`, default 3). Fires
    after every successful build + on operator click of the Clean-up
    button on the Maintenance card. Emits `agent.versions.pruned` with
    `trigger: "post-build"|"manual"`.
- `src/api/routes/serverSettings.ts:/agents/*` — admin-only routes
  exposing the service: inventory, build start/poll/current/cancel,
  prune, installed-summary (returns active count + per-version histogram
  + live `upgrading` and `upgradeFailed` counts so the UI can poll for
  in-flight upgrade-all status), upgrade-all (delegates to
  `upgradeAllOutdated` in agentInstallService), auto-build-setting
  GET+PUT, auto-upgrade-setting GET+PUT.
- `src/jobs/autoBuildAgents.ts` — one-shot startup job, fires 60s after
  boot. Five gates in order: manifest exists, version drift, Go
  available, kill-switch off, then `startBuild({actor: "system:auto-
  build-on-version-change"})`. Emits `agent.build.auto_started` (info)
  or `agent.build.auto_skipped` (warning, with reason).
- `src/services/agentInstallService.ts:startUpgrade({managedAgentId,
  credentialId?, actor})` — SSH/WinRM-driven binary swap that preserves
  agent.conf. Transitions installStatus active → upgrading → active.
  Emits `agent.upgrade_kickoff`, `agent.upgrade_succeeded`,
  `agent.upgrade_failed`. The bulk path lives in
  `upgradeAllOutdated(actor)` (same file) — Promise pool of 4 over every
  active ManagedAgent whose agentVersion lags `manifest.currentVersion`.
  Called from both the operator-initiated `POST
  /server-settings/agents/upgrade-all` and the post-build auto-upgrade
  hook in `finalizeBuild` (agentBuildService.ts) gated on
  `Setting.agent.autoUpgradeOnNewBuild`. Auto-path emits
  `agent.upgrade_all_auto_kickoff` so the audit trail distinguishes
  human-initiated from build-triggered fan-outs.
- `src/utils/version.ts:getAgentVersion()` / `getAgentSourceDir()` —
  readers of `agent/VERSION` (not writers, but documenting here for
  proximity). 5s mtime-checked cache; format-validated; fallback
  `"0.0.0-no-version-file"`.
- `deploy/setup-{rhel,ubuntu,windows}{,-nodb}.{sh,ps1}` — install Go
  alongside Node + mkdir `$APP_DIR/data/agents` + `$APP_DIR/.cache/go-build`.
- `Dockerfile` — pulls `golang-go` from bookworm-backports; pre-creates
  `/app/state/.cache/go-build`.

**Readers** (consume state):
- `public/js/server-settings.js:initAgentBuildCard` — Maintenance-tab
  Polaris Agent card. Three states (inventory / progress / progress-
  queued-behind). Auto-poll every 2s while running. Sub-features:
  Upgrade-all line, Clean-up button, Auto-build toggle, × cancel buttons
  on in-flight + queued rows.
- `public/js/assets.js:assetAgentSubpanelHTML` — Upgrade button on
  active agents; Retry Upgrade on `upgrade_failed`. `_isTransientAgentState`
  includes `"upgrading"` so the existing 3s poll picks it up.
- `src/api/routes/agents.ts:agentsBinaryRouter` — `GET /api/v1/agents/binary/:filename`
  serves binaries the Build command produced. Whitelist-checked against
  the current manifest's `binaries` map.

**Invariants:**
- `agent/VERSION` (text file) is the single source of truth. `getAgentVersion()`
  reads it server-side; `agent/Makefile`'s `VERSION` directive reads it shell-side.
  Both feed the same `-ldflags '-X main.version=…'` flag so the in-binary version,
  the manifest's currentVersion, and the directory name all match.
- Single-slot active build + FIFO queue (depth 3). Queue overflow → 409;
  Go missing → 400.
- Per-platform `go build` invocations are serial. Parallel builds would
  thrash the shared GOCACHE for negligible wall-clock win.
- `manifest.json` is written atomically (write `.tmp` + rename) AFTER all
  six platforms succeed. Cancelled mid-flight builds leave a partial
  set under `data/agents/<version>/` but the existing manifest still
  points at the previous version's filenames.
- Prune helper NEVER touches the current version, NEVER touches versions
  in use by a live ManagedAgent (`installStatus !== "revoked"`), and
  ALWAYS keeps the most recent N (default 3, env `POLARIS_AGENT_KEEP_VERSIONS`).
- Auto-build refuses to fire on a fresh install (no manifest = operator
  hasn't opted in). Also refuses when Go isn't available (logs warning
  Event) or when `Setting.agent.autoBuildOnVersionMismatch === false`.
- Upgrade does NOT touch agent.conf. Bearer + cert pin survive; agent
  reconnects with the same identity after the binary swap.

**When changing this:**
- Adding a new platform/arch: extend `PLATFORMS` in `agentBuildService.ts`
  AND `manifest.binaries` shape in `agent/internal/transport/client.go`
  enroll request AND the install/upgrade script templates AND `Dockerfile`'s
  GOARCH support if shipping Polaris on that platform.
- Adding state to BuildState that isn't JSON-serializable: extend `publicView()`
  to drop it before returning to API consumers.
- Touching the install script templates: bump agent/VERSION so deployed
  agents pull the new bytes; the install path is templated server-side so
  changes ship via the next server release, not via agent rebuild.
- Adding a new upgrade-class action (e.g. config-only refresh): add it to
  `_isTransientAgentState` so the asset-details panel's auto-poll picks
  it up.

---

## cross-cutting/deployment

**What it is:** The artifacts an operator touches to install, update, or run Polaris on a host: `deploy/setup-{rhel,ubuntu,windows}{,-nodb}.{sh,ps1}` (six fresh-install scripts; Linux variants install split-role + nginx + self-signed cert in one shot since Phase 3), `deploy/migrate-to-nginx.sh` (legacy-install cutover script, used by pre-Phase-3 hosts that were originally provisioned with the now-removed `polaris.service`), `deploy/update-{linux,windows}.{sh,ps1}` (host-side updaters), `deploy/polaris-{web,monitor@,discovery,migrate}.service` + `polaris.target` (systemd units), `deploy/nginx/polaris.conf` + `polaris-nginx-dependency.conf` (nginx reference config + polaris-web Wants=nginx drop-in), `Dockerfile`, `docker-compose.yml` (gained an nginx service in Phase 3), `.env.example`, `docs/INSTALL.md`, and the first-run setup wizard at `src/setup/setupRoutes.ts`. None of these are read by the running app at request time — they shape how the app gets onto a host and what state it expects to find. See CLAUDE.md "Deployment & Updates" and the "Before any push, audit deployment surfaces" rule.

**Writers** (changes in `src/` that the deployment surface must mirror):
- New environment variable consumed by the app — must appear in `.env.example` with a comment, be documented in the CLAUDE.md "Environment Variables" block, be added to `docs/INSTALL.md` if operator-set, and seeded by the relevant `deploy/setup-*.{sh,ps1}` if those scripts write `.env` for the operator.
- New runtime dependency — bump in `Dockerfile` (apt/dnf install line) AND in every `deploy/setup-*.{sh,ps1}` that provisions a fresh host. Node major version, Postgres major version, Go pin, system `ping` / `snmpwalk` / `pg_dump` — anything spawned via child_process or required by Prisma / pg-boss counts.
- New `POLARIS_ROLE` capability or worker tunable — `src/utils/role.ts → roleConfig`, matching systemd unit in `deploy/polaris-*.service`, and `polaris.target`'s `Wants=` line. New tuning env vars need declaring in the unit's `Environment=` block or in `/etc/polaris/polaris.env` (sourced by units).
- New Prometheus metric stamped from inside a monitor worker or discovery consumer — confirm the role exposing it has a `/metrics` listener. Web/all serve `/metrics` from the main Express app; monitor + discovery boot a standalone listener via `src/utils/metricsServer.ts` only when `POLARIS_METRICS_PORT` is set (defaults in `deploy/polaris-monitor@.service` = `910%i`, `deploy/polaris-discovery.service` = `9110`). A metric added without a scrape target stays invisible — symptom is "no data" panels on the Grafana dashboard. If the Prometheus scrape config in `docs/grafana/README.md` needs a new job, update it.
- New disk-space minimum — bump `src/setup/setupRoutes.ts → RECOMMENDED_DB_FREE_GB` AND the disk-sizing table at the top of `docs/INSTALL.md`. CLAUDE.md "Deployment & Updates" calls this pair out by name.
- New singleton scheduler / one-shot startup migration — confirm it's gated to `POLARIS_ROLE=web` (or unset = `all`) in `src/app.ts` so multi-process installs don't run it on every monitor / discovery replica.
- New first-run setup step — wizard route + UI in `src/setup/`; the `.setup-complete` marker write at finalize still needs to fire (CLAUDE.md "First-run setup lock").
- New encrypted-backup format change — the magic header is `POLARIS\0` (CLAUDE.md naming note); the restore path must accept the current version's dump and reject older formats with a clear error.
- New Go-version requirement in the agent — bump in lockstep across `agent/go.mod`, every `deploy/setup-*.{sh,ps1}` Go pin, and the Dockerfile `golang-go` source. Already documented in `cross-cutting/polaris-agent` "When bumping agent/go.mod's go 1.x directive."
- New non-`.ts` asset read at runtime from a dist-relative path (via `import.meta.url`) — `tsc` does NOT copy data files into `dist/`, so add an entry to `ASSETS` in `scripts/copy-build-assets.mjs` (the second half of `npm run build`). Today that's `src/services/stdMibs/*.txt`, consumed by `stdMibLibrary.ts`. The Docker runtime image ships only `dist/` (no `src/`), so copying into `dist/` is the only correct strategy — a runtime fallback to `src/` would break in a container. All build sites (Dockerfile, every `deploy/setup-*`, both `deploy/update-*`, and `restartService`/the build step in `src/services/updateService.ts`) invoke `npm run build`, never bare `npx tsc`, so the copy runs everywhere a build happens.

**Readers** (artifacts the running app reads from disk that operators provision):
- `.env` — read once at boot via dotenv. CLAUDE.md "Environment Variables" enumerates every key the app honors.
- HTTPS cert/key — nginx terminates TLS for the lifetime of the install. The cert lives at `POLARIS_PROXY_CERT_PATH` on disk; Polaris reads it via `src/services/certInfo.ts` for the agent-pin fingerprint exposure. Server Settings → Certificates renders a read-only informational pane (`GET /server-settings/https`); cert mutation is operator-driven via the file system + `systemctl reload nginx`. CA records stay editable for outbound TLS to LDAP/SMTP/integrations.
- `<STATE_DIR>/data/agents/<version>/` + `manifest.json` — produced by `agentBuildService` or by `make -C agent all`, consumed by the install / upgrade flows.
- `.setup-complete` marker at the project root — `src/app.ts` boot path consults it to decide whether to run the wizard.

**Invariants:**
- `.env.example` is the contract. Any env var the app reads MUST appear there, and the CLAUDE.md "Environment Variables" block mirrors it. Drift here is a footgun — operators upgrade and miss new required keys.
- `scripts/` ≠ `deploy/`. `scripts/` holds maintenance utilities run ad-hoc by operators or developers (`audit-multi-mac-assets.ts`, `check-docs.mjs`, `check-fmg-tokens.ts`, `fetch-std-mibs.mjs`, FMG smoke tests) plus one build-time step, `copy-build-assets.mjs`, invoked automatically by `npm run build` (not ad-hoc — it must run on every compile). `deploy/` holds fresh-install + update scripts and systemd units. New install / update logic belongs in `deploy/`; new ad-hoc diagnostic tooling belongs in `scripts/`.
- Production updates flow through the in-app updater (Server Settings → Maintenance), not manual redeploy. `deploy/update-linux.sh` / `deploy/update-windows.ps1` are operator-facing fallback scripts (NOT invoked by the updater service — the updater does its own git/npm/migrate/restart pipeline in `src/services/updateService.ts`). Changes to update flow need to land in the updater service AND these scripts in lockstep.
- Unit-file sync is implemented in TWO places that must stay in lockstep: `restartService()` in `src/services/updateService.ts` (in-app updater) and `sync_unit_files()` in `deploy/update-linux.sh` (manual fallback). When ADDING a new shipped unit file under `deploy/polaris-*.service` or `deploy/polaris.target`, add its path to BOTH lists, or one of the update paths will silently drop the change on existing installs. Phase 3 removed the single-process branch from both — every install is split-role; the Linux script bails if `polaris.target` isn't enabled.
- Nginx-config sync (proxy-mode only) is also implemented in BOTH places: the `nginxSync` snippet in `restartService()` and `sync_nginx_config()` in `deploy/update-linux.sh`. Same cmp-only-overwrite contract, same `nginx -t` validation, same atomic mv. When changing `deploy/nginx/polaris.conf`, BOTH paths pick it up automatically — but if you add a NEW shipped file under `deploy/nginx/`, add it to BOTH sync helpers explicitly. Operator drop-ins belong outside `deploy/nginx/polaris.conf` (e.g. `/etc/nginx/conf.d/polaris-local.conf`) to survive the sync.
- The first-run setup wizard is unauthenticated by design; the `.setup-complete` marker is the only thing keeping a re-run from being an attack surface on an already-configured host. Don't add a code path that deletes the marker outside the documented "admin with shell access" recovery flow.
- Disk-sizing minimums in `docs/INSTALL.md` are the single source of truth for operator capacity planning. `RECOMMENDED_DB_FREE_GB` in `setupRoutes.ts` and the doc table must agree, or the preflight warning will either over- or under-fire.

**When changing this:**
- Adding a new env var: update `.env.example`, the CLAUDE.md "Environment Variables" block, `docs/INSTALL.md` if operator-set, and any `deploy/setup-*.{sh,ps1}` that seeds `.env`. If it has a sensible default in code, document the default in both places.
- Adding a new runtime dependency (apt/dnf package, Node major bump, Postgres major bump): update Dockerfile + all six `deploy/setup-*.{sh,ps1}` + `docs/INSTALL.md` per-platform sections. Smoke a fresh install against at least one platform.
- Adding a new `POLARIS_ROLE` capability: new entry in `src/utils/role.ts → roleConfig` + new `deploy/polaris-<role>.service` unit + `polaris.target` `Wants=` line + `docs/INSTALL.md` multi-process section + ARCHITECTURE.md role table. If the role doesn't set `runsHttp`, give it a `POLARIS_METRICS_PORT` in its unit file and a Prometheus scrape job entry in `docs/grafana/README.md`, or its in-process counters/histograms stay invisible.
- Bumping the disk-sizing recommendation: change `RECOMMENDED_DB_FREE_GB` and the `docs/INSTALL.md` table in the same commit.
- Renaming or moving a state directory under `POLARIS_STATE_DIR`: search Dockerfile (pinned to `/app/state`), every `deploy/setup-*.{sh,ps1}` (paths under `/opt/polaris/state` on Linux), `docs/INSTALL.md`, and the encrypted-backup restore path. The Docker pin is the load-bearing one — break it and container restarts lose state.

**Related:** `cross-cutting/polaris-agent` (Go-version pin, agent binary distribution path under `data/agents/<version>/`).

---

## cross-cutting/integration-type-onboarding

**What it is:** The complete callsite catalogue for adding a new integration type (Palo Alto firewall, future device families). Every new type touches the same ~30 callsites across backend dispatch, frontend modal, polling compatibility, asset projection, and source-default polling. Without this checklist a new type drifts on tab layout, config-blob keys, transport dispatch, and projection priority; with it, every integration feels uniform.

The canonical to mirror for a standalone-device-with-its-own-API type (most common new case) is **standalone FortiGate**. For a manager-that-fronts-many-devices type, mirror **FortiManager**. For asset-only types (no subnets/reservations), mirror **Entra ID / Active Directory**. See [TEMPLATES.md → Integration type](TEMPLATES.md#integration-type-config--discovery--sync--frontend-modal) for the model-after instruction. This entry is the authoritative checklist.

**Writers** (files that need a per-type branch):
- `src/services/<type>Service.ts` — NEW. Exports `testConnection(config)`, `discoverDhcpSubnets(config, signal?, onProgress?, ...)` returning the shared `DiscoveryResult` shape from `fortimanagerService.ts`, `proxyQuery(config, method, path, query?, body?)` for the manual /query route, and any per-type helpers (e.g. an `xxxRequest()` low-level fetcher used internally).
- `src/api/routes/integrations.ts` — TYPE-SPECIFIC CONFIG SCHEMA: define `<Type>ConfigSchema` (Zod object) at the top of the file. Must include the four uniform top-level keys (`host`, `port`, `verifySsl`, `verboseLogging`) plus `monitorSettings`, `deviceInclude` / `deviceExclude` / `interfaceInclude` / `interfaceExclude` (when applicable), and type-specific credentials. Mirrors `FortiGateConfigSchema` at line ~376 (standalone-device template) or `FortiManagerConfigSchema` at line ~318 (manager-fronted template).
- `src/api/routes/integrations.ts:CreateIntegrationSchema` (line ~438) — DISCRIMINATED UNION BRANCH: add `z.object({ type: z.literal("<type>"), name: ..., config: <Type>ConfigSchema, enabled, autoDiscover, pollInterval })`.
- `src/api/routes/integrations.ts:testConnection handler` (line ~920) — add `else if (integration.type === "<type>")` calling `<type>Service.testConnection(config as any)`.
- `src/api/routes/integrations.ts:discover handler` (line ~710) — add a branch calling `<type>Service.discoverDhcpSubnets(...)` (or `syncXxxDevices()` for asset-only types) and pass the resulting `DiscoveryResult` to `syncDhcpSubnets(input.type, result, ...)` at line 721.
- `src/api/routes/integrations.ts:syncDhcpSubnets` (line ~2246) — update the `integrationLabel` ternary at line ~2291 with the human-readable label (`"Palo Alto"`, etc.). Function body is generic across types; no other branch needed inside.
- `src/api/routes/integrations.ts:/query proxy route` (line ~1030) — add `if (integration.type === "<type>")` calling `<type>Service.proxyQuery(...)`. Define the per-type request body shape (Fortinet uses `{ method, path, query? }`; PAN-OS would use `{ method, path, query?, xpath? }`).
- `src/api/routes/integrations.ts:credential validation` (line ~595, ~779, ~874, ~1396, ~1450, ~1538) — extend the `(input.type === "fortimanager" || input.type === "fortigate")` predicates to include the new type when it uses the same credential model (SNMP/SSH credential overrides).
- `src/api/routes/integrations.ts:masked-secret restore` (line ~1662) — add the new type's secret field names (`apiToken`, `clientSecret`, etc.) to the list `isMaskedSecretSentinel` checks against on PUT.
- `src/api/routes/integrations.ts:discoveryScheduler dispatch` (line ~1538–1605) — add the new type's auto-discovery branch alongside the FMG/FortiGate/Windows/Entra/AD branches.
- `src/utils/pollingCompatibility.ts` — UNION `AssetSourceKind` (line ~34): add `| "<type>-firewall"` (or similar). MATRIX `COMPATIBILITY` (line ~50): add the set of allowed polling methods. SWITCH `assetSourceKindFromIntegrationType` (line ~64): map `case "<type>": return "<type>-firewall"`.
- `src/utils/assetProjection.ts` — UNION `AssetSourceKind` (line ~56): add the new source kind. RULES `HOSTNAME_RULES`, `SERIAL_RULES`, `MANUFACTURER_RULES`, `MODEL_RULES`, `OS_VERSION_RULES`, `IP_ADDRESS_RULES` (lines ~121–290): add an entry per field at the position matching the source's trustworthiness for that field. Manufacturer rules typically pick a fixed string (`"Palo Alto Networks"`) ignoring the observed blob.
- `src/services/monitoringService.ts:defaultPollingForSource` (line ~595) — add a per-stream defaults branch for the new source kind. REST-capable appliances mirror FortiGate (**`icmp` on response-time**, `rest_api` on telemetry/temperature/interfaces, `disabled` on LLDP/storage); identity sources mirror AD (`icmp` on response-time, `not_delivered` on the heavy streams).
- `src/services/monitoringService.ts:transport dispatch` (~lines 1208–1358, ~2367) — extend `isFortinetSrc`-style branching only when the new type uses a different credential model than FortiOS (e.g. a header-key auth scheme instead of bearer). If the new type's `config` has `apiToken` like FortiGate, no transport-dispatch change is needed.
- `public/js/integrations.js:_POLLING_COMPAT` (line ~31) — add the new type's allowed polling methods, mirroring its backend pollingCompatibility entry.
- `public/js/integrations.js:_SOURCE_TELEMETRY_MIB` (line ~96) — add the per-type telemetry MIB default (or null if the type doesn't expose SNMP telemetry).
- `public/js/integrations.js:<type>GeneralHTML(defaults)` — NEW form helper. Mirrors `fortiGateGeneralHTML` (line ~1758) or `fortiManagerGeneralHTML` (line ~1594). Append `verboseLoggingFormHTML(d)` at the bottom of the returned string so the Debug section stays uniform.
- `public/js/integrations.js:<type>FiltersHTML(defaults)` — NEW (when applicable). Mirrors `fortiGateFiltersHTML` (line ~1794) for device/interface/DHCP include/exclude wildcards.
- `public/js/integrations.js:<type>FormHTML(defaults)` — NEW. Combines General + Filters, mirrors `fortiGateFormHTML` (line ~1845).
- `public/js/integrations.js:get<Type>FormConfig()` — NEW reader. Returns the config object parsed from the modal's input fields. Must include `verboseLogging: readVerboseLoggingFromForm()` so the Debug section roundtrips.
- `public/js/integrations.js:form dispatch ternaries` (lines ~2110, 2118, 2144, 2157, 2531–2532) — extend each to include the new type. These switch on `type === "<value>"` for form HTML selection, config reader selection, label rendering, and per-type booleans.
- `public/js/integrations.js:openCreateModal tab visibility` (line ~2169) — if the new type supports DHCP Push / Quarantine Push, extend `isFmg || isFgt` to include it. If not, add a separate branch alongside `isAd || isEntra || isWin` (Monitoring tab only).
- `public/js/integrations.js:openCreateModal edit branch tab visibility` (line ~2499) — same extension on the edit path.
- `public/js/integrations.js:type-list picker grid` (line ~2100) — NEW button (`pick-<type>`) + its click listener calling `openCreateModal("<type>")`.
- `public/js/integrations.js:type-label ternaries` (line ~429, 2144) — `intg.type === "<type>" ? "<HumanLabel>" : ...` in both places (integrations list + modal title).
- `public/js/integrations.js:Monitoring tab visibility` (line ~1312) — if the new type owns devices that can be monitored as a class (FortiSwitch / FortiAP style), extend `isFmgFgt`. Most new types skip this — only the FMG-FortiGate-managed-device pattern needs the class-level auto-monitor cards.

**Readers** (files that consume the new type without needing a new code branch):
- `src/api/routes/integrations.ts:syncDhcpSubnets` body — consumes `DiscoveryResult` generically; new types ride it for free if their service returns the exact shape.
- `src/services/searchService.ts` — surfaces firewall assets through the asset table; no new-type branch needed.
- Monitor settings hierarchy resolver (`resolveMonitorSettings` in `monitoringService.ts`) — generic across types; consumes `Integration.config.monitorSettings` blob.
- `src/utils/integrationFilter.ts:assetMatchesIntegrationFilter` — handles `deviceInclude` / `deviceExclude` for any type that stamps them in config (FMG/FortiGate convention); add a per-type branch only if the filter semantics differ (e.g. AD uses `ouInclude` / `ouExclude` instead).
- `public/js/assets.js:integration filter dropdown` — populated from `GET /integrations`; new types appear automatically.

**Invariants:**
- Every new device-and-network integration type produces the **exact** `DiscoveryResult` shape — empty arrays for concepts the type doesn't have, never undefined / null. Per-query success flags (`switchInventoriedDevices`, `vipInventoriedDevices`, etc.) MUST be populated so `syncDhcpSubnets` Phase 5b sweeps skip stale-row deprecation for concepts the new type doesn't own.
- The four uniform top-level config keys (`host`, `port`, `verifySsl`, `verboseLogging`) appear on EVERY integration type's config schema. Push toggles (`pushReservations`, `pushQuarantine`, `useProxy`) only appear on types that support them; their absence is the signal to hide the corresponding modal tab.
- `Integration.type` Postgres column value matches the Zod `z.literal` value matches the frontend ternary key. Don't introduce a separate display-name → key mapping; the literal IS the type-string.
- Frontend modal tab order is fixed across types: General → Filters (when applicable) → Monitoring → DHCP Push (when applicable) → Quarantine Push (when applicable). Don't reorder; don't add a new tab unless the underlying concept is uniform across all types that show it.
- Verbose Debug section is the LAST element in every General tab. Same checkbox id (`f-verboseLogging`) across types so `readVerboseLoggingFromForm()` works without per-type branching.
- AssetSource projection priorities for a new firewall type slot in **at the same trust level** as the existing firewall types — don't elevate a new vendor above existing ones without reason. Manufacturer rules ignore the observed blob and pick a constant string so misreported fields can't pollute the projection.

**When adding a new integration type:**
- Pick the canonical (standalone-device vs manager-fronted vs asset-only) per [TEMPLATES.md → Integration type](TEMPLATES.md#integration-type-config--discovery--sync--frontend-modal).
- Walk this Writers list top-to-bottom, adding one branch per callsite. Don't shortcut — every callsite is load-bearing for one piece of the operator experience.
- Run the parallel test plan: (1) Create integration via the new picker button, save, reload — config roundtrips. (2) Test Connection succeeds + writes the expected `lastTestAt` / `lastTestOk`. (3) Discover writes the expected `DiscoveryResult` shape — verify via DB. (4) Discovered assets project correctly — hostname / serial / manufacturer / model resolve from the new source kind. (5) Resolved polling method matches the source default — verify via `GET /assets/:id/effective-monitor-settings`. (6) Asset shows up under the integration filter on `/assets.html`.
- If you discover a callsite that wasn't in this Writers list, ADD IT to TOUCHES.md in the same commit. The index only stays trustworthy if every contributor extends it as they touch new code.

---

## cross-cutting/fmg-fortigate-parity-surfaces

**What it is:** FMG and standalone FortiGate integrations share feature surfaces that must move together: integration modal tabs (General / Filters / Monitoring / DHCP Push / Quarantine Push), transport dispatch via buildTransportForIntegration(), and filter helpers. This entry is narrower than [cross-cutting/integration-type-onboarding](#cross-cuttingintegration-type-onboarding) — that one covers adding any new type; this one covers the FMG↔FortiGate paired-feature parity that must move together once both types exist.

**Writers** (files that mutate or emit this state):
- `src/api/routes/integrations.ts` — POST / PUT integration handlers parse both fortimanager and fortigate integration types, store config.pushReservations / pushQuarantine / monitorSettings / deviceInclude/Exclude in the same JSON shape
- `src/services/reservationPushService.ts` — buildTransportForIntegration() dispatches to FMG proxy/direct or FortiGate direct transport based on integration.type
- `src/services/assetQuarantineService.ts` — quarantineAsset() / releaseQuarantine() use buildTransportForIntegration() for both FMG and FortiGate
- `src/services/fortigateLocationService.ts` — fetchFortigateSysLocation() uses buildTransportForIntegration() + callFortiOs() for both FMG and FortiGate
- `src/services/fortigateCoordPushService.ts` — FMG-mode pushes to metavars + CMDB natively (no proxy); standalone pushes CMDB via direct REST. Same source-of-truth dispatch pattern as the other push services.
- `public/js/integrations.js` — Integration modal tab bodies for General (useProxy, Filters), Monitoring, DHCP Push, Quarantine Push. FortiGates Monitoring subtab now also carries the `pullSnmpLocation` / `pushGeocodedCoords` toggles.

**Readers** (files that consume it):
- `src/api/routes/integrations.ts` — Discovery sync paths read pushReservations toggle to decide whether to push DHCP changes
- `src/api/routes/integrations.ts` — Discovery sync paths read pushQuarantine to decide whether to push quarantine entries
- `src/services/reservationService.ts` — Reserve/release flows call buildTransportForIntegration() to dispatch push/unpush calls
- `src/services/assetQuarantineService.ts` — Quarantine push consults buildTransportForIntegration() and pushQuarantine toggle
- `public/js/assets.js` — Asset details modal wires up quarantine/release buttons that call the quarantine endpoints
- `src/utils/integrationFilter.ts` — assetMatchesIntegrationFilter() checks deviceInclude/Exclude for FMG/FortiGate and ouInclude/Exclude for AD (not shared)

**Invariants:**
- FMG and FortiGate must have identical modal tab layouts and toggle names (pushReservations, pushQuarantine, monitorSettings JSON, deviceInclude/Exclude).
- buildTransportForIntegration() is the single source of truth for routing push/quarantine calls; all callers must use it, never inline a new transport builder.
- Standalone FortiGate always routes through direct REST transport (no proxy option); FMG respects the useProxy toggle on the General tab.
- DHCP Push and Quarantine Push are independent toggles; enabling one doesn't force the other (operators mix-and-match per deployment model).
- FMG-only features intentionally excluded from standalone FortiGate: multi-device device filter (ADOM scoping), FMG-proxy concurrency settings.
- Filter matching (deviceInclude/Exclude wildcards) is the same for both FMG and FortiGate; tested in integrationFilter.ts.

**When changing this:**
- Any modal tab change on FMG must be duplicated on standalone FortiGate (and vice versa); test both integration types.
- If adding a new transport capability, update buildTransportForIntegration() signature and all callers (reservationPushService, assetQuarantineService, future features).
- Check that toggle propagation works: set pushReservations=true on FMG and verify next discovery sync writes reservations; disable it and verify unpush/lease-release are skipped.
- Verify filter behavior: add a deviceInclude pattern to FMG and confirm the next sync only touches matching devices.
- Test cross-device push: one asset discovered by FMG with multiple device filters; confirm each push lands on the intended device via the transport.

---

## cross-cutting/asset-write-time-clamps-and-shadow-writes

**What it is:** Prisma extension in src/db.ts that automatically normalizes manufacturer, clamps acquiredAt, checks monitoring status, derives asset sources, and records IP history on every Asset create/update/upsert (see "Asset write-time clamps" in CLAUDE.md).

**Writers** (files that mutate or emit this state):
- `src/db.ts` — Extended client wraps asset.create/update/updateMany/upsert/delete with six hooks:
  - normalizeManufacturerInData() runs `Asset.manufacturer` through normalizeManufacturer()
  - clampMonitoredForStatus() forces monitored=false + resets consecutiveFailures when status ∈ {decommissioned, disabled}
  - recordIpHistory() upserts AssetIpHistory on ipAddress change
  - shadowWriteAssetSources() derives and upserts AssetSource rows when identity fields change
  - fireDnsResolvedReconcile() schedules a fire-and-forget per-asset reconcile of `dns_resolved` reservations (gated on writes that touch ipAddress / status / hostname / dnsName / macAddress)
  - fireDnsResolvedRelease() (delete branch only) releases any owned `dns_resolved` rows before the row is removed
- `src/utils/manufacturerNormalize.ts` — normalizeManufacturer() pure function (cached alias map, no DB access)
- `src/utils/assetInvariants.ts` — clampAcquiredToLastSeen() logic (not hooked yet; job applies it at startup)
- `src/utils/assetSourceDerivation.ts` — deriveAssetSources() pure function producing AssetSource rows from legacy tags
- `src/jobs/normalizeManufacturers.ts` — One-shot startup: seeds default aliases, loads cache, backfills existing Assets
- `src/jobs/clampAssetAcquiredAt.ts` — One-shot startup: clamps acquiredAt ≤ lastSeen for pre-existing rows

**Readers** (files that consume it):
- Any code path that writes to Asset (discovery, UI routes, jobs) gets the extension hooks applied automatically.
- `src/services/manufacturerAliasService.ts` — Manages the alias cache that normalizeManufacturer consults.
- `src/app.ts` — Warms the OUI / manufacturer alias cache at boot before any Asset writes occur.

**Invariants:**
- Every Asset create/update that touches manufacturer will have the value normalized by the alias map at write time (no raw "Fortinet, Inc." rows survive).
- clampAcquiredToLastSeen is gated by a marker key (job doesn't re-run); startup check will warn if marker is missing.
- IP history is fire-and-forget best-effort; a transient DB error doesn't block the underlying Asset write.
- shadowWriteAssetSources uses the same derivation rules as the backfill job; updates only refresh metadata (syncedAt, lastSeen, integrationId), never overwrite observed JSON that came from discovery.
- updateMany doesn't trigger shadowWriteAssetSources (rare on identity fields; backfill catches drift on next startup).
- Extension runs AFTER the query executes; result reflects the DB commit state, not pre-normalization input.

**When changing this:**
- New clamps must be added to BOTH normalizeManufacturerInData() (for manufacturer) AND clampMonitoredForStatus() branches, preserving order (normalize first, clamp second, then shadow-write).
- If bypass paths exist (raw SQL, stored procedures, external scripts), they MUST be audited and manually corrected via startup jobs (extension can't intercept).
- Test the order: create an asset with status=decommissioned, monitored=true, consecutiveFailures=5; verify monitored flips to false and counter resets.
- Verify alias cache is warmed: set a new alias, restart the app, create an asset with the old name; spot-check it got normalized.
- Check IP history on duplicate IP: same asset, new source; verify firstSeen was reset (CASE expression in SQL working) and lastSeen bumped.

---

## cross-cutting/asset-last-seen-presence

**What it is:** `Asset.lastSeen` means **verified network presence** — the last time Polaris had direct evidence the device was alive on the network — with `Asset.lastSeenSource` carrying the evidence label. Every write routes through `src/utils/assetInvariants.ts → bumpLastSeen()` (no-regress: only advances; stamps provenance). Directory timestamps (Entra `lastSyncDateTime`, AD `lastLogonTimestamp`) are deliberately NOT presence — they live on `AssetSource.lastSeen` and render separately as "Last Directory Activity".

**Writers** (files that mutate this state):
- `src/api/routes/integrations.ts → syncDhcpSubnets` — FMG/standalone-FortiGate sync stamps:
  - Phase 5 DHCP: gated on `entry.seenLeased` (live lease), source `"dhcp-lease"`. Offline static reservations neither bump nor flip status.
  - Phase 7 device inventory: evidence is the FortiGate's per-client `last_seen` (or `now` when `is_online`), source `"device-inventory"`. Resurrection (`decommissioned → active`) requires `is_online`.
  - Firewall / FortiSwitch / FortiAP phases: source `"discovery"`; switch gated on `sw.connected`, AP on `apOnline` (status "connected" or blank), firewall implicit (FMG parse already skips `conn_status !== 1` devices).
- `src/api/routes/integrations.ts → syncEntraDevices / syncActiveDirectoryDevices` — do NOT write lastSeen (cut over in the directory-decoupling change). Directory activity goes to `AssetSource.lastSeen` via the source upserts.
- `src/services/presenceVerificationService.ts → runPresenceVerification` — AD/Entra post-sync pass (default on, `config.verifyPresence`): sources `"agent"` (ManagedAgent heartbeat), `"probe"` (answering monitor probe), `"ping"` (ICMP fallback). Ping failure writes nothing.
- `src/api/routes/conflicts.ts` — accept path (`"conflict-accept"`, via bumpLastSeen), reject-creates-asset path (`"conflict-reject"`), ghost absorption carries the ghost's source along.
- `src/services/assetMergeService.ts` + `src/jobs/mergeDuplicateHostnameAssets.ts` — max(lastSeen) winner carries its `lastSeenSource` onto the survivor.

**Readers** (files that consume it):
- `src/jobs/decommissionStaleAssets.ts` — `lastSeen < cutoff` eligibility, with a **veto** when any `entra`/`intune`/`ad`/`polaris-agent` AssetSource row has `lastSeen >= cutoff` (cloud-only laptops / agent-reporting hosts stay alive). Null lastSeen is never eligible.
- `src/api/routes/integrations.ts → buildEntraSyncIndex.directoryActivityByAssetId` — the Entra duplicate-registration tiebreaker compares **directory activity** (AssetSource.lastSeen), not Asset.lastSeen.
- `public/js/assets.js` — slide-over "Last Seen" row renders `lastSeen + " · via " + LAST_SEEN_SOURCE_LABELS[lastSeenSource]`; "Last Directory Activity" row computed from the sources fetch; assets table + CSV/PDF exports show the date only.
- `src/services/presenceVerificationService.ts → classifyPresenceSignal` — "already fresh" short-circuit reads it.

**Invariants:**
- Never write `Asset.lastSeen` / `lastSeenSource` directly — route through `bumpLastSeen(data, existing, evidenceAt, source)`. Creates may set both literally (nothing to regress).
- lastSeen never moves backward. A stale evidence source (FortiOS remembering a device from weeks ago) must not regress a fresher sighting.
- Absence of evidence is not evidence of absence: failed pings, offline inventory rows, and disconnected switch/AP entries leave lastSeen (and status) untouched.
- Presence evidence gates resurrection: only an online sighting may flip `decommissioned → active`.
- `clampAcquiredToLastSeen` still applies after any bump (acquiredAt ≤ lastSeen).

**When changing this:**
- Adding a new evidence source: use `bumpLastSeen`, pick a label, add it to `LastSeenSource` in `assetInvariants.ts` AND `LAST_SEEN_SOURCE_LABELS` in `public/js/assets.js`.
- Adding a new discovery pathway: classify its evidence — is it "device on the wire right now" (bump) or "registry/config knows about the device" (don't)?
- If you change the decommission job's eligibility, re-check the veto subquery covers every activity-bearing sourceKind.
- Scale-check any new reader/writer at 2000 assets — the presence pass batches via `$transaction` and bounds ping fan-out; keep it that way.

---

## cross-cutting/reservation-push-lifecycle

**What it is:** Two-way DHCP reservation ↔ FortiGate sync via pushReservations toggle on FMG/FortiGate integrations, sourceType flip (manual → dhcp_reservation on success), pushedScopeId/pushedEntryId tracking, and lease-release on free. **Transient device-side failures (FortiGate offline / FMG unreachable) at create time put the Polaris row in `pushStatus="pending"` and a 60s retry job + `monitor.status_changed → up` hook drive it to `synced` once the gate recovers.** Permanent failures (4xx, verify mismatch, auth) still abort-and-rollback the create.

**Writers** (files that mutate or emit this state):
- `src/services/reservationPushService.ts:classifyPushError` — Single source of truth for permanent (400/404/409, 502 with "verify mismatch" / "not visible on read-back" / "Authentication failed") vs transient (everything else — defaults to retry-eligible). Used by both create-time and retry-tick paths.
- `src/services/reservationPushService.ts:pushReservation`/`updatePushedReservation`/`unpushReservation` — buildTransportForIntegration() + create / update / delete + read-back verify on FortiOS.
- `src/services/reservationService.ts:createReservation` push branch — Pre-flight: when the firewall Asset is monitored AND `monitorStatus="down"`, skip the transport attempt entirely and queue with `pushStatus="pending"`/`pushQueuedAt=now`/`pushAttempts=0`. On transport attempt: success → stamp `sourceType="dhcp_reservation"`/`pushStatus="synced"`/push pointers + clear queue cols. Transient failure → keep row, stamp `pushStatus="pending"`/`pushQueuedAt`/`pushAttempts=1`/`pushLastAttemptAt`. Permanent failure → existing rollback.
- `src/services/reservationService.ts:updateReservation` — When `pushStatus="pending"`, skip `updatePushedReservation` entirely; just rewrite the queued payload (MAC, hostname, notes, ...). Retry tick picks up the new values on its next attempt.
- `src/services/reservationService.ts:releaseReservation` — When `pushStatus="pending"`, skip `unpushReservation` AND `releaseDhcpLease`; clear queue cols + flip to `released`; emit `reservation.push.queued.released` instead of the `reservation.unpush.failed` warning the old path would have logged.
- `src/services/reservationService.ts:retryPendingReservations` — 60s retry-tick entry. Eligibility re-check (subnet drift, integration deleted/disabled, pushReservations flipped off, no fortigateDevice) → `pushStatus=null` + emit `reservation.push.queued.cancelled`. Discovery-supersede check (another active row at same IP) → `pushStatus="failed_permanent"` + emit `reservation.push.queued.collided`. Readiness gates (monitored gate must be `monitorStatus="up"`; unmonitored uses exponential backoff `min(60 * 2^(attempts-1), 1800)`s) → skip without attempt increment. Otherwise increment attempts, push, classify, stamp synced / failed_permanent / leave pending. Emits `reservation.push.queued.{succeeded,retry_failed,failed_permanent}` per outcome.
- `src/services/reservationService.ts:retryReservationNow` — Operator-triggered single-row retry from the IP panel "Retry" button + Events page push-queue panel. Bypasses readiness gates; bumps `failed_permanent` rows back to `pending` first. Emits `reservation.push.queued.retry_manual`.
- `src/services/reservationService.ts:triggerRetryAfterStatusChange` — Called from `monitoringService.recordProbeResult` when a firewall asset transitions to `up`. Count-gated (zero-pending = early return) so most up-transitions cost one indexed COUNT(*).
- `src/jobs/retryQueuedReservationPushes.ts` — 60s tick wrapping `retryPendingReservations` via `runInstrumentedJob`. Independent `running` guard. First tick delayed 60s after boot.
- `src/services/monitoringService.ts` — After `propagateAfterStatusChange`, fires `triggerRetryAfterStatusChange` only when `nextStatus === "up"`.
- `src/services/subnetRefreshService.ts` — Per-subnet Refresh action: fast-path adopt pending rows whose MAC matches a discovered dhcp_reservation (uses CMDB entry id from `listReservedAddresses` in-scope); hard-collide pending rows whose MAC mismatches (flip to `failed_permanent`).
- `src/api/routes/integrations.ts:syncDhcpSubnets` — Same fast-path adopt + hard-collide logic for full-discovery flows. Reads `entry.scopeId` / `entry.entryId` from the DiscoveredDhcpEntry shape (populated by fortimanagerService + fortigateService at extraction time from `server.id` / `entry.id`).
- `src/api/routes/integrations.ts:syncDhcpSubnets` Phase 5b — Releases active `dhcp_reservation` rows (including ex-Polaris-pushed-manual rows that flipped to `dhcp_reservation` on first sight) whose CMDB query succeeded this cycle but whose `(subnetId, ip)` isn't in `result.dhcpEntries`. Clears `pushedToId`/`pushedScopeId`/`pushedEntryId`/`pushStatus`. Gated to `subnet.discoveredBy === integrationId` so other integrations' rows are never touched. Auto-rejects pending conflicts on the released row. Writes `reservation.dhcp_reservation.released` Event.
- `src/api/routes/reservations.ts:POST /:id/retry-push` — Operator-facing route, ownership-gated (own rows for `write`, all for `fullwrite`). Wraps `retryReservationNow`. Allowed on `pushStatus IN ("pending", "failed_permanent")`.
- `src/api/routes/reservations.ts:GET /push-queue` + `GET /push-queue/count` — Read-everyone; powers the Events-page Alerts panel "Push queue" filter view and the combined sidebar badge.

**Readers** (files that consume it):
- `src/services/reservationService.ts:listReservations` — Decorator no-op'd to pass through `pushStatus`/`pushQueuedAt`/`pushAttempts`/`pushError` to every reservation row.
- `src/services/reservationService.ts:listPushQueue`/`countPushQueue` — Filters `pushStatus IN ("pending","failed_permanent") AND status="active"`; joins subnet + pushedTo for the queue view.
- `src/api/routes/reservations.ts` — Success-toast suffix uses `pushStatus`: synced → "and pushed to FortiGate"; pending → "queued for push (FortiGate unreachable; will retry automatically)"; null → "".
- `public/js/ip-panel.js` — Reservation row status pill: pending → amber "Queued for push" + tooltip (queued-ago, attempts, last error); failed_permanent → red "Push failed" + tooltip with error. Retry button rendered for both pushStatus values when caller has write-ownership.
- `public/js/events.js` — Alerts panel filter "Push queue" calls `listPushQueue` + renders cards with Retry / Free buttons. Combined Alerts-button badge count = stale alerts + push queue; after operator actions, `refreshBadge` calls BOTH `window.refreshAlertsDot()` (IPAM dot — stale-only) and `window.refreshConflictDot()` (Events dot — conflicts + push queue) so neither dot drifts out of sync with the panel.
- `public/js/app.js:refreshConflictDot` — Sidebar Events dot. Displays when `(conflicts.count + reservations.pushQueueCount) > 0`. The queue UI lives on the Events page, so its indicator does too.
- `public/js/app.js:refreshAlertsDot` — Sidebar IPAM dot. Displays when `reservations.alertsCount > 0` (stale-reservation alerts only — push queue moved to the Events dot).
- `src/api/routes/integrations.ts` — Discovery sync reads pushReservations toggle to gate DHCP reservation creation
- `src/api/routes/integrations.ts:syncDhcpSubnets` upsert loop — Checks `existingRes.pushStatus === "pending"` BEFORE the legacy `existingRes.pushedToId` branch so a queued row isn't silently flipped to dhcp_reservation as if it were our own echo.
- `src/services/fortimanagerService.ts:DiscoveredDhcpEntry` + `localDhcpEntries.push` in CMDB read — Populates `scopeId` (from `server.id`) and `entryId` (from `entry.id`) so the integration sync's fast-path adopt has device-side pointers in hand without a second REST call.
- `src/services/fortigateService.ts` — Same `scopeId`/`entryId` population at the standalone-FortiGate dhcp reservation read site.

**Invariants:**
- DHCP reservations are MAC→IP pairs; only per-IP (not full-subnet) manual reservations are push-eligible.
- pushedScopeId + pushedEntryId are resolved AT PUSH TIME and pinned; used at unpush without re-querying the FortiGate.
- sourceType flip to "dhcp_reservation" is ONLY set on successful push. While `pushStatus="pending"` the row stays `sourceType="manual"` because nothing's on the device yet.
- Lease release happens ONLY for dhcp_lease sourceType rows where the originating integration's pushReservations=true AND the row is not pending (queued rows have no device-side state to release).
- pushStatus ∈ {"synced", "drift", "pending", "failed_permanent"}; "synced" = verified on device, "pending" = queued for retry, "failed_permanent" = terminal error (operator must release or retry-now after fixing the root cause), "drift" is reserved by the schema but is no longer the path for "missing on re-discovery" — Phase 5b now RELEASES rather than drift-flags such rows.
- Queue cols (`pushQueuedAt`, `pushAttempts`, `pushLastAttemptAt`, `pushError`) are reset to defaults on every successful push (synced) and on every release.
- Retry tick is idempotent: re-runs cancel rows where eligibility dropped, skip rows where readiness gates aren't met, and only push rows where every gate clears.
- No TTL on queued rows — they live forever until success, release, or operator-triggered retry-now (operator decision per the plan).
- Operator-triggered `retryReservationNow` bypasses readiness gates but still respects eligibility re-check (subnet drift → cancel) and discovery-supersede (collision → failed_permanent).
- The `monitor.status_changed → up` hook fires `triggerRetryAfterStatusChange` only on the up edge; down / warning / recovering transitions don't kick the retry job.

**When changing this:**
- Verify pushedScopeId/pushedEntryId survive across restarts: create a reservation, restart the app, release it; confirm unpush hits the exact device-side entry.
- Test sourceType flip: create a manual reservation, push succeeds; verify sourceType is now "dhcp_reservation" and pushedToId is set to the integration.
- Verify the queued-flow round-trip: take the FortiGate offline, create a reservation on a push-eligible subnet, confirm the row persists with `pushStatus="pending"` + `reservation.push.queued` Event. Bring the gate back, verify within one cadence tick the row flips to `pushStatus="synced"` + `reservation.push.queued.succeeded` Event.
- Verify the monitored-down pre-flight: same as above but on a monitored gate that's already `monitorStatus="down"`; confirm the create returns near-instantly (no 15s+ transport timeout) and the row is queued.
- Verify drift cancellation: queue a row, then flip `pushReservations=false` on the integration. On next retry tick, confirm the row goes to `pushStatus=null` + `reservation.push.queued.cancelled` + Polaris row stays as a plain `manual` reservation.
- Verify discovery collision: queue a row, then have discovery ingest a different MAC at the same IP. Confirm the queued row goes to `pushStatus="failed_permanent"` + `reservation.push.queued.collided` and the discovery row is BLOCKED by the unique-on-active constraint (operator must release the failed_permanent row to free the IP).
- Verify fast-path adopt: queue a row, then have the operator add the matching MAC at the same IP on the device directly. On next discovery, confirm the pending row flips to `synced` with `pushedScopeId`/`pushedEntryId` stamped from the discovered entry + `reservation.push.queued.adopted` Event.
- Test edit/release while queued: update MAC on a queued row → no device contact, new MAC stashed. Release queued row → no `unpush.failed` warning, clean `reservation.push.queued.released` audit Event.
- Check conflict bypass: create a manual reservation, add an integration that discovers the same IP; verify conflict is raised only for non-manual priors.
- Lease-release cadence: toggle pushReservations off mid-deployment, release a dhcp_lease row; confirm unpush is skipped but the Polaris row is freed.
- Verify read-back verify: FortiGate DHCP create succeeds but the verify read fails (transient device timeout); confirm `classifyPushError` returns "permanent" for the verify-mismatch wording and the row rolls back (NOT queued).
- Test gate-deleted-on-device release: push a manual reservation (sourceType flips to dhcp_reservation on first discovery), then delete the reserved-address entry on the FortiGate, then re-run discovery. Confirm Phase 5b releases the Polaris row, clears the push pointers, and emits `reservation.dhcp_reservation.released`.

---

## cross-cutting/fortigate-snmp-location-and-coord-writeback

**What it is:** Discovery-time location → coords resolution for FMG/standalone-FortiGate-discovered firewalls. The geocode source string is resolved per device: a FMG **address metavar** (named by `fortigateMonitor.addressMetavar`, opt-in) wins when set+populated, else SNMP `sysLocation` (pulled via REST `GET /api/v2/cmdb/system.snmp/sysinfo` when `pullSnmpLocation` is on) is the fallback; the chosen string is geocoded via Nominatim → `Asset.latitude` / `Asset.longitude`. SNMP sysLocation (when pulled) is also stored raw on `Asset.snmpLocation`; the address-metavar string is projected to `Asset.learnedAddress` ("Address" on the General tab). Optional opt-in write-back closes the loop: when the geocoded coords don't match the FortiGate's current CMDB GUI fields, Polaris pushes them to FMG coordinate metavars (named by `latitudeMetavar`/`longitudeMetavar`, default `Latitude`/`Longitude`) AND CMDB (`gui-device-*`) for FMG mode, or just CMDB for standalone. Per-integration `fortigateMonitor` controls: `pullSnmpLocation` (SNMP enable), `addressMetavar` (address geocode source), `pushGeocodedCoords` (write-back, enabled when pull is on OR an address metavar is named), `latitudeMetavar`/`longitudeMetavar` (coord metavar names). All metavar fields are FMG-only.

**Writers** (files that mutate or emit this state):
- `src/services/fortigateLocationService.ts` — fetchFortigateSysLocation() returns trimmed sysLocation string or null. REST-only, reuses callFortiOs + buildTransportForIntegration so it works in both FMG proxy and direct mode (and doesn't need network reachability to the FortiGate's mgmt IP when in proxy mode).
- `src/services/geocoderService.ts` — geocode() with positive+negative `GeocodeCache` (90-day TTL) + 1 req/sec rate limiter (module-level chained Promise). Transport failures do NOT poison the cache; only successful responses write rows. Never throws.
- `src/services/fortigateCoordPushService.ts` — pushCoordsToFortigate(integration, deviceName, lat, lng, latMetavar?, lngMetavar?) dispatches BOTH metavars + CMDB writes (FMG mode) or CMDB only (standalone). Metavar names default to `Latitude`/`Longitude`; the caller passes the integration's configured names. Best-effort: per-target failures collected in the returned `{ok, targets[], error?}` shape, never thrown.
- `src/services/fortimanagerService.ts:setFmgDeviceMetaFields` + `setFmgDeviceCmdbGuiCoords` — native FMG `update` helpers used by the push service. Both go through the worker's native lane (no proxy throttle).
- `src/services/fortimanagerService.ts:extractMetavarCoordsFromFmgDevice(raw, latName?, lngName?, addrName?)` — parses coordinate + address metavars from FMG `/dvmdb/adom/<adom>/device` records (case-insensitive against the configured names) when the list query carries `option: ["get meta"]`. Names default to `Latitude`/`Longitude` with the address metavar blank-disabled. Surfaces as `DiscoveredDevice.metavarLatitude` / `metavarLongitude` / `metavarAddress`. `discoverDhcpSubnets` resolves the names once from `config.fortigateMonitor` and threads them into both (direct + proxy) call sites.
- `src/api/routes/integrations.ts:syncDhcpSubnets` Phase 3 — Once per device (NOT per HA member): resolves the geocode source string (address metavar wins; SNMP sysLocation fallback when pulled), geocodes it, stashes results into the per-device closure variables (`devSnmpLocation` / `devSnmpLocationFetchedAt` / `devGeocodedLat` / `devGeocodedLng`; verbose log `discovery.location.geocoded` carries a `geoSource` of `address-metavar`|`snmp`). Each per-member `memberDevice` build carries these + `metavarAddress` forward into the observed blob via buildFortigateFirewallObservedBlob. `updateData.snmpLocation` / `snmpLocationFetchedAt` are stamped when pulled; `updateData.learnedAddress` is stamped only when an address metavar is configured this cycle (update + create). Write-back call fires AFTER the per-member loop — only when geocoding succeeded AND `coordsClose(geocoded, cmdb, 1e-5)` returns false; passes the configured `latitudeMetavar`/`longitudeMetavar`. Emits `integration.coords.pushed` or `integration.coords.push_failed` Events.
- `src/utils/assetProjection.ts:LATITUDE_RULES` / `LONGITUDE_RULES` / `SNMP_LOCATION_RULES` / `LEARNED_ADDRESS_RULES` — three-tier coord priority on the `fortigate-firewall` source: snmpGeocoded (geocoded-location result) → coordinate metavar → CMDB. Each picker validates the full (lat,lng) pair via `isValidGeoCoord` so a half-valid tier falls through. `snmpLocation` (raw SNMP string) and `learnedAddress` (`metavarAddress`) are separate projected string fields.
- `prisma/schema.prisma` — Asset.snmpLocation / Asset.snmpLocationFetchedAt / Asset.learnedAddress columns; GeocodeCache model.

**Readers** (files that consume it):
- `public/js/assets.js` — Renders "Address" viewRow (from `a.learnedAddress`) and "SNMP Location" viewRow (from `a.snmpLocation`) on the asset details General tab when each is set.
- `public/js/integrations.js` — `geographicLocationFormHTML` renders the SNMP-pull / push-back toggles plus the three metavar-name fields (FMG-only); `_readFortigateMonitorBlock` reads them back; `window._geoRecomputePush` reactively enables the push checkbox when SNMP pull is on OR an address metavar is named.
- `public/js/integrations.js` — FortiGate Monitoring subtab renders the two toggles via `_fortigateAddMonitoredHTML`; `_readFortigateMonitorBlock` reads them on Save. `pushGeocodedCoords` is force-cleared client-side when `pullSnmpLocation` is off (matches the inline onchange UI handler that disables the push checkbox when pull flips off).
- `src/api/routes/integrations.ts:FortiGateClassMonitorSchema` — Zod schema for the persisted shape (`pullSnmpLocation: boolean`, `pushGeocodedCoords: boolean`).
- `src/api/routes/assets.ts` — Asset findUnique / findMany returns snmpLocation + snmpLocationFetchedAt naturally (no field whitelist filters them out).
- `src/api/routes/map.ts` — Device Map endpoints read `Asset.latitude` / `Asset.longitude` (which projection resolves through the SNMP-first chain when pull is on) for pin placement. No special handling — just consumes the resolved values.

**Invariants:**
- SNMP location pull is ALWAYS via REST (`/api/v2/cmdb/system.snmp/sysinfo`), never via net-snmp. This sidesteps the SNMP credential resolver and works in FMG proxy mode where Polaris can't reach the FortiGate's mgmt IP directly.
- The pull fires ONCE per FortiGate per discovery cycle — HA cluster members share sysLocation by physical co-location, so the result is reused across all members' observed blobs.
- When geocoding fails (empty sysLocation, no Nominatim hit, transport error), the asset's lat/lng falls through to the metavar tier and then to CMDB. `Asset.snmpLocation` is still populated with the raw string whenever the REST pull returned one — operators see "what the FortiGate is telling SNMP" independent of geocode outcome.
- `Asset.learnedLocation` for firewalls is always the firewall's own hostname — discovery deterministically overwrites it (rather than `existing || hostname`) on every cycle so any rows polluted by the earlier SNMP-into-learnedLocation experiment heal on the next pass. The SNMP sysLocation string is captured on `Asset.snmpLocation` and surfaced separately on the asset details General tab; it does NOT participate in the Location column. This is the only writer for firewall `learnedLocation` — the projection layer deliberately leaves it null on the `fortigate-firewall` source (hostname's already on Asset.hostname). `Asset.location` (the operator-overridable field) is NEVER touched by discovery so manual operator edits stick.
- `Asset.snmpLocationFetchedAt` is stamped whenever the REST pull was attempted, even when it returned empty string (lets the UI show "checked X minutes ago, no value reported").
- `coordsClose` tolerance is 1e-5° (~1.1 m at the equator). Tighter than Nominatim's typical 6-7 decimal output for street addresses — catches actual operator edits without firing on Nominatim re-geocode jitter.
- Write-back fires ONCE per FortiGate (not per HA member — coord write is cluster-wide).
- FMG-mode write-back lands in FMG's CMDB but does NOT trigger an FMG install. The live FortiGate sees the change only when an operator runs Install Device Configuration in FMG. UI text on the toggle surfaces this caveat.
- `pushGeocodedCoords` is force-cleared (client AND server side) when `pullSnmpLocation` is off — operators can't push what they aren't pulling.
- GeocodeCache stores BOTH positive and negative results (null lat/lng = "Nominatim returned no match"). Transport failures (timeout / non-2xx / parse error) are NOT cached — only the upstream's response writes a row, so a transient Nominatim outage doesn't poison subsequent retries.
- Geocoder rate limiter is process-global (module-level chained Promise), 1 req/sec. Cache hits bypass the gate entirely so steady-state cycles after the initial fleet pass are near-zero requests.
- Both toggles default OFF on a fresh install AND on existing integrations. No behavior change unless an operator opts in.

**When changing this:**
- Verify existing-install no-op: leave both toggles off on a fleet with valid CMDB coords. Discover. Confirm zero REST sysLocation calls, zero Nominatim requests, Asset coords unchanged.
- Test the SNMP-first override: set CMDB coords valid, set `sysLocation` to a different real address, enable `pullSnmpLocation` (push off). Discover. Verify Asset coords now come from geocoded sysLocation; CMDB unchanged on the FortiGate.
- Test write-back parity: enable both toggles on an FMG integration. Confirm BOTH metavars (`Latitude` / `Longitude`) AND CMDB (`gui-device-latitude` / `gui-device-longitude`) get updated. Repeat for standalone — confirm CMDB only (no metavars on standalone). Verify the FMG-side change requires operator Install to reach the live FortiGate (Polaris does not trigger installs).
- Test cache hit + negative cache: re-discover with same sysLocation → no Nominatim request. Set sysLocation to gibberish → row exists with null lat/lng → next discovery doesn't re-hit upstream.
- Test rate limiter: kick off a discovery against ≥5 FortiGates with distinct unseen sysLocations. Confirm Nominatim requests are spaced ≥1 second apart.
- Test HA cluster: SNMP pull fires ONCE per cluster; write-back also fires ONCE (not per member). Both members' AssetSource observed blobs carry the same `snmpLocation` / `snmpGeocodedLatitude` / `snmpGeocodedLongitude`.
- Test the tolerance: set CMDB coords ~1m off from geocoded → match, no write-back. Set CMDB ~10m off → mismatch, write-back fires.
- Test toggle gating: flip `pullSnmpLocation` off in the modal; verify `pushGeocodedCoords` checkbox auto-disables AND auto-clears. Re-enable pull; verify push stays unchecked until operator ticks it explicitly.
- Run `npm run typecheck` and `npm test` — the assetProjection test suite covers the projection shape and will fail loudly if new projected fields aren't added to the all-null baseline expectation.

---

## cross-cutting/dns-resolved-reservations

**What it is:** Auto-created Reservation rows with `sourceType="dns_resolved"` + `createdBy="system:dns-resolved"` for every Asset whose primary `ipAddress` falls inside a non-deprecated Subnet and isn't already covered by an authoritative reservation. Closes the gap where an AD / Entra / Intune / manually-typed asset's IP is invisible in the Networks IP panel and could be handed out twice. Observational only — never pushes to FortiGates, never raises Conflict rows, silently defers to manual / dhcp_* / interface_ip / vip / fortinet rows.

**Writers** (files that mutate or emit this state):
- `src/services/dnsResolvedReservationService.ts` — `reconcileDnsResolvedForAsset(assetId)` is the single per-asset upsert/release path. Exports `reconcileDnsResolvedForAllAssets()` (sweep), `releaseDnsResolvedForAsset(assetId)` (asset-delete), `releaseDnsResolvedAt(subnetId, ipAddress)` (discovery hand-off).
- `src/db.ts` — Prisma extension fires `fireDnsResolvedReconcile(result.id)` after every gated `asset.create` / `asset.update` / `asset.upsert`; fires `fireDnsResolvedRelease(args.where.id)` BEFORE `asset.delete` runs so the service can still read the row's hostname/MAC to identify owned reservation rows.
- `src/jobs/reconcileDnsResolvedReservations.ts` — 30-min tick + 30s post-boot kick. Sweeps every asset with `ipAddress != null` in batches of 25 via Promise.all.
- `src/api/routes/integrations.ts` (`syncDhcpSubnets`) — `activeResMap` construction EXCLUDES `sourceType="dns_resolved"` rows so discovery treats the IP as free; the five `prisma.reservation.create` callsites (fortiswitch / fortinap / vip / interface_ip / dhcp_*) each call `releaseDnsResolvedAt(subnetId, ip)` inline before creating. The Phase 5 dhcp_* callsite additionally wraps its create in a P2002-aware retry: a fire-and-forget reconcile queued from an earlier asset write can insert a fresh dns_resolved row between the inline release and the create, so on P2002 the code refetches the colliding active row and — if it's dns_resolved — `prisma.reservation.delete` the row and retries the create once. Other sourceTypes on the collider are treated as genuine concurrent-write collisions (concurrent integration, manual reservation typed during sync) and logged + skipped.
- `src/api/routes/integrations.ts` (`registerFortinetHost`) — findFirst excludes dns_resolved + same inline release before create.
- `src/services/reservationService.ts` (`createReservation`) — manual create's existing-active-reservation check excludes dns_resolved; calls `releaseDnsResolvedAt` inline before the `$transaction`.

**Readers** (files that consume it):
- `public/js/ip-panel.js` — recognizes `r.sourceType === "dns_resolved"` to render a distinct "DNS Resolved" status pill and tooltip. The Reserve/Release/Edit button gating is unchanged — `createdBy === "system:dns-resolved"` doesn't match any user, so non-admin operators see view-only.
- `src/api/routes/assets.ts:buildIpContexts` — `ipContext.reservation.sourceType` carries the value through to the assets list's View Lease deep-link target; no special handling needed (the deep link just opens the IP panel which renders the badge).

**Invariants:**
- Reservation `@@unique([subnetId, ipAddress, status])` constraint requires the inline release before any authoritative create at the same target. Never skip it.
- dns_resolved release is implemented as `deleteMany`, not `updateMany({status: "released"})`. The unique constraint applies to every status value, so a released-state row at `(sub, ip, "released")` would permanently occupy that slot and block later status transitions at the same target. dns_resolved is a system-created fallback with no audit value once it's gone — hard-delete is the correct semantic, never re-introduce the soft-release path. The matching `cleanupStaleDnsResolvedReleased` startup job clears any pre-cutover released-state rows that slipped into the table before this rule landed.
- `createdBy="system:dns-resolved"` is the stable system actor — the existing ownership middleware treats `system:*` as "no operator owns this", which is the intended UX (non-admins can't edit).
- Eligible asset statuses: active / maintenance / storage / quarantined. decommissioned / disabled MUST release the existing row (don't keep stale claims).
- IPv4 only (Netmask helpers are IPv4-only and the IP-panel UI is IPv4-shaped). IPv6 assets silently skip.
- Never push to FortiGate. The service writes via raw `prisma.reservation.create` and bypasses `reservationService.createReservation` so the push path is never reachable.
- Never raise Conflict rows. The defer-to-authoritative branch returns early without touching `prisma.conflict`.
- Real-time hook is best-effort fire-and-forget — the periodic job is the safety net.

**When changing this:**
- Adding a new authoritative `sourceType`? Add a `releaseDnsResolvedAt(subnetId, ip)` call inline before every place that creates rows with the new value, and verify the activeResMap construction still excludes dns_resolved only.
- Adding a new eligibility column (e.g. asset's site/zone)? Update `assetEligible()` AND the `findOwnedSystemRows` identity match (MAC + hostname) — if the identity key changes, stale rows orphan instead of releasing.
- Switching ownership to a real FK (Reservation.assetId)? Drop the identity-match heuristic and join directly; the periodic job becomes trivially correct.
- Performance check at 2000 assets: the periodic job's batched Promise.all should complete in a few seconds. If it grows, increase the batch size (25 → 50) before fanning out further — the bottleneck is the `findContainingSubnet` $queryRaw, not the Asset findMany.
- IPv6 follow-up: `findContainingSubnet` already uses Postgres `inet`/`cidr` containment which supports v6; the gate is `detectIpVersion(ip) === "v4"` in `assetEligible()`. Removing it would also need a v6-aware containment check in `ipInCidr` callers.

---

## cross-cutting/asset-tag-mutators

**What it is:** Anything in the codebase that writes `Asset.tags`. The `tags: String[]` column is used by humans (assets-page filtering, search) AND by features that "stamp" managed tags (e.g. `region:<name>` from map regions). Two writer classes coexist: **operator-driven** (asset edit modal, bulk-edit) and **system-driven** (auto-tagging features). The latter must be careful not to step on operator-set values.

**Operator writers:**
- `src/api/routes/assets.ts:PUT /assets/:id` — primary edit path; accepts `tags: string[]` and writes it as-is.
- `src/api/routes/assets.ts:POST /assets/:id/sources/:sourceId/split` — clones tag set when splitting an asset.
- `src/services/assetMergeService.ts` (`POST /assets/:id/merge`) — union-merges the absorbed asset's tags onto the survivor (operator merge).
- `public/js/assets.js` bulk-edit modal — calls `PUT /assets/:id` per row with "Add" / "Replace" semantics.

**System writers (managed namespaces):**
- `src/services/mapRegionService.ts` — owns the `region:` prefix. Adds `region:<name>` to in-polygon firewalls + cascaded FortiSwitches/FortiAPs; only strips on rename/delete (never on polygon edit). Sees its own tags via the prefix; never touches operator-set tags. Mirrored to the `Tag` registry under category "Map Regions".
- `src/services/firewallTagService.ts` — owns the `firewall:` prefix. Reconciles `firewall:<hostname>` on every FortiSwitch / FortiAP / non-infra endpoint at end of FMG / FortiGate discovery (Phase 13.5) using `Asset.fortinetTopology.controllerFortigate` + `AssetFortigateSighting` rows within `sightingMaxAgeDays`. Strips only tags whose hostname is one of THIS integration's currently-known firewalls (cross-integration safe). Inline lifecycle hooks at Phase 2a (decommission strip), Phase 3 firewall create (registry seed), Phase 3 firewall update (rename rotation). Mirrored to the `Tag` registry under category "FortiGate".
- Discovery breadcrumb tags — `src/api/routes/integrations.ts` legacy paths still write `entra-disabled`, `ad-disabled`, `prev-*` markers. Some of these (sid:, ad-guid:) are being retired by the multi-source asset model.

**Tag registry mirror (`prisma.tag` rows):**
- Manual tag pickers (assets edit modal) read from the registry to populate dropdowns. System-managed tags should also appear here so operators can search/filter for them — `mapRegionService` is the canonical example (upserts on create, rotates on rename, deletes on delete).

**Invariants:**
- A managed tag prefix must be **owned** by exactly one writer. Don't add a second feature that writes `region:*` — pick a different prefix.
- System writers must be additive in the steady state. Stripping a tag because "the asset doesn't fall in the polygon any more" is a footgun unless the operator explicitly requested that semantic (rename/delete, not polygon edit).
- Manual operator attachments to system-managed tags (e.g. an endpoint server hand-tagged `region:Atlanta`) must survive periodic reconcilers.

**When changing this:**
- New auto-tagging feature? Pick a prefix, document it here, mirror to the `Tag` registry, and follow the additive-reconciler pattern from `mapRegionService`.
- Removing a managed prefix? Audit existing rows for stale tags before retiring the writer.
- Changing the `Asset.tags` column type or moving tags to a side table? Every writer in this section needs to migrate — the `String[]` shape is load-bearing.

---

## cross-cutting/dependency-aware-monitoring-suppression

**What it is:** AssetDependencyParent edges + Asset.dependencyLayer + Asset.dependencySuppressed coupled to the response-time five-state machine. Parent (FortiGate / upstream switch) confirmed-down → all transitive descendants pause heavy cadences and slow probe to 2× interval; recovery resumes within one base-cadence tick. "All-down" multi-parent semantics — a switch with redundant uplinks suppresses only when every effective parent is down or itself suppressed.

**Writers** (files that mutate or emit this state):
- `src/services/dependencyTreeService.ts` — recomputeDependencyTree() rebuilds source="computed" rows in AssetDependencyParent + Asset.dependencyLayer at end of every FMG/FortiGate discovery cycle. Source="override" rows are operator-managed (admin override endpoints — to be added in API commit) and never touched by recompute.
- `src/services/dependencyTreeService.ts` — reconcileDependencySuppression() is the source of truth for Asset.dependencySuppressed; emits monitor.dependency_suppressed / monitor.dependency_resumed Events on transitions.
- `src/services/dependencyTreeService.ts` — propagateAfterStatusChange() is the latency-optimization hook called from recordProbeResult on the confirmed up/down edge (a separate guard from the monitor.status_changed Event emission, which also covers the warning edge — propagate does NOT fire on warning).
- `src/jobs/dependencyReconciler.ts` — 60s tick that calls reconcileDependencySuppression(); the source of truth catches anything the event hook missed.
- `src/jobs/backfillDependencyTree.ts` — one-shot startup runs recomputeDependencyTree() so existing installs see populated rows without waiting 4h.
- `src/api/routes/integrations.ts` — Phase 12 of syncDhcpSubnets calls recomputeDependencyTree(integrationId) on mode in {full, finalize}.

**Readers** (files that consume it):
- `src/services/monitoringService.ts:runMonitorPass()` — Cadence dispatch: heavy cadences gated on `monitorStatus==="up" && !dependencySuppressed`; probe interval doubles when dependencySuppressed AND responseTimePolling !== "disabled".
- `src/jobs/monitorAssets.ts:publishDueWork()` — Same gate, mirrored for the pg-boss publisher path.
- `public/js/assets.js:assetMonitorBadge()` — Status pill renders slate-blue "Dep. Down" when `dependencySuppressed && monitorStatus !== "down"` (probe-down wins over the suppressed flag — the probe is the proof).
- `public/js/map.js:monitorClass()` / `clusterIcon()` / `fortigateNodeColor()` — Pin/cluster/topology-node colors render slate-blue (`monitor-dep-down`) under the same priority rule. Cluster aggregation rolls up to dep-down only when no child has a worse probe-direct status.
- `public/js/mobile/asset-detail.js:renderMonitorPill()` / `monitorDotCls()` — Same priority + slate-blue treatment on the mobile asset-detail surface.
- `src/api/routes/assets.ts` — Three endpoints: `GET /assets/:id/dependencies`, `PUT /:id/dependencies/override` (admin, with cycle validation), `DELETE /:id/dependencies/override` (admin).
- `src/api/routes/assets.ts:GET /` and `GET /:id` — Stamps `dependencyLayer` + `dependencySuppressed` on every asset returned so the pill renderer doesn't need a second fetch.
- `src/api/routes/map.ts:GET /sites` and `GET /sites/:id/topology` — Stamps the same fields on each pin / topology node. (The topology endpoint still computes edges via per-request BFS through `interfaceTopologyService` — full DAG-as-source-of-truth refactor is a follow-up; current state is "DAG drives suppression, BFS still drives graph rendering.")

**Invariants:**
- Suppression follows the **confirmed-down** edge only. propagateAfterStatusChange() is called only from the up/down guard in recordProbeResult — NOT from the monitor.status_changed Event emission (which also logs the →warning edge). Warning / recovering flapping logs an event but does NOT propagate.
- "All-down" multi-parent: an asset with N effective parents suppresses iff every parent is down or itself dependencySuppressed. Empty parent set = never suppressed.
- Override resolution: if any source="override" row exists for an asset, those are the effective parents (computed rows ignored). Empty override set = explicit "no parents" pin (asset opts out entirely).
- Unmonitored parents are transparent — the suppression walk skips them and continues to their grandparents. A monitored ancestor must say "down" before suppression can fire.
- recomputeDependencyTree only touches source="computed" rows for in-scope assets; out-of-scope rows and source="override" rows are never deleted.
- Layer assignment is **physical-first** BFS from any FortiGate (layer 1). Interface + LLDP + mesh edges form the primary adjacency; controller edges are a fallback for assets the physical pass didn't reach. Controller-fallback uses simple-path detection: a 3+ node chain of unattached switches sharing one controller, with exactly two endpoints and no branching, chains correctly off the alpha-hostname endpoint. MCLAG pairs (2-node groups) and any branching/cycled component still attach as siblings to preserve co-layer behavior. Cycles, disconnected subgraphs, or chains through unmonitored intermediates may leave dependencyLayer = null. Kept-edge `detectedVia` prefers mesh > interface > lldp > controller so the audit trail reflects physical cabling when multiple signals exist on a pair.
- **Wireless attachments override the controller signal.** A mesh-leaf AP (station-match on its root AP, from `AssetWirelessStation`) gets a `mesh` edge to the root AP and its backwards controller edge is suppressed. A FortiLink switch bridged behind a FortiAP (an AP↔switch `AssetLldpNeighbor` adjacency where the switch is NOT the AP's controller parent) has its FortiLink controller edge suppressed and depends on the AP via LLDP. Both are computed in `recomputeDependencyTree` and passed to `buildDependencyEdgesFromInputs` (`meshEdges`, `bridgeLeafSwitchIds`). The bridged-switch discriminator (`switch ≠ AP.parentSwitch`) is a heuristic — verify against real fleet data.
- Reconciler runs in BFS layer order so parent's effective state is settled before children evaluate (otherwise multi-tier suppression could oscillate).

**When changing this:**
- Mirror cadence-dispatch changes in BOTH src/services/monitoringService.ts AND src/jobs/monitorAssets.ts. The two are parallel implementations and must stay in lock-step.
- Verify the propagateAfterStatusChange() hook still fires only from the confirmed up/down guard — never from the warning edge (which logs an event but must not propagate) or recovering churn.
- Run the dependencyTreeService.test.ts suite — covers BFS layers, MCLAG siblings, dual-homed multi-parent, all-down semantics, transparent unmonitored parents, confirmed-down-only edge.
- Smoke-test on dev: pick a live FortiGate, set monitorStatus="down" via direct DB write, wait one reconciler tick (≤60s); confirm child switches/APs flip to dependencySuppressed and emit monitor.dependency_suppressed Events.
- If the topology endpoint refactor lands: hit /api/v1/map/sites/:id/topology before/after; edge sets must match (same FG→switch / switch→AP edges) modulo the new dependencySuppressed flag on each node.
- Watch for cycles introduced by override edits: the override endpoint must reject inputs that would form a cycle (BFS-back-walk validation).

---

## cross-cutting/verbose-debug-mode

**What it is:** A per-integration `config.verboseLogging` boolean that, when true, surfaces step-by-step discovery + sync + monitor-worker logs to pino at info level (tagged `verbose: true`) so an operator can `journalctl -u polaris -f` and watch one integration's behavior in real time. Off by default; toggled per integration from the edit modal.

**The four touchpoints** (changing any one requires keeping the others consistent):

1. **Integration config schemas** ([src/api/routes/integrations.ts](src/api/routes/integrations.ts)) — every integration type's Zod schema (`FortiManagerConfigSchema`, `FortiGateConfigSchema`, `WindowsServerConfigSchema`, `EntraIdConfigSchema`, `ActiveDirectoryConfigSchema`) carries `verboseLogging: z.boolean().optional().default(false)`. New integration types added in the future must follow the same pattern.

2. **Discovery `onProgress` consumer** ([src/api/routes/integrations.ts](src/api/routes/integrations.ts) `onProgress` closure inside the discover route) — reads `integration.config.verboseLogging` once at discovery start. When true, every callback emits `logger.info({ verbose: true, integrationId, integrationName, step, level, device }, message)` in addition to the existing `logEvent()`.

3. **Sync phase markers** ([src/api/routes/integrations.ts](src/api/routes/integrations.ts) `syncDhcpSubnets` — `phaseMark(name)` helper) — when verbose is on, each `phaseMark()` call logs the elapsed time of the previous phase + starts the new phase's timer. A final `phaseMark("__end__")` closes the last phase right before the function returns.

4. **Worker handlers** ([src/services/queueService.ts](src/services/queueService.ts) `runDedicatedWorker` and `dispatchFloatingJob`) — read `job.data.verboseDebug` (stamped by the publisher in `monitorAssets.publishDueWork` when `discoveredByIntegration.config.verboseLogging === true`). When true, emit `monitor.worker.pickup` on entry + `monitor.worker.finish` on exit, with slot id, jobId, cadence, assetId, outcome, elapsedMs.

**Worker slot id scheme:** [src/utils/workerSlotPool.ts](src/utils/workerSlotPool.ts) hands out `<prefix>-W01..NN` for dedicated cadence pools (probe / fast / telemetry / sysinfo) and `floating-F01..NN` for the floating pool. Slot acquired on handler entry, released on exit so the same slot is reused across jobs — operators can trace one slot's lifecycle through journalctl. Slot bookkeeping runs every tick regardless of verbose mode; only the *logging* of slot ids is gated on the flag.

**Structured log payload contract:** every verbose line emits these fields — `verbose: true`, `integrationId` + `integrationName` (when scoped to an integration), `step` or `phase` (for discovery/sync), `workerSlot` + `jobId` + `cadence` (for workers), `assetId`, `elapsedMs` (when measured), `outcome` (for worker.finish: `"success" | "failure"`). The contract is what makes `journalctl -o json | jq 'select(.verbose==true)'` filtering work reliably; do not strip these fields when adding a new verbose log call.

**When changing this:**
- Adding a new integration type → add `verboseLogging` to its config schema, its frontend form helper, its `getXxxFormConfig` reader, and a Debug section to its General tab. See the 5 existing pairs for the template.
- Adding a new discovery step → it inherits verbose logging for free via the existing `onProgress` route. No code change required if the step uses the standard callback.
- Adding a new pg-boss queue → add a slot pool entry in `startPgbossWorkers` and use `runDedicatedWorker` (or pattern-match `dispatchFloatingJob`) so pickup/finish lines land for free.
- Adding a new sync phase → insert one `phaseMark("X")` call right under the `// Phase X — ...` comment. The previous phase's elapsed time is logged at the next phaseMark call; the final phase is closed by the `phaseMark("__end__")` at the bottom of `syncDhcpSubnets`.

---

## cross-cutting/pgbouncer-compatibility

**What it is:** Polaris is **PgBouncer-aware**. Operators who put PgBouncer (or any connection multiplexer) in front of PostgreSQL set `POLARIS_DB_DIRECT_URL` to the direct Postgres URL while `DATABASE_URL` points at PgBouncer. Polaris routes different code paths to one URL or the other based on what each path needs.

**Connection-string helpers** (`src/utils/dbConnections.ts`):
- `getApplicationDatabaseUrl()` — returns DATABASE_URL.
- `getDirectDatabaseUrl()` — returns POLARIS_DB_DIRECT_URL when set, else falls back to DATABASE_URL.
- `getDbConnectionMode()` — returns `"pgbouncer"` when the two URLs differ OR DATABASE_URL has `?pgbouncer=true`; `"direct"` otherwise.

**Routing rules:**
- **Application queries (Prisma client)** → DATABASE_URL via `src/db.ts`. Under PgBouncer this hits the multiplexer; under direct mode it hits Postgres straight.
- **pg-boss queue ops** → `getDirectDatabaseUrl()` in `src/services/queueService.ts:startPgbossWorkers`. Required: pg-boss uses LISTEN/NOTIFY and the pg client's prepared-statement cache, both of which break under PgBouncer transaction pooling.
- **`pg_dump` backup + restore** → `getDirectDatabaseUrl()` in `src/api/routes/serverSettings.ts` (`/database/backup` and `/database/restore` routes). PgBouncer doesn't proxy the COPY-heavy dump protocol reliably.
- **`pg_stat_activity` reads** (connection-pool snapshot) AND **`pg_stat_database` reads** (disk-read pressure: `blks_read`/`blks_hit`/`blk_read_time`/`track_io_timing`, via `readPgStatDatabaseIo()`) → dedicated `pg.Pool` (max 2) in `src/services/capacityService.ts:getDirectStatsPool()`, opened lazily only when PgBouncer mode is detected. Going through PgBouncer would show the multiplexed view of backend connections, which under-counts what Polaris actually holds.
- **express-session** → DATABASE_URL (PgBouncer-safe; low-volume INSERT/SELECT/DELETE with no LISTEN/NOTIFY, no held prepared statements).
- **Prisma CLI migrations** → operator concern. The in-app updater inherits whatever DATABASE_URL is set; CLI invocations under PgBouncer should explicitly set `DATABASE_URL=<direct URL>` before `npx prisma migrate deploy`. Documented in `docs/INSTALL.md`.

**Detection signal:** `polaris_db_connection_mode{mode}` gauge (set once at boot from `recordDbConnectionMode()` in `src/app.ts`) plus an info-level log line at boot. Operators verify Polaris recognized their topology without grepping for connection errors.

**Capacity Advisor caveat:** The advisor's `PG_MAX_CONNECTIONS` recommendation is sized to keep Polaris's pool at ≤65% of `max_connections`. Under PgBouncer mode this is a conservative upper bound — PgBouncer's `default_pool_size` × pool count is what actually hits Postgres, so a smaller `max_connections` is fine. UI shows a hint ("PgBouncer detected") above the recommendation table when applicable; the underlying math stays the same.

**When changing this:**
- Adding a new code path that issues `LISTEN`, `NOTIFY`, `pg_dump`, `pg_restore`, or any session-scoped state-machine SQL: route it through `getDirectDatabaseUrl()` so it doesn't break PgBouncer installs.
- Adding a new code path that reads `pg_stat_activity` or `pg_stat_database` for cluster-wide stats: route it through `getDirectStatsPool()` so the numbers are accurate.
- Routine read/write through Prisma: leave it alone. The application URL is the right path.

---

## cross-cutting/schema-migrations-and-prisma-client-lifecycle

**What it is:** The contract between `prisma/schema.prisma`, the generated Prisma client at `src/generated/prisma/` (gitignored), the compiled `dist/generated/prisma/`, and the in-app updater pipeline that holds them together. Polaris uses Prisma 7 with `provider = "prisma-client"` which emits TypeScript source — `prisma generate` writes to `src/generated/prisma/`, then `tsc` compiles to `dist/generated/prisma/`. The running process imports from `./generated/prisma/client.js` (see `src/db.ts`). The state the running process holds in memory must match the actual DB schema, or every Prisma query that selects the affected columns crashes with `column "<name>" does not exist`.

**Lifecycle (steps must execute in this order):**
1. **Schema edit** — `prisma/schema.prisma` is the source of truth for what the Prisma client knows about.
2. **Migration written** — `prisma/migrations/<ts>_<name>/migration.sql` describes how to evolve the DB from the previous shape to the new one.
3. **Generate** — `npx prisma generate` writes a fresh `src/generated/prisma/`. Triggered by the `postinstall` script in `package.json` after `npm install` / `npm ci`, AND by an explicit step in `applyUpdate` (since postinstall can be silently skipped — `npm ci --ignore-scripts`, partial install recovery, etc.).
4. **Compile** — `npm run build` (= `tsc && node scripts/copy-build-assets.mjs`) produces `dist/`. `dist/` must be cleaned first (`rm -rf dist`) because tsc is non-destructive: stale `.js` files from a prior generation can shadow the regenerated client if Prisma changed its internal file layout (the `prisma-client` provider's auxiliary files do this between minor versions). Build via `npm run build`, never bare `npx tsc` — the copy step mirrors the bundled std MIB `.txt` files into `dist/` (tsc won't), and skipping it breaks every std SNMP-walk. See `cross-cutting/deployment`.
5. **Migrate** — `npx prisma migrate deploy` applies pending SQL.
6. **Restart** — the running process picks up the new client + the new schema together.

**Writers** (files that drive each step):
- `prisma/schema.prisma` — schema source of truth.
- `prisma/migrations/*/migration.sql` — DB evolution.
- `package.json:postinstall` — calls `prisma generate` after deps install.
- `src/services/updateService.ts:applyUpdate` — orchestrates steps 3-6 in `cross-cutting/services/updateService.ts`'s seven-step pipeline.
- `prisma.config.ts` — Prisma 7 config (datasource URL, generator output path).

**Readers** (code that depends on the lifecycle's invariants holding):
- **All Prisma typed queries** (`prisma.asset.update`, `findMany`, etc.) — generated client decides which columns appear in `SELECT` / `RETURNING` clauses. A stale client crashes on any query that touches a dropped column even if the data payload doesn't.
- **Raw-SQL queries that hardcode column names** — NOT protected by the generated client; column renames must be propagated by hand. Known locations as of 2026-05-15:
  - `src/services/capacityService.ts` — `telemetryEligibleSQL` (`cpuMemoryPolling`), `systemInfoEligibleSQL` (`interfacesPolling`).
  - `src/services/capacityAdvisorService.ts:readApplicableCounts` — same two columns.
- **`src/db.ts`** — Prisma client extension; its `Asset.update` / `findMany` / `create` / `updateMany` / `upsert` wrappers go through whatever client is generated. Failure modes here surface as the generic `column "<name>" does not exist` errors in the log.
- **Operators reading the Maintenance tab** — `pg-tuning` and `capacity-advisor` routes consume the raw-SQL readers above; they 500 when those queries fail.

**Invariants:**
- The generated client and the DB schema must agree at every process start. Steps 3-6 are not optional; reordering them re-introduces the failure mode where the running client selects columns the DB no longer has.
- `src/generated/` is gitignored; the build pipeline (postinstall + the updater's explicit step) regenerates it from `schema.prisma`. Never check generated files in.
- A migration that DROPS a column requires every raw-SQL reader of that column to be updated in the same commit. The Prisma client gets rewritten automatically; raw SQL does not.
- A migration that RENAMES a column has the same constraint plus the additional risk that the rename can silently succeed (no DROP) but every reader still queries the old name.
- The updater's `rm -rf dist` between `prisma generate` and `tsc` is load-bearing — stale compiled JS from a previous Prisma-client version can shadow the fresh build.

**When changing this:**
- **Renaming or dropping any DB column:** grep the entire codebase for `prisma.$queryRawUnsafe` and raw-SQL strings containing the column name BEFORE writing the migration. Update those readers in the same commit as the migration.
- **Adding a step to the updater pipeline:** keep the generate → clean-dist → tsc → migrate → restart ordering intact. If the new step needs DB access, decide whether it should run pre- or post-migrate based on what schema state it expects.
- **Changing where the Prisma client is generated to:** update `tsconfig.json` includes, `package.json:postinstall` (if path changes), `.gitignore`, and re-verify `dist/` cleanup still wipes the right path.
- **Recovering a prod box stuck on a stale client:** the recovery procedure is `rm -rf src/generated dist && npx prisma generate && npm run build && systemctl restart polaris`. (`npm run build`, not bare `npx tsc`, so the std MIB asset copy runs.) Document this in the operator-facing runbook when the failure mode recurs.

**Related:** `cross-cutting/services/updateService.ts` invariants encode the same ordering rules at the pipeline-step level; this section is the broader contract.

---

## cross-cutting/observability-metrics

**What it is:** The Prometheus `/metrics` surface. One `Registry` singleton in `src/metrics.ts`, one helper per metric (callers never import the metric object directly), CPU/process defaults from `prom-client.collectDefaultMetrics`. Three label-discipline rules: `route` is the matched Express template not the URL; `integrationId` is the only UUID-shaped label allowed; everything else is bounded (cadence, transport, table, queue, state, status_class, severity, mode, status, outcome, job).

**Writers** (files that emit metric values):
- `src/services/monitoringService.ts` — pass timer, work-item timer + outcome, probe duration + outcome, monitored-asset gauge, cursor-mode queue depth gauge, sample-write timer per table (asset_monitor_samples / asset_telemetry_samples / asset_hardware_sensor_samples / asset_interface_samples / asset_storage_samples / asset_ipsec_tunnel_samples / asset_perf_sla_samples / asset_sdwan_rule_samples / asset_associated_ips / asset_lldp_neighbors / asset_mac_addresses).
- `src/services/queueService.ts:refreshPgbossMetrics()` — every 15s in pg-boss mode; emits `polaris_pgboss_queue_jobs{queue,state}` (counts) AND `polaris_pgboss_oldest_job_age_seconds{queue,state}` (oldest waiting job's age, MIN(created_on) per queue×state). Also emits `polaris_monitor_queue_mode` once at boot in `initializeQueue()` and `polaris_monitor_workers` from `startPgbossWorkers()`.
- `src/services/fmgWorker.ts` — per-integration queue depth + inflight gauges (one set per integrationId).
- `src/jobs/monitorAssets.ts` — `polaris_monitor_workers` cursor-mode seed at module load; mirrors `setMonitoredAssets` from the pg-boss publisher path so both modes drive the same gauges.
- `src/jobs/capacityWatch.ts` — every 10 min from `getCapacitySnapshot()`: emits `polaris_db_pool_*` (in_use / peak_observed / polaris_capacity / max), `polaris_capacity_severity`, `polaris_disk_free_ratio{volume,roles}`, `polaris_db_dead_tuple_ratio{table}`, `polaris_db_size_bytes`, `polaris_db_steady_state_size_bytes`. Volume + table gauges are `.reset()` before re-stamping each tick so dropped volumes / removed tables don't leave orphan series.
- `src/api/routes/integrations.ts` — discovery duration histogram + outcome counter at all three integration outcomes (success / abort / failure) alongside the existing `recordSample()` call.
- `src/app.ts` — HTTP request timer + in-flight gauge middleware (mounted right after CSRF; skips `/metrics` and `/health`; `/api/v1/auth/login` rate-limited 429s still observed).
- `src/jobs/_metrics.ts:runInstrumentedJob(name, fn)` — every job in `src/jobs/` wraps its tick body with this helper; emits `polaris_job_duration_seconds{job}` + `polaris_job_total{job, outcome}` without changing the job's existing error semantics. `monitorAssets.probe` and `monitorAssets.heavy` are the two label values from the only multi-tick job.
- `src/jobs/integrationConnectionTester.ts` — per-integration `polaris_integration_test_total{integration_type, outcome}` counter at every per-integration result (`success` | `failure` | `skipped`). Paired with a `logger.info` line on the same code paths so journalctl carries the per-tick error message that the counter alone doesn't include. **DISABLED 2026-06-02** (not imported in `app.ts`) — the counter therefore no longer increments; the metric remains defined in `src/metrics.ts` pending the planned tester removal.

**Readers** (operators / scrapers / out-of-band consumers): `/metrics` HTTP endpoint in `src/app.ts`, gated by `METRICS_TOKEN` Bearer-token auth (auto-generated by the first-run setup wizard). No internal callers — everything Polaris uses comes from in-process state directly.

**Invariants:**
- Single `Registry` singleton — never create a second one. `collectDefaultMetrics` is registered at module load.
- Helpers, not raw metric objects. Callers import `recordProbe(...)` not `probeDuration` so renames or label changes are localized.
- Cardinality is bounded by design. The only non-bounded labels are `integrationId` (counted in dozens) and `route` (counted in route templates, not URLs).
- Cursor-mode-only metrics zero out in pg-boss mode and vice versa — never assume both families are populated. Use `polaris_monitor_queue_mode` to pick which family is authoritative on a given instance.
- `polaris_disk_free_ratio` and `polaris_db_dead_tuple_ratio` are `.reset()` before each capacityWatch re-stamp; volume label set is "current filesystems," not "every filesystem ever seen."
- Sample-write timing is observed only on successful writes. A throw skips the `stop()` call, which is the desired behavior — failures don't pollute the latency distribution.
- Discovery duration histogram observes only on `outcome="success"`; failure/aborted outcomes increment the counter without distorting P95.
- HTTP middleware skips `/metrics` itself so scrape requests aren't counted as application traffic. `/health` skipped for the same reason.

**When changing this:**
- Adding a metric? Define the metric object + its helpers in `src/metrics.ts`, then call from one place. Update the Observability section of CLAUDE.md AND add panels for it in `docs/grafana/polaris-monitoring-dashboard.json` (with a matching bullet in `docs/grafana/README.md`). Prometheus picks up new series automatically on the next scrape, but Grafana panels pin specific metric names + label sets — they go blank silently if not updated.
- Renaming or removing a metric / label? Grep `docs/grafana/polaris-monitoring-dashboard.json` for the old name and update or drop the affected panels in the same commit; the old series stays in Prometheus storage until retention expires (default 15d) but stops getting new samples, so the panel will read flat-zero or no-data until fixed.
- Adding a job? Wrap the tick body in `runInstrumentedJob("name", async () => ...)` from `src/jobs/_metrics.ts`. Use a stable, machine-readable name (no spaces, no version suffixes); split-loop jobs use `<module>.<loop>` (e.g. `monitorAssets.probe`).
- Adding a label? Audit cardinality first — a per-asset label would explode at fleet scale. If the value is a UUID or per-row, push it into a histogram bucket or aggregate it instead.
- Pg-boss → cursor or vice versa? Both modes' metrics keep emitting; the gauge that doesn't apply stays at 0. Don't conditionally remove either family.
- Changing `getCapacitySnapshot()` shape? Update the `setCapacityGauges` adapter in `capacityWatch.ts` so the gauge stamping doesn't drift from the snapshot fields.
- Changing the HTTP middleware? It must run after session+CSRF (so `req.session` / status are valid) but before the route layer (so `req.route?.path` is captured at finish-time). The current mount point is right after `csrfMiddleware`.

---

## cross-cutting/tiered-sample-retention

**What it is:** Two-axis storage policy for the eight monitor sample tables. **Tier axis**: detail (raw samples) → hourly aggregates → daily aggregates. **Retention axis**: each tier has its own days-to-keep, per device class (default / switch / accessPoint), per stream (sample / telemetry / systemInfo). Chart history requests at long ranges read from the rollup tiers (cheap), short ranges read from detail (raw). Phase rollout 0–6 retired the per-tier monitor-settings retention fields in favor of a single global `Setting("sampleRetention")` edited from Server Settings → Maintenance.

**Schema:**
- Eight source tables (`asset_*_samples`) — unchanged shape, partitioned by `timestamp`.
- Sixteen rollup tables (`asset_*_samples_hourly` + `asset_*_samples_daily`) — partitioned by `bucketStart`. Gauge tables carry avg/min/max; counter tables carry first/last endpoints + `lastBucketSampleAt` so rate = `(last - first) / (lastBucketSampleAt - bucketStart in seconds)`, dropping negative deltas as counter resets.
- All 24 tables can be Timescale hypertables (`timescaleService.ALL_HYPERTABLE_CANDIDATES`); plain Postgres works just as well, just without chunk-drop pruning. (`tests/unit/timescaleTables.test.ts` drift-guards the inventory: rollup-writer / prune-layer / schema table references must stay ⊆ the managed lists.)

**Writers:**
- `src/services/sampleWriteBuffer.ts:enqueue*` — eight detail tables via batched createMany every 2 s. Append-only, no upsert. (The two SD-WAN streams — `asset_perf_sla_samples` / `asset_sdwan_rule_samples` — were added alongside `enqueuePerfSlaSamples` / `enqueueSdwanRuleSamples`; both fed from `recordSystemInfoResult` when `collectSdwanFortinet` ran, gated by `Integration.config.pullSdwan`.)
- **SD-WAN stream change-checklist** (mirror the IPsec stream end-to-end): `prisma/schema.prisma` (detail + `*Hourly`/`*Daily`) → migration → `monitoringService` (`PerfSlaSample`/`SdwanRuleSample` interfaces, `collectSdwanFortinet` + pure parsers `parsePerfSlaHealthCheck`/`parseSdwanRules`/`parseSdwanSlaThresholds`, `includeSdwan` gate in `collectSystemInfoFortinet`, persist in `recordSystemInfoResult`, prune in `pruneSystemInfoSamples`) → `sampleWriteBuffer` (row type + buffer key + `TABLE_LABEL` + `flushing` + enqueue + `writeBatch` case) → `sampleRollupService` (`DEFS` + `SourceTable` + `buildSql` + SQL helpers) → `sampleRetentionService` (`RetentionEntity` + `RETENTION_ENTITIES` + default) → `sampleHistoryService` (`readPerfSlaHistory`/`readSdwanRuleHistory`) → `assets.ts` routes → `public/js/{api,assets,integrations,server-settings}.js`. The integration toggle `pullSdwan` is added to BOTH `FortiManagerConfigSchema` + `FortiGateConfigSchema` (parity).
- `src/services/sampleRollupService.ts:rollupHourly() / rollupDaily()` — INSERT...ON CONFLICT DO UPDATE per (table, tier). Driven by `src/jobs/runSampleRollup.ts` (hourly tick every 30 min, daily tick at 02:30 UTC). Sources for daily reads from `*_hourly`, not detail, so the daily tick stays bounded on big fleets.
- `src/services/monitoringService.ts:pruneMonitorSamples / pruneTelemetrySamples / pruneSystemInfoSamples` — fire from `src/jobs/monitorAssets.ts` heavy-loop daily prune; each helper calls `pruneOneTable` once per (table × tier × class) with retention from `getSampleRetention()`.
  - **Selection-aware detail prune (`pruneSelectionAwareDetail`, interfaces/storage/ipsec) MUST NOT row-DELETE inside a compressed chunk.** The unselected/slow deleteMany is lower-bounded at the compressed-chunk frontier via `unselectedSlowPruneWindow(now, getEffectiveCompressAfterDays(table))` (sampleRetentionService + timescaleService). A DELETE matching rows in a compressed TimescaleDB chunk decompresses the whole chunk into its rowstore heap → un-truncatable low-density bloat (prod incident 2026-06-08). Slow rows past the frontier ride compressed until `drop_chunks` removes the whole chunk at the selected window. If you change the compress-after window source or the 1-day chunk interval, re-check this bound.
- `src/jobs/reclaimBloatedChunks.ts` — daily safety net that `VACUUM (FULL)`s already-compressed selection-aware chunks whose on-disk heap dwarfs their compressed bytes (the residue of any decompress-on-DELETE that slipped past the prune bound, plus pre-fix bloat). Read-only detection via `chunk_compression_stats()`; bounded + `lock_timeout`-guarded on a dedicated `getDirectDatabaseUrl()` connection. Registered under `cfg.runsSchedulers` in `src/app.ts`.

**Readers:**
- `src/services/sampleHistoryService.ts:read*History` — six tier-aware readers, one per source. Detail tier returns raw rows; rollup tiers translate aggregate columns back to source field names so existing chart renderers consume both shapes with no per-tier branching except for counter-rate pre-computation.
- `src/api/routes/assets.ts` — six `/assets/:id/*-history` endpoints dispatch to the right reader via `pickSampleTierForAsset(assetId, stream, since)` from `sampleQueryRouter`.
- `src/services/capacityService.ts:projectSteadyStateSize` — enumerates all 24 tables and multiplies retention × rows/asset/day × bytes/row per (stream, tier, default class) for the steady-state footprint projection.

**Settings store:**
- `Setting("sampleRetention")` — flat `{stream: {tier: {class: days}}}` shape, 27 numbers total. Defaults 7/30/365. Backed by `src/services/sampleRetentionService.ts` with a 5 s in-process cache (chart endpoints read on every request).
- Edited from `public/js/server-settings.js:renderSampleRetentionCard()` (Server Settings → Maintenance tab) via `GET / PUT /server-settings/sample-retention`.

**Lifecycle / migrations:**
- `src/jobs/renameMonitorClassKeys.ts` (phase 0) — renames legacy `fortiswitch` / `fortiap` keys to `switch` / `accessPoint`.
- `src/jobs/migrateSampleRetentionToEntities.ts` — converts the legacy class-shaped `Setting("sampleRetention")` to the per-entity shape (`assets`/`cpuMem`/`hardware`/`interfaces`/`storage`/`ipsec`/`perfSla`/`sdwanRule`), flipping legacy `0`=forever to `FOREVER`(-1). Replaced the older `migrateRetentionTiers` / `consolidateSampleRetention` class-shaped seeders.
- Each migration is idempotent via its own marker Setting; safe to re-run by deleting the marker and restarting.

**Invariants:**
- **Same tier shape everywhere.** Detail / hourly / daily aggregates must produce the same field names per source so the chart renderers can hold a single shape per source. Adding a new aggregate column to a rollup table requires a matching update in both `sampleRollupService` (SQL) and `sampleHistoryService` (reader translation).
- **Counter rate convention.** First/last + lastBucketSampleAt is the contract. Negative deltas drop as resets — matches detail-tier client-side diff in `_derivePerIntervalSeries` / `_deriveIpsecThroughput`.
- **Retention is global.** Cadence / polling method / credentials / MIB hints / timeouts stay in the per-tier monitor-settings hierarchy (`MonitorClassOverride`, `Integration.config.monitorSettings`, `Setting("manualMonitorSettings")`); only retention is global. Don't re-introduce per-integration retention.
- **Rollup writes are upsert.** Don't try to push rollup writes through `sampleWriteBuffer` — the buffer's append-only contract intentionally has no upsert path.
- **Sample/rollup tables have NO foreign key to Asset (migration `20260615000000`). Never re-add `@relation`/`onDelete: Cascade`, and never row-DELETE/UPDATE sample rows inside a compressed chunk.** Any per-row DML matching a compressed TimescaleDB chunk decompresses the whole chunk → un-truncatable heap bloat (prod incident 2026-06-08; root cause was the asset-delete cascade hitting compressed sample chunks). Deleting an Asset now leaves its sample rows orphaned (`assetId` → gone Asset, queried only by assetId so never surfaced) and they age out via `drop_chunks` on the retention schedule — the only compression-safe deletion. Consequence: a deleted asset's sample storage is freed at retention time, not instantly. Retention stays compression-safe via the bounded slow-prune (`unselectedSlowPruneWindow`) + `drop_chunks`; `reclaimBloatedChunks` (every 6h) is the residual-bloat net. Applies to every `Asset*Sample` + `*Hourly`/`*Daily` + `AssetCustomWidgetSample` (note: `AssetCustomWidgetSample` has no prune path and is not Timescale-managed — its orphaned rows persist indefinitely; known gap, see the model comment in prisma/schema.prisma).

**Observability:**
- `polaris_sample_rollup_duration_seconds{tier,table}` (histogram) — per-INSERT wall-clock from sampleRollupService.
- `polaris_job_duration_seconds{job}` + `polaris_job_total{job, outcome}` — `sampleRollup.hourly` and `sampleRollup.daily` job-level wrappers via `runInstrumentedJob`.
- `Setting("sampleRollup.<tier>.lastSuccess")` — stamped on every successful tick. `capacityService` reads both into `database.rollupLastSuccess` and fires the `sample_rollup_lagging` watch reason when hourly is >6 h stale or daily is >36 h stale AND any sample table has rows.

**When changing this:**
- New rollup column → schema update + sampleRollupService SQL builder for both hourly and daily tiers + sampleHistoryService reader translation. Run `npx prisma migrate diff --from-schema /tmp/old.prisma --to-schema prisma/schema.prisma --script` and commit the resulting `migration.sql`.
- New retention entity → add to `RetentionEntity` + `RETENTION_ENTITIES` in `sampleRetentionService.ts`, add the entity to `defaultSampleRetention()`, extend the Retention card's entity rows, add/extend the per-entity prune helper in `monitoringService`, and (if selection-aware) add it to `SELECTION_AWARE_ENTITIES` + stamp `cadence` in its writers.
- Retention default change → update `DEFAULT_DETAIL_DAYS` / `DEFAULT_HOURLY_DAYS` / `DEFAULT_DAILY_DAYS` in `sampleRetentionService.ts`.

---

## cross-cutting/csp-inline-script-policy

**What it is:** Helmet's Content-Security-Policy in `src/app.ts` sets `scriptSrc: ["'self'"]` — every `<script>...</script>` block with inline content is BLOCKED by the browser. Only external `<script src="...">` tags and inline `on*=` handler attributes (allowed via `scriptSrcAttr: ["'unsafe-inline'"]`) are permitted. This is the most dangerous XSS vector closed by the strict CSP, and it must stay closed.

**Writers** (anywhere a Polaris route or stub HTML emits inline scripts — must be EMPTY of inline scripts):
- `src/app.ts` — `legacyIpamRedirect()` stub HTML. Loads `/js/legacy-ipam-redirect.js` (external file at `public/js/legacy-ipam-redirect.js`) which reads `location.pathname` to decide the target tab and `location.hash` to preserve the legacy fragment, then `location.replace()`s to `/ipam.html#tab=<tab>&<legacyHash>`. Was a `blank page` regression for two weeks (2026-04 to 2026-05) when this used an inline `<script>` block — CSP silently blocked the redirect, leaving a blank body. Symptom for the operator: clicking "View Lease → Open in Networks" on the assets page navigated to `/subnets.html#ip=<sid>@<ip>` and stayed blank.
- Any future server-rendered stub or framework view should use an external file (or pass data via `data-*` attributes that the external script reads via `document.currentScript.dataset`).

**Readers** (the CSP itself):
- `src/app.ts` — Helmet `contentSecurityPolicy.directives.scriptSrc: ["'self'"]` blocks inline; `scriptSrcAttr: ["'unsafe-inline'"]` keeps `onclick="..."` working because most pages still build HTML via `innerHTML`.
- `connectSrc` is `'self'` plus exactly two whitelisted hosts: `https://fonts.googleapis.com` + `https://fonts.gstatic.com` — fetch()ed by the asset-details Screenshot buttons (desktop `_screenshotAssetDetails` in `public/js/assets.js` and mobile `screenshotSheet` in `public/js/mobile/asset-detail.js`; the vendored html-to-image inlines the page's webfonts into its DOM snapshot so the captured PNG renders in Inter/Roboto Mono). The capture degrades to fallback system fonts when these hosts are unreachable, so removing them breaks fidelity, not function. Don't widen connectSrc beyond specific origins with a documented consumer.

**Invariants:**
- Never emit `<script>...code...</script>` from any HTTP route handler or static file. Always use `<script src="/js/something.js"></script>`. If the inline script needs runtime values from the server, render those as `data-*` attributes on a placeholder element and read them in the external script.
- Adding a CSP hash or nonce for ONE inline script is a slippery slope — it normalizes the pattern. Prefer an external file unless there's a hard reason (e.g. shipping a critical-rendering-path bootstrap that must run before the first paint AND can't be moved to `<head>` async).
- `scriptSrcAttr: 'unsafe-inline'` is the only inline allowance; it's there because `innerHTML`-built `onclick="foo(...)"` is everywhere in the frontend. Don't widen the main `scriptSrc`.
- Browsers fail SILENTLY on CSP block — DevTools console shows the violation but the page renders blank with no JS-thrown error. Always test stub HTML by visiting it in a browser with DevTools open, not just by curling the response and inspecting the body.

**When changing this:**
- Adding a server-rendered HTML stub? Move ALL JS into an external file under `public/js/`. The route handler returns markup with `<script src="..."></script>` only — no inline blocks.
- Need server-side state in client-side code? Render the state into the HTML as `data-*` attributes (`<div id="boot" data-foo="bar">`), then read it from the external script via `document.getElementById("boot").dataset.foo`. Never interpolate JSON into an inline `<script>` block.
- Loosening the CSP for a third-party widget (analytics, support chat, embedded video)? Add the specific origin to `scriptSrc`, not `'unsafe-inline'`. Document the exception in the directive's comment.
- Testing a stub-HTML change? Visit the URL in a browser with DevTools console open — a blocked inline script logs `Refused to execute inline script because it violates the following Content Security Policy directive: "script-src 'self'"`. A blank body with no JS-thrown error in the source IS the CSP-blocked symptom.
- Adding inline `<style>` tags? Those are allowed via the existing `styleSrc: ["'self'", "'unsafe-inline'"]`. Only scripts have the strict rule.

---

## cross-cutting/dynamic-roles-permission-matrix

**What it is:** Per-route RBAC enforced by `requirePermission(functionKey, level)` against the caller's `Role.permissions` matrix (post-cutover model). The five seeded built-in roles reproduce the pre-cutover hardcoded `UserRole` enum's access exactly; operator-created custom roles fill in any per-function gap admins want. Replaces the deleted `requireAdmin` / `requireNetworkAdmin` / `requireAssetsAdmin` / `requireUserOrAbove` / `isNetworkAdminOrAbove` helpers.

**Writers** (mutate the Role table OR stamp the session snapshot OR write per-user/per-role region scope):
- `src/services/roleService.ts` — `createRole` / `updateRole` / `deleteRole` enforce built-in + protected invariants, normalize the permissions JSON, validate region tags, validate the `#rrggbb` badge color (`normalizeColor`), bump the in-process role-version cache via `bumpRoleVersion(roleId, updatedAt)`, and emit `role.created` / `role.updated` / `role.deleted` Events with per-field diffs.
- `src/api/routes/roles.ts` — Per-method `requirePermission("roles", ...)` gates + Zod schema acceptance for the `permissions` matrix + `regionTags` + `otherTags` + `color`.
- `src/api/routes/users.ts` — `POST /users` + `PUT /:id/role` accept `roleId`; `PUT /:id/regions` writes `User.regionTags` + `User.otherTags`; password-reset guard refuses any `authProvider !== "local"`; both enforce the `lastAdminEquivalent` invariant.
- `src/api/routes/auth.ts` — Login (local + TOTP), LDAP branch, SAML callback, and OIDC callback load `user.role` and stamp `req.session.{roleId, roleSnapshot, role, authProvider}` via `snapshotFromRole`. `/auth/me` returns the role snapshot + `regionTags`/`otherTags` each as `{user, role, group, effective}` (group re-resolved from `User.ssoGroups` via `resolveGroupsToAccess`).
- `src/services/azureAuthService.ts` — `findOrProvisionSamlUser` auto-provisions new SAML users with the `readonly` role (SAML group reading not wired; OIDC/LDAP use the group-mapping path below).
- `src/services/ssoProvisioning.ts` — `provisionExternalUser` (OIDC + LDAP): resolves IdP groups → role+tags, assigns the group-resolved role (highest-priv) or keeps an existing user's role on no-match, records `ssoGroups`.
- `src/services/groupMappingService.ts` — `GroupMapping` CRUD + `resolveGroupsToAccess`; the writer of `groupMapping.*` Events (warning when a mapping targets an admin-equivalent role).
- `src/api/middleware/permissions.ts` — `loadRoleSnapshot` rewrites `req.session.roleSnapshot` + persists via `req.session.save()` when the cached `updatedAt` is newer than the snapshot. `rankRole` / `pickHighestPrivilegeRoleId` rank roles for highest-privilege-wins group resolution.

**Readers** (consult the matrix or the session snapshot to gate behavior):
- `src/api/middleware/permissions.ts` — `requirePermission` / `hasPermission` / `requireOwnership` / `requireSessionOrTokenPermission`. All route guards funnel through here.
- Every route module under `src/api/routes/` — declares its per-route gate via `requirePermission(functionKey, level)`. Ownership-dimensioned routes (`subnets.ts`, `reservations.ts`) additionally branch on `req.permissionLevel === "fullwrite"`.
- `src/api/routes/conflicts.ts` — `visibleEntityTypes(req)` and `canResolve(req, entityType)` consult `hasPermission(req, "discoveryConflicts", ...)` plus role NAME (`req.session.role`) for back-compat with the historical networkadmin↔reservation / assetsadmin↔asset split. Custom roles with `discoveryConflicts=write` see both entity types by default.
- `src/app.ts` — Static-page redirect: `/users.html` / `/integrations.html` / `/server-settings.html` consult `req.session.roleSnapshot.permissions[key]` against the matching `pageRequiredPermission` entry; out-of-scope users bounce to `/`.
- `public/js/app.js` — `permAtLeast(functionKey, level)` consumes `currentRolePermissions` populated from `auth.me.role.permissions`. The `isAdmin()` / `canManageNetworks()` / `canManageAssets()` / `isUserOrAbove()` / `canReviewConflicts()` / `canEditSubnet(subnet)` / `canEditReservation(reservation)` shims were rewritten to call `permAtLeast` and are the back-compat surface for the existing call sites across assets.js, subnets.js, reservations.js, integrations.js, events.js.
- `public/js/users.js` — `loadRoles` consumes `GET /roles` + `GET /roles/functions`; `openRoleSlideover` renders the matrix + the badge color picker (random default for new roles, live preview); `openUserRegionsModal` writes `User.regionTags`. Role badges (users table + Manage Roles list) and `public/js/app.js`'s sidebar user-badge color via `roleBadgeStyleFromColor(role.color)`, falling back to the legacy `.badge-*` classes when `color` is null.
- `public/js/mobile/app.js` — Mobile bootstrap reads `data.role.name` and `data.role.permissions` from /auth/me, storing them on `user.role` (string) + `user.permissions` (object) for the rest of the mobile bundle. Existing mobile role-name checks (reservations-tab.js, subnet-detail.js, more-tab.js) keep working for the seeded roles.

**Cache invalidation:**
- `roleVersionMap` in `permissions.ts` — Map<roleId, ISO updatedAt>. Lazily populated on first request per role; `bumpRoleVersion` writes the new stamp after every Role write; `loadRoleSnapshot` reads it on each request and triggers ONE Prisma fetch + `req.session.save()` when the cached version is newer than the snapshot. Sub-millisecond when in sync.
- Changing a USER's roleId takes effect on next login (the snapshot is regenerated). Changing a ROLE's permissions takes effect on next request for every session that holds the role.

**Invariants:**
- `Role.isProtected=true` (admin + readonly only) blocks all edit/delete/rename operations at the service layer regardless of frontend hidden state.
- `Role.isBuiltIn=true` blocks delete (the three editable built-ins networkadmin/assetsadmin/user can be renamed/edited but not deleted).
- `lastAdminEquivalent` (userService): every mutation that would leave Polaris with zero users holding `users=fullwrite` AND `roles=fullwrite` returns 409.
- Custom role names cannot collide with `admin` / `readonly` (case-insensitive reserved-name guard).
- Permissions JSON is normalized on every write: unknown function keys dropped, missing keys defaulted to `"none"`. The route layer never trusts the raw body shape.
- Region/other tag normalization (shared `src/utils/tagNormalize.ts`): trim → drop empties → dedupe case-insensitively → cap length (64 chars) + count (64 entries).
- Group-derived tags are computed at read time (`/auth/me` from `User.ssoGroups`) and NEVER written to `User.regionTags`/`User.otherTags` — operator-set per-user tags survive a re-login.

**When extending the matrix:**
See `TEMPLATES.md` → "Permission-gated route + dynamic-role function key" for the recipe (add to FUNCTION_KEYS, migrate every Role's permissions JSON, wire the route guards, document in CLAUDE.md).

---

## cross-cutting/sso-login-and-group-mapping

**What it is:** OIDC + LDAP user login and the IdP-group → role+tags mapping layer. `authProvider ∈ {local, azure, oidc, ldap}`.

**Login entry points:**
- `POST /auth/login` (auth.ts) — local password OR LDAP branch (when the account is `authProvider="ldap"` OR the username is unknown and LDAP is enabled). Shared lockout counter applies to both.
- `GET /auth/oidc/login` + `GET /auth/oidc/callback` (auth.ts) — OIDC Authorization-Code + PKCE; state/nonce/codeVerifier stashed in the (PG) session between the two.
- `POST /auth/azure/callback` — SAML (unchanged; no group reading yet).

**Services:** `oidcAuthService.ts` (openid-client v6), `ldapAuthService.ts` + shared `ldapClient.ts` (ldapts; also used by `activeDirectoryService.ts` for computer discovery), `ssoProvisioning.ts` (shared provision/role-assign), `groupMappingService.ts` (CRUD + `resolveGroupsToAccess`).

**Settings** (Setting rows, admin-only via `serverSettingsSystem:write`): `oidc` (secret masked) + `ldap` (bindPassword masked). Each has a `POST /auth/{oidc,ldap}/test`.

**Invariants / gotchas:**
- LDAP: reject empty passwords before binding (unauthenticated-bind trap); RFC-4515-escape the username (`escapeLdapFilterValue`); fail closed on 0/>1 search hits.
- OIDC: requires `POLARIS_PUBLIC_URL` (redirect URI derivation); Azure `groups` claim emits GUIDs + drops past ~200 groups.
- Highest-privilege role wins on multi-group match; tags union; provider isolation via `@@unique([provider, groupKey])`.
- A GroupMapping → admin-equivalent role is a privilege-escalation surface (logged at warning level).

**When adding a sample/login provider field:** update the service's settings shape (mask secrets, preserve-on-unchanged), the matching tab in `public/js/users.js` (`buildOidcTab`/`buildLdapTab` + `getOidcFormData`/`getLdapFormData`), and `public/js/api.js`.

---

# Per-service touches

Listed alphabetically.

## services/activeDirectoryService.ts

**What it owns:** On-prem Active Directory device discovery via LDAP/LDAPS client (computer objects, OU filtering, SID/GUID identity, disabled-account handling).

**Public API:** testConnection, proxyQuery, discoverDevices, ActiveDirectoryConfig, DiscoveredAdDevice, AdDiscoveryResult, AdDiscoveryProgressCallback.

**Cross-service deps:** None (pure LDAP client; no service-to-service calls).

**Used by:** src/api/routes/integrations.ts,701,874,1111,1250 — discovery trigger, test connection, manual LDAP proxy query, sync path syncActiveDirectoryDevices.

**Invariants:**
- LDAP simple bind (no Kerberos); default port 636 (LDAPS) or 389 (plain LDAP).
- Device identity: AD `objectGUID` (lowercased hex) → `Asset.assetTag = "ad:{guid}"` (legacy) and `AssetSource.externalId` with `sourceKind="ad"`.
- Cross-link via `objectSid` (string SID) == Entra's `onPremisesSecurityIdentifier` → `tags` stamped with `sid:{SID}` (uppercase) for hybrid-join matching.
- Disabled accounts (userAccountControl & 0x2) → `decommissioned` status when includeDisabled=true (default); skipped entirely when false.
- `ouInclude`/`ouExclude` filters match against full distinguishedName with wildcard support (e.g., `*OU=Workstations*`).
- `lastLogonTimestamp` replicates ~14 days; use as coarse "last seen" signal only.
- Paged subtree search under baseDn with filter `(&(objectCategory=computer)(objectClass=computer))`; hard cap 10,000 results.
- proxyQuery is LDAP search pass-through (filter/baseDn/scope/attributes/sizeLimit configurable).

**When changing this:**
- Verify LDAP bind connection + TLS options (verifyTls flag) still work for LDAPS.
- Test OU filtering (ouInclude/ouExclude wildcard match) against distinguishedName.
- Confirm disabled-account tagging (`ad-disabled` tag) and status logic (decommissioned).
- Check SID cross-link stamping `sid:{SID}` (uppercase) for hybrid-join asset deduplication.
- Validate syncActiveDirectoryDevices creates correct AssetSource rows with sourceKind="ad".
- Test paged search (page size 1000) doesn't miss assets with large OU hierarchies.
- syncActiveDirectoryDevices in integrations.ts runs a forward-DNS pre-pass (via dnsService.getConfiguredResolver) to fill Asset.ipAddress for new + IP-less existing assets. Gate is `!existing.ipAddress` — never overwrites a non-empty IP from FortiGate/Entra/operator. ipSource stamped "activedirectory-dns".

---

## services/allocationTemplateService.ts

**What it owns:** Named saved multi-subnet allocation templates backed by Setting table.

**Public API:** listTemplates, saveTemplate, deleteTemplate.

**Used by:** src/api/routes/allocationTemplates.ts (all CRUD operations).

**Invariants:**
- Templates stored as JSON blob in Setting.networkAllocationTemplates
- Prefix length must be [8, 32] per entry
- Non-skip entries require a name; skip entries reserve space only
- VLAN, when present, must be [1, 4094]
- Template name uniqueness (case-insensitive) enforced
- anchorPrefix optional, defaults to 24 if omitted when used

**When changing this:**
- Verify saveTemplate's name-collision detection (idempotent update vs new insert)
- Check prefix length validation matches subnetService expectations
- Test that VLAN validation in allocationTemplateService is consistent with route schema

---

## services/mapRegionService.ts

**What it owns:** Operator-drawn map regions (polygons on the Device Map). CRUD on Setting JSON blob keyed `mapRegions`. Tag-mutation primitives that add `region:<name>` to in-polygon firewalls + cascaded FortiSwitches/FortiAPs and strip it on rename/delete. Tag-registry mirroring (upserts a `Tag` row at `region:<name>` under category "Map Regions" so the asset edit modal's tag picker shows it).

**Public API:** MapRegion, SaveRegionInput, ReconcileSummary, listRegions, getRegion, createRegion, updateRegion, deleteRegion, applyRename, applyDelete, applyOneRegion, reconcileMapRegions.

**Cross-service deps:** `src/utils/geo.ts:pointInPolygon`, `prisma.tag` (registry mirror), `prisma.asset` (membership compute + tag mutations).

**Used by:**
- `src/api/routes/mapRegions.ts` — all CRUD endpoints (`GET / POST / PUT / DELETE /map/regions`); each call awaits the appropriate apply* helper before responding.
- `src/api/routes/integrations.ts` Phase 13 — end-of-syncDhcpSubnets (`mode in {"full", "finalize"}`) calls `reconcileMapRegions()` so newly-discovered firewalls' coords land in the right regions.
- `src/jobs/reconcileMapRegions.ts` — 6h periodic safety net.

**Invariants:**
- Region name unique case-insensitively, 1..64 chars, no control characters.
- Polygon ≥3 vertices and ≤1000; lat in [-90,90]; lng in [-180,180]; finite numbers only.
- `color` is a 7-char hex string (`/^#[0-9a-fA-F]{6}$/`). On create it defaults to a random pick from the shared `TAG_COLOR_PALETTE`; on read, legacy rows missing the field are filled in with a random pick (not persisted until the next update).
- Reconciler is **add-only**: only the rename + delete CRUD paths strip a region tag. Manual operator attachments to out-of-polygon assets persist across runs.
- Manually removing a region tag from an in-polygon asset will be re-added on the next reconcile (polygon membership is authoritative in the additive direction).
- Tag-registry rows under category "Map Regions" stay in 1:1 correspondence with region names (create upserts; rename rotates; delete removes).

**When changing this:**
- If the tag prefix or category constants change, also update CLAUDE.md "Map Regions" section + the assets edit modal's tag picker label conventions.
- Membership logic depends on `Asset.fortinetTopology.controllerFortigate` matching firewall hostnames; if discovery ever stops setting that field, the cascade silently breaks. Add a coverage test if discovery topology shape evolves.
- Polygon antimeridian crossings are documented out-of-scope; if Polaris ever supports global polygons, audit `pointInPolygon` for that case.

---

## services/firewallTagService.ts

**What it owns:** `firewall:<hostname>` breadcrumb tags on FortiGate-discovered assets. Reconciler that rebuilds each in-scope asset's `firewall:*` tag set from `Asset.fortinetTopology.controllerFortigate` (managed switches / APs) plus `AssetFortigateSighting` rows within `quarantine.sightingMaxAgeDays` (DHCP-discovered endpoints). Inline lifecycle helpers for firewall create / rename / decommission. Tag-registry mirroring under category "FortiGate".

**Public API:** ReconcileSummary, reconcileFirewallTagsForIntegration, applyFirewallRename, applyFirewallDecommission, seedFirewallTagRegistry.

**Cross-service deps:** `src/services/assetSightingService.ts:getSightingSettings` (reads `sightingMaxAgeDays` for the endpoint freshness window), `prisma.tag` (registry mirror), `prisma.asset` (tag mutations), `prisma.assetFortigateSighting` (endpoint membership).

**Used by:**
- `src/api/routes/integrations.ts` Phase 2a — calls `applyFirewallDecommission(hostname)` per stale firewall after the status flip.
- `src/api/routes/integrations.ts` Phase 3 firewall create — calls `seedFirewallTagRegistry(fgHostname)` after the `prisma.asset.create` so the picker carries the tag from day one.
- `src/api/routes/integrations.ts` Phase 3 firewall update — calls `applyFirewallRename(old, new)` when projection writes a different hostname.
- `src/api/routes/integrations.ts` Phase 13.5 — calls `reconcileFirewallTagsForIntegration(integrationId)` after the Phase 13 map-region pass (`mode in {"full", "finalize"}`).

**Invariants:**
- The `firewall:` prefix is owned by THIS service. No other writer touches `firewall:*` tags.
- FortiGate firewall assets themselves are never tagged — don't tag a device with itself.
- Strip allowlist is always scoped to the current integration's known firewall hostnames. Tags pointing at FortiGates owned by another integration (or operator-typed `firewall:fake`) survive every reconcile pass.
- Endpoint membership comes from `AssetFortigateSighting` rows whose `integrationId` matches AND whose `lastSeen` is within `sightingMaxAgeDays` (0 = forever).
- Infra membership comes from `Asset.fortinetTopology.controllerFortigate` matching one of this integration's firewall hostnames; switches/APs whose controller field is empty get no firewall tag.
- Reconciler is idempotent: writes only when the tag array actually differs.
- Registry rows under category "FortiGate" stay in 1:1 correspondence with active firewall hostnames (create upserts; rename rotates; decommission removes; the reconciler also re-upserts as a safety net so rows don't go missing).

**When changing this:**
- If the tag prefix or category constants change, also update CLAUDE.md "Firewall tag reconcile (Phase 13.5)" section + the TOUCHES.md "Asset.tags" cross-cutting entry.
- Endpoint membership depends on the sightings table's `integrationId` index — if `AssetFortigateSighting`'s indexing changes, audit the `findMany` filter for performance regressions.
- Adding a fourth lifecycle path (e.g. operator-driven hostname rename via PUT /assets/:id on a firewall row) means hooking `applyFirewallRename` in that path too — the projection-driven Phase 3 hook only catches discovery-driven renames.
- The reconciler currently runs only at Phase 13.5 of FMG/FortiGate discovery. If discovery is ever skipped or disabled long-term, stale tags persist — operators should run a manual reconcile or delete the tag manually. (No periodic safety-net job exists by design — every input is discovery-written.)

---

## services/apiTokenService.ts

**What it owns:** Long-lived bearer-token CRUD for external API access; argon2id hash + tokenPrefix-based lookup; scope validation (assets:quarantine, assets:read); integrationIds enforcement for quarantine scope.

**Public API:** KNOWN_SCOPES, ApiTokenScope, ApiTokenSummary, AuthenticatedToken, CreateTokenInput, CreateTokenResult, createToken, listTokens, revokeToken, deleteToken, verifyToken.

**Cross-service deps:** none.

**Used by:**
- src/api/routes/apiTokens.ts — GET /api-tokens, list all tokens
- src/api/routes/apiTokens.ts — POST /api-tokens, create new token (show raw once)
- src/api/routes/apiTokens.ts — POST /api-tokens/:id/revoke, revoke by ID
- src/api/routes/apiTokens.ts — DELETE /api-tokens/:id, delete by ID
- src/api/middleware/auth.ts — attachApiToken middleware, verify bearer token on every request
- ...and N other call sites (quarantine/release endpoints use verifyToken indirectly via middleware)

**Invariants:**
- Wire format: `Authorization: Bearer polaris_<32-char-base64url-tail>` (prefix stored separately for fast candidate lookup via index).
- tokenHash is argon2id; never returned; rawToken shown ONCE at creation (POST response).
- assets:quarantine scope requires integrationIds (≥1 FortiManager/FortiGate id); assets:read scopes may have empty integrationIds.
- verifyToken() is best-effort on lastUsedAt/lastUsedIp updates; missed bumps don't fail auth.
- Expired tokens (expiresAt in past) and revoked tokens (revokedAt set) are silently excluded from lookup; no 401 distinction.

**When changing this:**
- Audit scope validation (validateIntegrationIds) if adding new integration types to quarantine support.
- Test wire format edge cases (malformed prefix, truncated token, null bearer header).
- Verify tokenPrefix index is used in verifyToken candidate fetch to keep lookup O(indexed).
- Check that expiresAt comparison handles null and timezone offsets correctly.
- Review quarantine endpoints (assets routes) to confirm they call attachApiToken middleware before verifyToken.

---

## services/assetIpHistoryService.ts

**What it owns:** Asset IP history reads, Settings-backed retention policy, pruning sweep, and the batch writer for *associated* interface IPs (`recordIpHistoryEntries`). The primary-IP rows are still written by the Prisma query extension in `src/db.ts` (`recordIpHistory`).

**Public API:** `getIpHistory(), recordIpHistoryEntries(), prepareIpHistoryEntries(), pruneOldHistory(), getHistorySettings(), updateHistorySettings()`

**Cross-service deps:** None. (`recordIpHistoryEntries` is called by `monitoringService.recordSystemInfoResult`.)

**Used by:** `src/api/routes/assets.ts — fetch IP history for asset detail modal`, `src/api/routes/assets.ts — prune endpoint (manual trigger)`, `src/services/monitoringService.ts — recordIpHistoryEntries() after the asset_associated_ips persist`

**Invariants:**
- History has two writers: (1) the `src/db.ts` Prisma extension on every Asset write that touches the primary `ipAddress`; (2) `recordIpHistoryEntries()`, called from the systemInfo scrape persist with the asset's interface IPs (incl. public WAN / secondary addresses). The batch writer **skips the asset's primary `ipAddress`** (already owned by writer 1) so the two never flip `source` back and forth and churn `firstSeen`.
- `recordIpHistoryEntries()` is best-effort (swallows DB errors) and fire-and-forget — it must never block or fail the scrape. Single multi-row `INSERT … ON CONFLICT` per call (one round-trip regardless of interface count — scale-safe at thousands of assets). `prepareIpHistoryEntries()` is the pure (testable) dedupe/skip-primary half.
- Retention is Setting-backed (`retentionDays`, default 0 = keep forever); `getIpHistory()` filters on read, stored rows never auto-delete unless `pruneOldHistory()` is called.
- `pruneOldHistory()` is a manual operation (not yet hooked to a background job); operator triggers via Server Settings → Maintenance → Prune old IP history.
- Setting persists across app restarts; read-time filtering is applied client-side by `getIpHistory()` calls.

**When changing this:**
- If adding background prune job (jobs/pruneIpHistory.ts), ensure it respects the Setting key "assetIpHistorySettings".
- Verify Prisma extension in `src/db.ts` still writes `AssetIpHistory` on Asset.ipAddress changes.
- Check assets.html History tab UI for retentionDays Setting control + prune button.
- Ensure Prisma schema AssetIpHistory._unique_ constraint on (assetId, ip) handles re-sight updates (lastSeen bump).

---

## services/assetQuarantineService.ts

**What it owns:** Push/pull FortiGate MAC quarantine via persistent `user.quarantine.targets` CMDB tree; orchestrates multi-FortiGate best-effort with per-device all-or-nothing atomicity.

**Public API:** `quarantineAsset(), releaseQuarantine(), verifyAssetQuarantine(), buildTransportForIntegration(), pushQuarantineToFortigate(), unpushQuarantineFromFortigate(), normalizeMac(), quarantineTargetName()`

**Cross-service deps:** `assetSightingService.ts` (for candidate targeting).

**Used by:** `src/api/routes/assets.ts,2115,2130,2168,2189 — quarantine/release/verify endpoints (4 routes)`, `src/api/routes/integrations.ts,3185 — auto-quarantine post-discovery on new FortiGate sighting`

**Invariants:**
- Infrastructure assets (firewall/switch/access_point) rejected at `quarantineAsset()` entry; release does NOT enforce type guard (operator can orphan old entries).
- Per-FortiGate is all-or-nothing (partial failures roll back); across-FortiGate is best-effort (failed targets recorded as `status: "failed"` in `quarantineTargets[]`).
- MAC reconcile is a single multiplexed call, not per-MAC loops: a new target is created with all MACs in one POST; an existing target is reconciled with one `PUT` of the full desired `macs` array (FortiOS CMDB replaces the child table → adds + removes atomically), guarded by a `needsReconcile` diff so a matching set is a no-op. Per FMG API Best Practices Guide (multiplex into one request). `callFortiOs` carries the PUT body on both transports, so FMG↔FortiGate parity holds. Read-back verification still follows the write.
- `statusBeforeQuarantine` preserved on quarantine → release restores it (null → "active" fallback).
- Standalone FortiGate + FMG (proxy/direct) both supported via `buildTransportForIntegration()` parity.
- `quarantineTargets` JSON tracks per-target status: `"synced"` (verified), `"drift"` (missing on later verify), `"failed"` (push error); only `"synced"` eligible for drift-flip on verify.
- Token-scoped quarantine (bearer token) filters sightings by integration before push; release refuses outright if quarantine touches out-of-scope integrations (no partial release).

**When changing this:**
- Audit `fortigateService.ts` + `fortimanagerService.ts` transport compatibility if FortiOS version bumps or endpoint changes.
- Check infrastructure-asset type list (firewall/switch/access_point) against the `BUILT_IN_ASSET_TYPES` constant in `src/utils/assetTypes.ts` + discovery source-kind tagging. (Custom operator-added AssetTypeDef rows DO NOT receive infrastructure special-casing — they fall through to "other"-like generic behavior.)
- Verify `getSightingSettings()` Settings key and max-age filter alignment with caller expectations.
- Review rollback/error-logging in event payload (event action names: asset.quarantine.succeeded/partial/failed/released/unpush.failed).

---

## services/assetSightingService.ts

**What it owns:** Records DHCP-only (asset, FortiGate) sightings to drive quarantine fan-out targeting.

**Public API:** `recordSightings(), getSightingsForAsset(), getQuarantineCandidates(), getSightingSettings(), updateSightingSettings()`

**Cross-service deps:** None.

**Used by:** `src/api/routes/integrations.ts — batch-record sightings after DHCP discovery sync`, `src/api/routes/assets.ts — fetch sighting list for Quarantine tab`, `src/services/assetQuarantineService.ts — fan-out targeting within quarantineAsset()`

**Invariants:**
- Sightings are deduped by `(assetId, fortigateDevice)` pair; `seenAt` determines entry precedence, `dhcp_reservation` trumps `dhcp_lease` on tie.
- `getQuarantineCandidates()` filters by `sightingMaxAgeDays` Setting (default 180; 0 = no filter); stored rows never auto-prune.
- Only DHCP evidence qualifies (transit via System tab interface scrape intentionally excluded per design).
- Every caller of `recordSightings()` must dedupe + normalize before passing; batch upsert handles dedup again for safety.

**When changing this:**
- Check `assetQuarantineService.ts` `quarantineAsset()` for sighting-filter logic (max-age, integration scoping).
- Verify `integrations.ts` `syncDhcpSubnets()` call site still matches expected SightingInput shape.
- Review Settings UI (assets.html) sighting age control and max-age tooltip.
- Ensure `pruneOldHistory` job (if added) respects Setting-backed retention separately from max-age filter.

---

## services/autoMonitorInterfacesService.ts

**What it owns:** Auto-monitor interface selection for FMG/FortiGate integrations. Multi-block union: `byNames`, `byPatterns` (wildcards or anchor-free regex per block flag), `byTypes`, `byLldp` (pin where a monitored neighbor of the chosen type is connected — direct LLDP advertisement OR peer-inferred edge from `Asset.fortinetTopology`). Each block independent; apply pass takes the union. Strictly additive — never strips operator-owned pins. The apply pass writes to TWO fields by interface provenance: real interfaces → `Asset.monitoredInterfaces` (IF-MIB), synthetic IPsec-tunnel rows → `Asset.monitoredIpsecTunnels` (the IPsec sampler's fast-poll list) — so a "By type: tunnel" selection actually fast-polls IPsec tunnels on REST-polled gates. `splitPinsByProvenance` does the partition.

**Public API:** `compileWildcard`, `compilePattern`, `resolvePinnedInterfaces`, `splitPinsByProvenance`, `mergeTunnelsIntoInterfaces`, `getInterfaceAggregate`, `computeAndCacheInterfaceAggregate`, `getCachedInterfaceAggregate`, `previewAutoMonitorForClass`, `applyAutoMonitorForClass`, `coerceLegacySelection`, `AutoMonitorSelection`, `AutoMonitorClass`, `ResolverInterface`, `PinsByProvenance`, `TunnelObservation`, `LldpNeighborMatch`, `LldpByIfName`, `LldpNeighborType`, `IfType`, `AggregateRow`, `CachedAggregateRow`, `InterfaceAggregateCacheEntry`, `InterfaceAggregateCache`, `PreviewResult`, `ApplyResult`, `LLDP_NEIGHBOR_TYPES`, `IF_TYPES`.

**Cross-service deps:** Reads `asset_interface_samples` (latest per (assetId, ifName) via DISTINCT ON) and `asset_lldp_neighbors` JOIN `assets` (matched-asset type + monitored flag) directly via `prisma.$queryRaw`. For the `fortigate` class ALSO reads `asset_ipsec_tunnel_samples` (latest per (assetId, tunnelName), same 72h DISTINCT ON, run in parallel) and merges each tunnel in as a synthetic `ifType:"tunnel"` `ResolverInterface` via the pure `mergeTunnelsIntoInterfaces` — covers FortiOS phase1-interface tunnels the REST monitor endpoint omits from `asset_interface_samples`. Gated on class because switches/APs have no IPsec. ALSO consults `Asset.fortinetTopology` JSON paths (class-aware raw SQL in `loadInferredLldpByAsset`) to synthesize peer-inferred neighbor matches that the persisted LLDP table can't see — same data source `peerInferredLldpService` uses for the System tab Neighbor column. Inferred matches merge into the real LLDP map via `mergeLldpMaps` before the pure resolver runs; the resolver itself is unchanged and can't tell them apart. For the `fortiap` class, a post-load step (`normalizeFortiapInferredLldp` → `src/utils/fortiapInterfaceAlias.ts:normalizeFortiapInterfaceName`) rewrites synthesized `localIfName` from FortiAP-CLI naming (`lan1`) to SNMP-canonical (`eth0`) when the AP's interface table exposes the eth* form — without this, the resolver would pin a name that doesn't match any ifIndex on the fast-cadence scrape.

**Used by:** `src/api/routes/integrations.ts` — `interface-aggregate` / preview / apply endpoints AND `syncDhcpSubnets` Phase 2c on discovery completion AND the AD/Entra post-sync `applyWorkstationServerAutoMonitor` pass. `src/jobs/migrateAutoMonitorInterfacesShape.ts` — calls `coerceLegacySelection` to rewrite stored configs at boot.

**Aggregate cache (`Integration.interfaceAggregateCache`):** `runDiscovery`'s success branch calls `computeAndCacheInterfaceAggregate(id, type)` as a best-effort final step — runs `getInterfaceAggregate` for every interface class the integration type carries (Fortinet → fortigate/fortiswitch/fortiap; AD/Entra/Windows-Server → workstation/server) and persists the UI-rendered fields + `computedAt` to the Integration row. The `GET .../interface-aggregate` route now reads this via `getCachedInterfaceAggregate` and only live-computes when the class entry is missing (pre-first-run). **Writer:** discovery success path. **Reader:** the GET route. **Invariant:** the cache holds only `ifName`/`ifType`/`deviceCount` (no `devices[]`); if a future UI needs the device list it must hit a live path, not the cache. The operator "Refresh from latest discovery" button was removed — the only refresh trigger is a discovery run.

**Live consumers `previewAutoMonitorForClass` / `applyAutoMonitorForClass` still scan `loadLatestInterfaces` (fleet-wide, multi-second-to-minutes at scale).** Two mitigations so this no longer blocks the modal: (1) the `POST .../interface-aggregate/apply` route is **fire-and-forget** — kicks the apply in the background and returns `202`; Phase 2c re-runs it every discovery so a dropped run self-heals. (2) the frontend preview no longer calls `previewAutoMonitorForClass` for `byNames`/`byPatterns`/`byTypes` — it computes from the already-loaded cache rows client-side (`computeClientPreview` in `public/js/integrations.js`, mirroring `compileWildcard`/`compilePattern` via `_amonWildcardToRegex`/`_amonRegexFromString`); only `byLldp` (topology, uncached) still hits the live preview endpoint. **Gotcha:** the client preview can't honor `onlyUp` (no per-device `operStatus` in the cache) so `byPatterns`/`byTypes` counts are upper bounds — keep `computeClientPreview`'s `approx` flag + the server resolver in sync if `onlyUp` semantics change.

**Class-agnostic resolver:** `AutoMonitorClass` + `CLASS_TO_ASSET_TYPE` now include `workstation` / `server` (AD/Entra), not just the three Fortinet classes — the resolver/aggregate/preview/apply all filter purely on `(discoveredByIntegrationId, assetType)`, so reuse for AD/Entra needed only the type/map widening. The interface-aggregate route's `ClassQuerySchema` was widened to match; `classToBlockKey()` maps `workstation`/`server` → `workstationMonitor`/`serverMonitor`. The IPsec-tunnel + LLDP loaders only fire for `fortigate`/byLldp selections, so ws/server selections skip them.

**Invariants:**
- **Additive-only contract:** `applyAutoMonitorForClass()` union-merges resolved pins with existing `Asset.monitoredInterfaces` AND `Asset.monitoredIpsecTunnels` (split by provenance); never deletes pins from either field. Operator hand-pins persist across discovery cycles even if no block would re-select them.
- **Provenance routing:** `splitPinsByProvenance(picked, interfaces)` partitions a resolved pin set: a name whose source row carries `isIpsecTunnel` (set by `mergeTunnelsIntoInterfaces` — on both freshly-appended synthetic rows AND any real interface row a tunnel name collided with) → `monitoredIpsecTunnels`; everything else → `monitoredInterfaces`. Per asset a name is unambiguous (the merge collapses a tunnel/real-row collision into one row), so the same ifName is never in both buckets on one device. A real IF-MIB row for a non-tunnel interface has no `isIpsecTunnel` flag and stays in `monitoredInterfaces`. Pure; unit-tested.
- **Multi-block union:** `resolvePinnedInterfaces()` evaluates each present block and Sets the union of all matches; no block is gated on another. A `null` selection or one with all four keys missing produces zero pins.
- **By LLDP requires both flags:** the matched neighbor's asset must be both `monitored=true` AND have `assetType` in the chosen set. Unmatched neighbors (matchedAssetId is null) cannot satisfy By LLDP.
- **By LLDP context:** if `selection.byLldp` is set but the caller didn't pass `lldpByIfName`, the block silently contributes nothing — does not throw. (Callers that intend to evaluate LLDP must load it; `applyAutoMonitorForClass` / `previewAutoMonitorForClass` do this conditionally via `selectionUsesLldp`.)
- **Peer-inferred matches behave identically to real LLDP** at the resolver level — `loadInferredLldpByAsset` produces `LldpNeighborMatch` entries in the same `LldpByIfName` shape, `mergeLldpMaps` appends them to the real-LLDP map per (assetId, ifName), and `resolvePinnedInterfaces` consumes the merged map without knowing which source provided which entry. The "monitored neighbor of selected type" rule is the only thing that matters.
- **Pattern compiler split:** wildcards (`regex=false`) are anchored by `compileWildcard`; regex (`regex=true`) compiles with no implicit anchors — operators use `^`/`$` if they want full-string match.
- **IPsec tunnel augmentation (fortigate only):** `loadLatestInterfaces(ids, includeIpsecTunnels)` is called with `includeIpsecTunnels = klass === "fortigate"` by all three callers (`getInterfaceAggregate` / `previewAutoMonitorForClass` / `applyAutoMonitorForClass`). When set, `mergeTunnelsIntoInterfaces` adds one `{ ifName: tunnelName, ifType: "tunnel", operStatus, isIpsecTunnel: true }` row per tunnel. **The IPsec SA status is authoritative on a name collision:** if the tunnel name already exists as a real interface row (e.g. an SNMP-polled gate whose IF-MIB enumerates the tunnel as ifType 131 and reports its `ifOperStatus` as **always "up"** regardless of SA state), the merge OVERRIDES that row's `operStatus` with the SA-derived value and tags it `isIpsecTunnel` rather than skipping the synthetic — otherwise `onlyUp` would pin a tunnel whose SA is down. Status→operStatus maps only fully-`down` → `"down"` (up/partial/dynamic/null → `"up"`) so the `onlyUp` filter keeps healthy-but-not-fully-up tunnels. Effect: the synthetic rows flow into both the aggregate pickers AND the resolver feed, so a tunnel selected By name/By type actually pins — and `splitPinsByProvenance` routes those pins to `Asset.monitoredIpsecTunnels` (read by the dedicated IPsec sampler → `asset_ipsec_tunnel_samples`, which carries SA-status + throughput), NOT `Asset.monitoredInterfaces`. This is what makes "By type: tunnel" fast-poll IPsec tunnels on REST-polled gates, where an IF-MIB pin in `monitoredInterfaces` would yield nothing. The helper is pure — mutate-in-place + return — and unit-tested in `tests/unit/autoMonitorInterfacesService.test.ts`.
- **`byTypes.includeDownTunnels`:** tunnel-only exception to `onlyUp` in `resolvePinnedInterfaces` — when `onlyUp` would drop a non-up interface, it's still kept iff `includeDownTunnels === true` AND `ifType === "tunnel"`. No effect on other types; moot when `onlyUp` is false. Touch-points: `ByTypesBlock` type + resolver (`autoMonitorInterfacesService.ts`); `ByTypesSchema` is `.strict()`, so the field MUST be in the Zod schema in `integrations.ts` or PUTs 400. Frontend (`public/js/integrations.js`): rendered by `_amonTypeRowHTML` inline next to the tunnel row, wired by `wireInclDown`, state tracked in the `inclDownState` closure (survives `renderTypesList` rebuilds), read in `_readAutoMonitorInterfaces` (only when `tunnel` is selected), and folded into `_amonCanonicalize` so toggling it registers as a change that re-fires the apply pass.
- **Latest interface resolution:** `loadLatestInterfaces()` uses `DISTINCT ON (assetId, ifName)` ORDER BY timestamp DESC over a **72h window**. No separate inventory table. The time bound is load-bearing — without it the DISTINCT ON walks the entire active hypertable chunk per (assetId, ifName) pair (same disaster pattern interfaceTopologyService had to fix at 13.5 min / 90M rows / 9 GB I/O on prod). 72h tolerates the long end of the pollInterval-linked systemInfo cadence (up to 24h) plus missed scrapes. Operator-visible effect: assets that haven't reported in >72h drop from the "By name" aggregate checklist, which is the right behavior for a "currently-existing interfaces" picker.
- **Legacy shape coercion:** `coerceLegacySelection` rewrites the older `{mode: "names"|"wildcard"|"type", ...}` discriminated union to the new shape. Called by the Zod preprocess in the PUT schema, the apply route, the Phase 2c apply pass, the migration job, AND the frontend renderer (`_amonCoerceLegacy` in `public/js/integrations.js`). New-shape values pass through unchanged on every layer so re-running is safe.

## services/autoMonitorStorageService.ts

**What it owns:** Auto-monitor storage-mount selection for AD/Entra workstation/server classes (the storage analog of autoMonitorInterfacesService — net-new, no FMG/FortiGate equivalent). Multi-block union: `byNames` (exact mountPaths), `byPatterns` (wildcards or regex), `all` (every observed mount). Strictly additive to `Asset.monitoredStorage` — never strips operator pins.

**Public API:** `resolvePinnedStorage`, `getStorageAggregate`, `computeAndCacheStorageAggregate`, `getCachedStorageAggregate`, `previewAutoMonitorStorageForClass`, `applyAutoMonitorStorageForClass`, `AutoMonitorStorageSelection`, `StorageClass`, `ResolverMount`, `StorageAggregateRow`, `CachedStorageRow`, `StorageAggregateCacheEntry`, `StorageAggregateCache`, `StoragePreviewResult`, `StorageApplyResult`.

**Cross-service deps:** Reads `asset_storage_samples` (latest per `(assetId, mountPath)` via 72h-bounded `DISTINCT ON` — same time-bound rationale + the `(assetId, mountPath, timestamp)` index as the interfaces loader). Imports `compilePattern` from `autoMonitorInterfacesService.ts` (no duplication). No LLDP, no tunnel merge, no legacy coercion.

**Used by:** `src/api/routes/integrations.ts` — `storage-aggregate` / preview / apply endpoints (AD/Entra-only `workstation|server` class enum) AND the AD/Entra post-sync `applyWorkstationServerAutoMonitor` pass.

**Aggregate cache (`Integration.storageAggregateCache`):** mirror of the interface-service cache — `runDiscovery`'s success branch calls `computeAndCacheStorageAggregate(id, type)` (no-op for Fortinet types, which carry no storage classes), and `GET .../storage-aggregate` reads it via `getCachedStorageAggregate` with a live-compute fallback before the first post-feature run. Cache holds only `mountPath`/`deviceCount` + `computedAt`. The "Refresh from latest discovery" button was removed. `POST .../storage-aggregate/apply` is fire-and-forget (`202`) like the interface apply; the storage preview keeps the live `storageAggregatePreview` round-trip (no client-side compute yet) but now shows a "Computing matches…" placeholder so a slow resolve doesn't read as a blank/broken box.

**Invariants:**
- **Additive-only contract:** `applyAutoMonitorStorageForClass()` union-merges into `Asset.monitoredStorage`; chunked `Promise.allSettled` (batch 50), skips no-op writes, idempotent across re-runs.
- **AD/Entra-only:** storage auto-monitor is NOT exposed on the Fortinet classes. The class enum is `workstation`/`server`; the config lives in `workstationMonitor.autoMonitorStorage` / `serverMonitor.autoMonitorStorage` (Zod `AutoMonitorStorageSchema` in `integrations.ts`, `.strict()`). Frontend card `_autoMonitorStorageHTML` / reader `_readAutoMonitorStorage` / wire `_wireAutoMonitorStorageCard` in `public/js/integrations.js`.
- **Samples come from the Polaris Agent:** these devices have no mounts until an agent reports, so the "By name" picker is empty pre-deploy and the apply pass no-ops until samples exist (self-healing next cycle).
- **`all` block is storage-only** — interfaces deliberately omits it (firewall interface counts are huge); mount counts per device are small so "pin every disk" is safe.

**When changing this:**
- If adding a resolver block, ensure `resolvePinnedInterfaces()` remains pure (no DB, no I/O) and the new key is added to `coerceLegacySelection`'s "already new shape" guard so legacy bodies still pass through.
- Test wildcard escaping: special chars like `[`, `]`, `^`, `$`, `.` must not become regex syntax in wildcard mode.
- Verify the LLDP query stays bounded: at 2000 monitored switches with full neighbor tables, the JOIN is indexed on both sides (`asset_lldp_neighbors.assetId` + `assets.id`) but the per-asset row count can spike on shared media — keep the projection narrow (assetType + monitored only).
- `applyAutoMonitorForClass` computes all pending updates in memory first, then fires `prisma.asset.update` in chunks of 50 via `Promise.allSettled` (idempotent because the apply is strictly additive, so a half-landed batch re-converges on re-run). Keep that two-phase shape if you touch it — the prior per-row sequential `await` wedged the modal's "Applying…" state for minutes on a few-hundred-switch fleet.
- If adding a new synthetic interface source to `loadLatestInterfaces` (like the IPsec tunnel merge), keep the extra read in the `Promise.all` and class-gate it so non-applicable classes don't pay for an empty query at 2000-asset scale.

---

## services/azureAuthService.ts

**What it owns:** Azure AD (Entra) SAML 2.0 SSO configuration, relay-state generation, SAML response validation, user provisioning on first login.

**Public API:** getSsoSettings, updateSsoSettings, isAzureSsoConfigured, isAzureSsoConfiguredAsync, generateRelayState, getSamlLoginUrl, validateSamlResponse, getSamlLogoutUrl, findOrProvisionSamlUser, SsoSettings.

**Cross-service deps:** None (SAML + database; no service-to-service calls).

**Used by:** src/app.ts — check SSO configured on startup to conditionally skip login page, src/api/routes/auth.ts — SAML login/logout flow (generateRelayState, getSamlLoginUrl, validateSamlResponse, getSamlLogoutUrl, findOrProvisionSamlUser).

**Invariants:**
- SSO settings stored in Setting table (key="sso"); 30-second in-memory cache with expiry.
- SAML IdP config (Entity ID, Login/Logout URLs, certificate) configured via Users page Settings modal.
- Relay state generated as random 32-byte base64url for CSRF protection on redirect.
- SAML response validation uses @node-saml/node-saml library; wantResponseSigned flag controls signature check.
- User provisioning on first login: extract nameID/email from validated Profile, upsert User row with default role, auto-enable if disabled.
- skipLoginPage flag bounces unauthenticated visitors straight to SSO (bypass Polaris login page). app.ts honors SAML first, then OIDC. Turning it ON is lockout-gated in PUT /auth/azure/settings: requires (a) a SAML or OIDC provider configured AND (b) the enabling admin's session authProvider is "azure"/"oidc" (SSO round-trip proven). Turning it OFF is unrestricted (recovery). users.js mirrors the gate by disabling the checkbox for local/LDAP sessions when it's currently off.
- autoLogoutMinutes triggers silent logout after inactivity (0 = disabled).

**When changing this:**
- Test SSO cache expiry (30s) on getSsoSettings; verify updateSsoSettings invalidates _samlClient.
- Check SAML validation still rejects unsigned responses when wantResponseSigned=true.
- Confirm user provisioning correctly maps SAML Profile fields (nameID, email, groups) to User rows.
- Validate skipLoginPage redirect flow doesn't expose relay state leaks; confirm OIDC fallback fires when only OIDC is configured and the lockout guard rejects a local/LDAP admin enabling it.
- Test logout URL generation with correct nameID/sessionIndex from validated response.

---

## services/blockService.ts

**What it owns:** IP block CRUD and metadata (name, tags, description).

**Public API:** listBlocks, getBlock, createBlock, updateBlock, deleteBlock.

**Used by:** src/api/routes/blocks.ts (all CRUD operations), src/services/subnetService.ts (block parent lookups, overlap validation).

**Invariants:**
- Block deletion forbidden if any active reservations exist across child subnets
- CIDR must be normalized and unique
- IP version immutable after creation (v4 vs v6)
- Tags are optional arrays, filtered client-side in listBlocks

**When changing this:**
- Verify deleteBlock's active-reservation cascade check (affects data integrity)
- Test CIDR normalization in createBlock (e.g., 10.1.1.5/24 → 10.1.1.0/24)
- Check block-listing performance if tag filtering is optimized

---

## services/capacityService.ts

**What it owns:** Capacity snapshot (host/DB/workload), severity grading (`ok` / `watch` / `warning` / `critical` — renamed from the legacy `red`/`amber` color vocabulary), reason codes + families for severity-collapse, Event emission on severity transition, and steady-state DB size projection. Also orchestrates the two-pass `getCapacitySnapshotWithAdvisor` helper that interleaves Capacity Advisor recompute with reason-building.

**Public API:** `getCapacitySnapshot`, `getCapacitySnapshotWithAdvisor`, `recordCapacityTransition`, `collapseReasonsByFamily`, `normalizeSeverity`. Disk-I/O rate math lives in the sibling `capacityDbIo.ts` (`deriveDbIoVerdict` + `DB_IO_WATCH_BACKENDS`/`DB_IO_WARNING_BACKENDS` thresholds) — split out so it's testable without this module's import graph.

**Cross-service deps:** `monitoringService` (cadences, retention), `timescaleService` (hypertable check), `queueService` (pg-boss installed, boot/persisted mode), `deploymentContext` (DB co-location), `capacityDbIo` (pure disk-I/O rate math), `capacityAdvisorService` (dynamic import in `getCapacitySnapshotWithAdvisor`; type-only the other direction to avoid runtime cycle).

**Used by:** `src/jobs/capacityWatch.ts — 10-min capacity check + Event emission`; `src/api/routes/serverSettings.ts — /pg-tuning, /capacity-advisor, /capacity-advisor/stage endpoints`. ~6 call sites.

**Invariants:**
- Severity tiers: **critical** = disk <10%, DB >50% of free disk, stale autovacuum >7d on sample table (Timescale hypertables exempt — append-only chunks legitimately don't autovacuum), projected >8× RAM; **warning** = disk 10–20%, projected >4× RAM, dead-tup >20%, pgTuningNeeded, max_connections_undersized (advisor-driven), db_io_pressure (avgBackendsBlockedOnDisk ≥ 2.0); **watch** = disk 20–30%, db_io_pressure (avgBackendsBlockedOnDisk ≥ 0.5 — measured disk-read wait from pg_stat_database.blk_read_time, guarded on DB > host RAM; replaced the old size-based ram_insufficient heuristic), track_io_timing_off (DB > RAM but track_io_timing off so wait can't be measured — own family `pg_io_timing`), db_pool_undersized (>=80% of pool capacity), monitor_workers_undersized (advisor-driven rollup), monitor_handler_timeout_pressure (advisor-driven; p90 ≥ 70% of `pgboss.queue.expire_seconds` on any monitor cadence), timescale_recommended (sample tables >1 GB, extension not installed), metrics_token_unset, health_token_unset; **ok** = none.
- Severity vocabulary was renamed from `red`/`amber` (color names) to `critical`/`warning` (severity descriptors) to match the user-facing pill labels. `normalizeSeverity()` accepts either vocabulary on read so back-compat with persisted `Setting.capacity.lastSeverity` rows + cached browser snapshots stays clean during rollout. Frontend pill labels and CSS class names still use the color vocab (`capacity-pill-red`, etc.) — they're tied to the actual color, not the severity name; `_capacitySeverityCssClass(s)` maps severity → CSS suffix in `public/js/server-settings.js`.
- **Family-based severity collapse**: each reason carries an optional `family: string` tag. `collapseReasonsByFamily()` groups by family, keeps only the highest-severity entry per family, and concatenates suppressed reasons' `suggestion` text onto the winner (deduped by exact trimmed equality, prefixed `Also:`). Reasons without a family pass through unchanged — they're standalone concerns with no overlapping siblings. Families currently in use: `disk:db`, `disk:<role-set>`, `db_ram`, `pg_io_timing`, `autovacuum`, `timescale`, `db_pool`, `monitor_workers`, `monitor_handlers`, `db_max_connections`, `pg_tuning`, `metrics_token`, `health_token`. Different volumes (DB / app / state / backups) get their own family — they're independently actionable.
- The collapse pass is what makes the Maintenance card legible: the Critical "projected database growth exceeds free space" used to render alongside a redundant Watch "27% free" about the same volume; now the Watch is suppressed and its suggestion ("Watch the trend; expand before it crosses 20%") gets appended to the Critical's suggestion as "Also:". Same for `db_ram` family — the Warning "exceeds 4× host RAM" (projected growth) absorbs the lower-severity `db_io_pressure` watch about the same DB-vs-RAM concern. (`track_io_timing_off` is deliberately in its own `pg_io_timing` family so the "enable measurement" hint is never collapsed away by a growth warning.)
- Legacy `pgboss_recommended` / `pgboss_overdue` / `pgboss_pending` reasons were absorbed into the Capacity Advisor's QUEUE_MODE lever and no longer fire. The advisor's per-lever recommendations are the source of truth for queue-mode advice.
- Advisor-driven reasons (`monitor_workers_undersized`, `max_connections_undersized`, `monitor_handler_timeout_pressure`) only fire when callers pass `advisor` gap data into `computeReasons`. `getCapacitySnapshot` with `advisor: undefined` skips them; `getCapacitySnapshotWithAdvisor` builds the gaps and re-runs the snapshot in pass 2. `monitor_handler_timeout_pressure` carries per-cadence pressure entries lifted from `AdvisorState.handlerTimeoutPressure`, which the advisor populates by reading live `pgboss.queue.expire_seconds` values and comparing to observed histogram p90.
- Reason codes are unique per condition — `projected_exceeds_disk` (critical) and `projected_approaches_disk` (warning, >75%) compare *additional growth needed* (`max(0, steadyState - currentDbSize)`) against free disk on the DB volume, not the steady-state total — the bytes already on disk are part of the steady-state total but aren't future growth, so double-counting them was firing critical prematurely. Codes are deliberately distinct so transition Events stay distinguishable.
- **Message wording convention**: `<Subject> <state> (<metric context>). <Action>.` — subject is a noun phrase, state is an active-voice verb, parenthetical carries concrete metrics (numbers + units), action is an imperative one-sentence remediation. The collapse pass relies on the action being self-contained so concatenated "Also:" lines read naturally. Don't break the pattern when adding new reasons.
- Volumes deduped by `stat.dev` so single-LV box = one entry, STIG RHEL with separate /var = two.
- Steady-state projection = base DB size – current sample table bytes + projected sample bytes (per monitored asset × rows/day/asset × retention × bytes/row).
- Sample table rows-per-asset-per-day: conservative defaults (e.g., asset_monitor_samples = 86400/intervalSeconds) when no samples yet.
- Connection-pool peak tracking: rolling high-water across all snapshots (resets on process restart); captured before snapshot read so it reflects current state.
- Transition logic: compare new severity to stored severity; emit Event only on change; Severity → Event level: critical→error, warning/watch→warning, ok→info.
- recordCapacityTransition() is best-effort (errors logged at debug, never thrown).

**When changing this:**
- Test volume dedup on multi-LV layouts (separate /var/lib/pgsql and /app).
- Verify steady-state projection doesn't underestimate (conservative DEFAULT_ROWS_PER_ASSET_PER_DAY is key).
- Check connection-pool peak doesn't reset unexpectedly (module-local state should survive across route calls).
- Confirm Event emission only fires once per severity change (no duplicate "critical" events on each tick).
- Test fallback PG data directory candidates on RHEL/Windows when `SHOW data_directory` fails (non-superuser app role).
- When adding a new reason, ALWAYS pick a `family` if it overlaps with any existing reason about the same concern — otherwise both reasons render side-by-side and re-introduce the noise the collapse pass was built to fix. Reasons that are genuinely orthogonal (no overlap) leave `family` undefined.
- Stick to the `<Subject> <state> (<metric>). <Action>.` wording pattern when adding reasons; the collapse pass concatenates suggestions across family members and the result reads poorly if one reason's suggestion ends mid-sentence or carries the metric inside the action.

---

## services/connectionPathService.ts

**What it owns:** `resolveConnectionPath(assetId)` — endpoint → switch → … → FortiGate connection-path resolver. Walks the upward dependency chain so the Device Map topology overlay can dim everything off-path.

**Public API:** `resolveConnectionPath`, plus the `ConnectionPath` / `ConnectionPathHop` / `ConnectionHopKind` types.

**Cross-service deps:** Reads `Asset` rows directly + `AssetDependencyParent` (the same source-of-truth `dependencyTreeService` writes). Falls back to `Asset.fortinetTopology` when the dependency tree is empty.

**Used by:** `src/api/routes/assets.ts — GET /api/v1/assets/:id/connection-path`. Total 1 call site today.

**Invariants:**
- Firewall start short-circuits: `hops = [self]`, `siteId = self.id`, `alternateUplinks = 0`.
- Switch / AP start: walk begins at self.
- Endpoint start (workstation / server / printer / other): parse `Asset.lastSeenSwitch = "<switchId>/<port>"`; resolve the switch by hostname OR serialNumber under `assetType="switch"`.
- Upward walk reads `AssetDependencyParent` rows; `source="override"` set takes precedence over `source="computed"` per the existing dependency convention. Empty override set is NOT modeled here — the resolver just sees zero parents and falls through to fortinetTopology.
- MCLAG / dual-homed parents pick the one with `monitorStatus="up"` AND most-recent `lastMonitorAt`; remaining parent count is summed across hops into `alternateUplinks`.
- Fallback to `fortinetTopology.controllerFortigate` (switch → firewall) and `.parentSwitch` (AP → switch) only when `AssetDependencyParent` returns zero rows for the cursor — covers fresh installs before `backfillDependencyTree` runs and freshly-discovered switches awaiting recompute.
- Cycle / pathological-data guard: walk cap of 16 hops + a `seen` set so a self-referential override row can't infinite-loop the resolver.
- `endpointPort` lives only on the first switch hop after an endpoint (parsed from `lastSeenSwitch`); `uplinkInterface` lives on every switch / AP hop (from `fortinetTopology.uplinkInterface`).

**When changing this:**
- If MCLAG parent-preference rules change, update both the sort and the `alternateUplinks` accumulation in lock-step.
- If `lastSeenSwitch` format ever shifts beyond `"<switchId>/<port>"`, update `parseLastSeenSwitch`. Discovery writes both `hostname` and `serialNumber` forms today; both are matched by `findSwitchByName`.
- Keep the fortinetTopology fallback rules aligned with how FMG / FortiGate discovery stamps these fields — see fortimanagerService.ts FortiSwitch / FortiAP write paths.
- Don't include `dependencyLayer` in hops — the resolver runs even when the layer is null (e.g. fresh switches between recomputes), and the consumer doesn't need it.
- AssetDependencyParent does NOT contain endpoint rows by design (the dependency tree is infra-scoped); changing that would require coordinating with `dependencyTreeService.recomputeDependencyTree`.

---

## services/credentialService.ts

**What it owns:** Named-credential store for monitoring probes (SNMP v2c/v3, WinRM, SSH, REST API); type-specific config validation; secret masking on GET; merge-and-preserve logic for PUT to retain secrets when client resubmits mask.

**Public API:** CredentialType, SnmpV2cConfig, SnmpV3Config, SnmpConfig, WinRmConfig, SshConfig, RestApiConfig, CredentialConfig, CredentialRecord, SaveCredentialInput, UpdateCredentialInput, stripSecrets, validateConfig, mergeConfigPreservingSecrets, listCredentials, getCredential, createCredential, updateCredential, deleteCredential.

**Cross-service deps:** none.

**Used by:**
- src/api/routes/credentials.ts — GET /credentials, list (secrets masked)
- src/api/routes/credentials.ts — GET /credentials/:id, fetch one
- src/api/routes/credentials.ts — POST /credentials, create
- src/api/routes/credentials.ts — PUT /credentials/:id, update (merge w/ secret preservation)
- src/api/routes/credentials.ts — DELETE /credentials/:id, revoke (fails 409 if asset references it)
- src/api/routes/assets.ts — GET /assets/:id/resolve-monitor-setting, fetch credential for asset monitoring setup

**Invariants:**
- Secret fields (community, authKey, privKey, password, privateKey, apiToken) are masked to "••••••••" on every GET; empty string and mask are treated as "preserve from stored value" on PUT.
- SNMP v2c requires community; v3 requires username + security level + auth/priv keys per level.
- SSH requires username + (password OR privateKey); WinRM requires both username + password.
- REST API requires baseUrl (http/https only, no trailing slash stored) + apiToken; verifyTls defaults false.
- Delete fails with 409 if any asset.monitorCredentialId points to it; check all six Asset credential type columns (monitorCredentialId, responseTimeCredentialId, cpuMemoryCredentialId, temperatureCredentialId, interfacesCredentialId, lldpCredentialId). MonitorClassOverride also has five per-stream credential FK columns (responseTimeCredentialId / cpuMemoryCredentialId / temperatureCredentialId / interfacesCredentialId / lldpCredentialId) with ON DELETE SET NULL — Postgres nulls those automatically, no application 409 needed.
- validateConfig is called on CREATE and on PUT (after merge), catching type/field mismatches early.

**When changing this:**
- Test secret masking round-trip (GET → masked, PUT w/ mask → original preserved).
- Add new credential types: extend CredentialType union, add SECRET_FIELDS_BY_TYPE entry, add validateXxxConfig branch.
- Test all SNMP v3 security-level combos (noAuthNoPriv, authNoPriv, authPriv); validate protocol enums.
- Ensure delete check covers all five asset credential columns; update the test suite when columns change.
- Verify REST API baseUrl normalization (trim, remove trailing slash, require http/https scheme).

---

## services/deviceIconService.ts

**What it owns:** Operator-uploaded device icons (PNG/JPEG/WebP/SVG; 256KB cap raster, 32KB cap SVG; magic-byte check for raster, pattern-reject validation for SVG); bytes-in-DB storage. Every icon is keyed to (manufacturer, type-or-model); resolution priority is `manufacturer-model: <mfr>/<model>` → `manufacturer-type: <mfr>/<assetType>`. Manufacturer values canonicalized through `manufacturerAlias` map at both upload and resolution time.

**Public API:** `uploadIcon(), listIcons(), getIconImage(), deleteIcon(), resolveIconForAsset(), loadIconResolutionCache(), resolveIconUrl(), validateUpload()`

**Cross-service deps:** `utils/manufacturerNormalize.normalizeManufacturer()` for alias-canonicalization of manufacturer values (both the standalone manufacturer scope and the manufacturer half of model:<mfr>/<model> keys).

**Used by:** `src/api/routes/deviceIcons.ts,56,83,105 — upload/list/delete CRUD + image serve`, `src/api/routes/map.ts,267,369,588,710,787 — icon resolution for topology switches/APs/firewalls (icon cache preloaded once per request)`

**Invariants:**
- Scope: "manufacturer-type" (asset type key, enum: server/switch/router/firewall/workstation/printer/access_point/other) or "manufacturer-model" (vendor-specific chassis/model). Both require a manufacturer; standalone type/model/manufacturer uploads are not supported.
- Canonical key form: `"<canonicalManufacturer>/<typeOrModel>"`. Manufacturer half always runs through normalizeManufacturer (alias map). Type tail lowercased; model tail preserved as typed.
- Upload validation: mimeType must be PNG/JPEG/WebP/SVG; raster size ≤256KB, SVG size ≤32KB; raster requires magic-byte prefix matching declared mimeType; SVG is reject-on-pattern (refused if it contains <script>, <foreignObject>, <iframe>, <object>, <embed>, <!DOCTYPE>, <!ENTITY>, <?xml-stylesheet>, on*= event handlers, javascript: URLs, any non-#fragment href/xlink:href/src, @import, or external url()).
- SVG uploads that pass validation are **rasterized to a 512×512 PNG via `@resvg/resvg-js` (`rasterizeSvgToPng`)** before storage, and the row is written with mimeType `image/png` + a `.png` filename suffix. Background: Cytoscape's `background-image` pipeline loads SVGs via `new Image()` and design-tool exports (Adobe Illustrator etc.) typically omit `width`/`height` and declare only `viewBox`, so the browser falls back to a tiny default natural size and the topology icon visually anchors upper-left at a fixed pixel size at every zoom. Server-side rasterization gives the renderer a bitmap with intrinsic dimensions and side-steps the whole class of bug. The one-shot `rasterizeStoredSvgIcons` startup job migrates pre-existing `image/svg+xml` rows the same way; idempotent via the mimeType filter.
- Resolution is most-specific-wins: manufacturer-model → manufacturer-type → null (frontend leaves node as a plain status circle). Assets with no manufacturer resolve to null directly — no fallback to "any vendor".
- `resolveIconUrl()` is synchronous (used in hot topology path); operates against pre-loaded cache from `loadIconResolutionCache()`. Both call sites share `buildResolutionCandidates()` so the priority order can't drift between sync and async paths.
- Topology renderer overlays the icon at ~70% of the visual diameter centered. The recipe is `background-fit: contain` with NO `background-width`/`background-height` override (so Cytoscape scales the image to fill the model-space node bounds, maintaining aspect ratio AND scaling with zoom), and a per-role thick `border-width` so the colored ring eats the outer ~15% of the visual diameter on each side. Both percentage and pixel `background-width` were tried in earlier attempts and both have Cytoscape 3.30 quirks: percentage causes zoom-dependent overflow; pixel is treated as render pixels (icon stops scaling with zoom) and breaks centering. Letting contain do the work alone is the predictable recipe. See `public/js/topology-render.js` `node[hasIcon=1]` style + the per-role border-width selectors directly below it.
- Bytes stored as Uint8Array in DeviceIcon.data column; `/api/v1/device-icons/:id/image` serves raw bytes with Content-Type + Cache-Control. (Defense-in-depth: any `image/svg+xml` row — only legacy rows predating the rasterize-on-upload change, since new SVG uploads are stored as PNG — is served with X-Content-Type-Options: nosniff + a strict CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox`.)

**When changing this:**
- Check magic-byte prefixes (PNG/JPEG/WebP) if adding new raster formats; ensure length matches actual file signatures.
- SVG_REJECT_PATTERNS is the security boundary — adding a new tag/attribute reject pattern is fine, but loosening one needs careful review (every entry maps to a known XSS / XXE / SSRF vector).
- Sync VALID_TYPE_KEYS set against `BUILT_IN_ASSET_TYPES` in `src/utils/assetTypes.ts` if new built-ins are added. Custom operator-added AssetTypeDef rows don't automatically get icon-resolution coverage — device icons keyed by manufacturer-type only resolve for built-in type names.
- Verify Prisma DeviceIcon schema: unique constraint on (scope, key), Bytes column type for data. Scope is a String column — no DB migration needed when adding new scope values.
- Review map.ts topology rendering (resolveIconUrl call sites) if icon resolution priority changes — but priority is built once in `buildResolutionCandidates()`, so updates land in both sync and async paths together.
- Ensure upload route multer fileSize limit (256KB) stays at or above the raster MAX_ICON_BYTES constant. SVG's tighter MAX_SVG_BYTES is enforced inside validateUpload after multer accepts.
- Image-serve route: any new mimeType added to ALLOWED_MIME_TYPES that could execute (script-bearing text formats) needs the same CSP/nosniff treatment as SVG.
- Topology renderer style for `node[hasIcon=1]` in `public/js/topology-render.js` fills the node interior with white (`background-color: #ffffff`) so vendor logos pop against any basemap, and carries the status signal via a 5px `border-color: data(nodeColor)` ring instead of the fill. If you change the icon to full-bleed, drop the white fill and restore `background-color: data(nodeColor)` so the status hue isn't lost.
- Per-role `border-width` for `node[hasIcon=1]` must stay roughly 15% of the role's node `width` so the visible image lands at ~70% of the overall visual diameter. Today: fortigate 10/64, fortiswitch+remote-asset 7/44, fortiap 6/36. Change one without the other and the colored ring is either invisibly thin or so thick the logo disappears.

---

## services/discoveryDurationService.ts

**What it owns:** Rolling discovery-duration tracking per integration (and per-FortiGate within FMG runs), baseline computation for slow-run detection, and threshold formula.

**Public API:** `recordSample`, `getBaseline`, `getBaselines`, `computeBaseline`.

**Cross-service deps:** none (reads/writes Settings key "discoveryDurationStats").

**Used by:** `src/api/routes/integrations.ts` — slow-check baseline lookup (`checkForSlowRuns`), record per-FG and overall run durations, and the `GET /integrations` list endpoint attaches `discoveryBaseline` per row so the card UI can show an "Avg Discovery Time" sized against `pollInterval`. ~4 call sites.

**Invariants:**
- Only successful (non-aborted, non-errored) runs recorded; failed runs skip `recordSample()` to avoid poisoning the average.
- Rolling window = 10 samples; new sample appends, list trims to last 10.
- Baseline requires ≥3 samples; returns null otherwise.
- Slow-run threshold = `max(avg + 2σ, avg × 1.5, avg + 60s)` — ensures headroom even on uniform fast runs.
- Unit key is either integrationId (overall) or `${integrationId}:${fortigateDevice}` (per-FG).
- Stats are stored in Settings as `{ units: { [unitKey]: { samples: [ms], updatedAt } } }`.

**When changing this:**
- Test threshold formula on small sample sets (3–5 entries) to ensure floor (60s) prevents false positives.
- Verify window=10 balances responsiveness vs stability; too small (5) may be jittery, too large (20) may lag env changes.
- Check getBaselines() batch reads are correct (no off-by-one in map population).
- Confirm recordSample() ignores invalid input (negative ms, non-finite values).
- Test edge case: if all 10 samples are identical, stddev=0 and threshold should still be avg + 60s (floor wins).

---

## services/dnsService.ts

**What it owns:** Reverse (IP → PTR) and forward (hostname → A/AAAA) DNS lookup via three modes (standard/UDP, DoT/TLS, DoH/HTTPS); per-asset TTL caching; resolver configuration storage.

**Public API:** DnsSettings, PtrRecord, ARecord, ResolverLike, getDnsSettings, updateDnsSettings, createResolver, getConfiguredResolver.

**Used by:**
- src/api/routes/assets.ts — GET /assets/:id, resolve PTR names for associated IPs
- src/api/routes/integrations.ts — POST /integrations/discover, resolve PTR during discovery
- src/api/routes/serverSettings.ts — GET/PUT /server-settings/dns, CRUD DNS config + test endpoint

**Invariants:**
- Three modes (standard, dot, doh): standard falls back to system DNS, returns null TTL; DoT connects to port 853 (configurable), parses TCP wire format; DoH uses JSON API (Cloudflare/Google/Quad9).
- Standard mode cannot retrieve TTL from Node's DNS API; callers apply a sensible default (3600s).
- Per-asset PTR caching lives on AssetAssociatedIp.ptrName/ptrTtl/ptrFetchedAt (separate call path for bulk DNS job).
- IPv6 PTR queries use fully-expanded form with nibble reversal (e.g., 2001:db8::1 → 1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa).
- DoH and DoT timeouts are 5 seconds. TLS verification on the DoH/DoT connection is operator-controlled via `DnsSettings.verifyTls` (Server Settings → DNS) — read-side is `verifyTls === true`, so a stored setting with no flag keeps the prior no-verify behavior (migrate-safe; 2026-06-03 review M3). Threaded from `createResolver` → `dohFetchJson(url, verifyTls)` / `sendTlsQuery(host, port, query, verifyTls)`.
- Standard mode resolver is constructed with `{ timeout: 5000, tries: 1 }` to keep one unresponsive upstream from compounding into ~20s of per-host wall-clock (c-ares defaults to 4 tries) — critical for the AD forward-DNS pre-pass which can fan out hundreds of names.

**When changing this:**
- Test all three modes end-to-end; verify TTL handling (null for standard, numeric for DoT/DoH).
- Test IPv6 expansion and nibble reversal separately.
- Verify DoT socket cleanup on timeout (don't leak TLS connections).
- Check DoH JSON parse for missing/malformed responses; filter by type number (1=A, 28=AAAA, 12=PTR).

---

## services/entraIdService.ts

**What it owns:** Microsoft Entra ID (Azure AD) + Intune device discovery via OAuth2 Graph API client (device registration, Intune enrollment, compliance, user assignment).

**Public API:** testConnection, proxyQuery, discoverDevices, EntraIdConfig, DiscoveredEntraDevice, EntraDiscoveryResult, EntraDiscoveryProgressCallback.

**Cross-service deps:** None (pure Graph API client; no service-to-service calls).

**Used by:** src/api/routes/integrations.ts,699,861,1110,1241 — discovery trigger, test connection, manual Graph proxy query, sync path syncEntraDevices.

**Invariants:**
- OAuth2 client-credentials flow; tokens cached in-memory by tenantId:clientId until expiry ≥60s buffer.
- Device identity: Entra `deviceId` (GUID) is stable key → `AssetSource.externalId` with `sourceKind="entra"` or `"intune"`.
- When enableIntune=true, both `/v1.0/devices` and `/v1.0/deviceManagement/managedDevices` are fetched & merged on azureADDeviceId ↔ deviceId; Intune data wins on shared fields.
- Hybrid-joined devices carry `onPremisesSecurityIdentifier` (SID) → cross-link to activeDirectoryService via `sid:{SID}` tags.
- Disabled devices (accountEnabled=false) → `decommissioned` status when `includeDisabled=true` (default).
- Asset type inferred from Intune `chassisType` (desktop/laptop → workstation; other → other); Entra-only defaults to workstation.
- `deviceInclude`/`deviceExclude` filters match against displayName with wildcard support.
- proxyQuery is read-only Graph API pass-through (GET only, /v1.0/ or /beta/ prefix required).

**When changing this:**
- Test OAuth2 token caching + refresh 60s before expiry; verify no mid-request expirations.
- Verify Intune merge logic on shared fields (Intune data must win over Entra).
- Check hybrid-join SID cross-link still tags assets correctly for AD ↔ Entra matching.
- Validate deviceInclude/deviceExclude wildcard matching against displayName.
- Confirm syncEntraDevices in integrations.ts creates AssetSource rows with correct sourceKind ("entra"/"intune") based on sources array.

---

## services/eventArchiveService.ts

**What it owns:** All outbound Event flows (syslog/SFTP archival), event retention/prune configuration, and asset auto-decommission settings. Events created anywhere flow through here via job (pruneEvents) + optional real-time forwarders.

**Public API:** `getArchiveSettings`, `updateArchiveSettings`, `testConnection`, `archiveAndExport`, `getSyslogSettings`, `updateSyslogSettings`, `testSyslogConnection`, `getRetentionSettings`, `getCachedRetentionSettings`, `updateRetentionSettings`, `getAssetDecommissionSettings`, `updateAssetDecommissionSettings`.

**Cross-service deps:** none (reads Settings, spawns sftp/scp/nc, uses prisma Event table).

**Used by:** `src/jobs/pruneEvents.ts,25 — scheduled archive/export`; `src/jobs/decommissionStaleAssets.ts — inactivity threshold`; `src/api/routes/events.ts — admin CRUD endpoints`; `capacityService.ts — capacity transition Event creation`. ~8 call sites.

**Invariants:**
- All successful Events are written to `prisma.event.create()` by callers (routes, services, jobs); eventArchiveService does not write Events, only manages their export/retention. The canonical helper is `logEvent` in [src/services/eventLogService.ts](src/services/eventLogService.ts) (re-exported from `src/api/routes/events.ts` for legacy importers) — it consults `getCachedRetentionSettings().minLevel` to drop sub-threshold events, and stamps the numeric `levelRank` (0=info, 1=warning, 2=error) at write time so the Events list endpoint's `sortBy=level` can dispatch to `orderBy: { levelRank }` for severity-ordered sort. Direct `prisma.event.create()` callers must stamp `levelRank` themselves; nothing in-tree bypasses `logEvent` today.
- Archive export (SFTP/SCP) reads Events older than cutoff, writes JSON file, transfers via ssh/sftp spawn, then deletes from DB (via pruneEvents job).
- Retention cache (1 min TTL) avoids DB read on every Event write; callers using `getCachedRetentionSettings()` must accept stale data.
- Asset decommission threshold (0 = disabled) is in months; lastSeen older than that triggers `decommissioned` status in a separate 24h job.
- Syslog (UDP/TCP/TLS) sends test messages synchronously; real event forwarding NOT in this service (would be added as a background job).
- SFTP batch-file injection prevention: paths with quotes/newlines rejected before spawn.

**When changing this:**
- Test archiveAndExport with large Event payloads (>10k rows); verify SFTP/SCP progress.
- Verify retention cache doesn't mask rapid setting changes; 60s may be too long for some ops.
- Check asset decommission query doesn't accidentally mark live assets as stale (lastSeen >= cutoff).
- Confirm syslog test messages arrive with the right facility/severity/format.
- Validate SFTP injection prevention doesn't reject legitimate Windows paths with backslashes.

---

## services/eventLogService.ts

**What it owns:** The shared audit-event writer. `logEvent` (never throws; drops rows below the operator-configured min level; stamps `levelRank` at write time), `buildChanges` (before/after diff for `.updated` events), `LogEventInput`.

**Public API:** `logEvent`, `buildChanges`, `LogEventInput`.

**Cross-service deps:** `eventArchiveService.getCachedRetentionSettings` (cached min-level read).

**Used by:** ~42 modules across routes / services / jobs. Most import via the back-compat re-export in `src/api/routes/events.ts`; new code should import from here directly so services never depend on the route layer.

**Invariants:**
- `logEvent` must never throw — event logging can't be allowed to break the operation it audits. Failures are swallowed.
- `levelRank` is stamped here (0=info, 1=warning, 2=error); the Events list endpoint's `sortBy=level` depends on it.
- Sub-`minLevel` events are dropped silently (cached settings read, 60s TTL — accept staleness).

**When changing this:**
- The events.ts re-export must stay in lockstep (same symbol names) until the legacy importers are migrated.
- Anything that makes `logEvent` throw or block breaks every mutating route in the app — keep it best-effort.

---

## services/fortigateService.ts

**What it owns:** Standalone FortiGate REST API client & discovery (mirrors FMG scope—DHCP subnets, reservations, device inventory, interface IPs, managed FortiSwitches/FortiAPs, VIPs).

**Public API:** testConnection, fgRequest, proxyQuery, discoverDhcpSubnets, FortiGateConfig, plus re-exported DiscoveryResult & 6 DiscoveredXxx types from FMG.

**Cross-service deps:** fortimanagerService (imports DiscoveryResult shape + types; fortimanagerService imports fgRequest, testConnection, proxyQuery for proxy-mode device iteration).

**Used by:** src/api/routes/integrations.ts,695,851,1107,1269 — discovery + test + manual proxy query, src/services/monitoringService.ts — REST calls for uptime monitoring, src/services/reservationPushService.ts — direct REST push of DHCP reservations, src/services/assetQuarantineService.ts — direct REST push of quarantine targets.

**Invariants:**
- fgRequest is the low-level bearer-token auth layer; all per-device queries use it.
- discoverDhcpSubnets returns DiscoveryResult identical to FMG's shape so integrations.ts syncDhcpSubnets pipeline handles both identically.
- FortiAP `/api/v2/monitor/wifi/managed_ap` row parsing is centralized in `src/utils/fortiapMonitorRow.ts` (`parseFortiapMonitorRow` + `FORTIAP_MONITOR_FORMAT`) — both transports import the same parser + format string so they can't drift.
- Standalone FortiGate has no proxy/direct toggle (useProxy doesn't apply); all queries go directly to the device's management IP.
- proxyQuery is a read-only REST pass-through for manual API testing; does not modify CMDB.
- Per-FortiGate query fan-out is seven parallel chains (A-G); Chain G calls `/api/v2/monitor/system/ha-peer` to populate `DiscoveredDevice.haMode` + `haMembers`. 404 / empty = standalone.
- Chain G failures are isolated — a hung HA query never tanks the whole device's discovery (same try/catch pattern as Chains A-F).
- Chain C's detected-device loop additionally builds `switchMacByName: Map<switch_id, mac>` from rows where `is_fortilink_peer===true` and stamps each managed FortiSwitch's `baseMac` field after the AP-attribution pass. Zero extra REST calls — joined from the existing query response. Keep the stamp inside Chain C: doing it elsewhere would re-iterate detected-device rows for no win.

**When changing this:**
- Verify DiscoveryResult shape matches fortimanagerService exactly—sync pipeline expects field parity.
- Check monitoringService and both push services still call fgRequest with correct vdom/token/method signatures.
- Confirm proxyQuery handles GET/POST/PUT/DELETE correctly for manual testing route.
- Test discovery parallelism (no clamping unlike FMG proxy mode) with high per-device concurrency.
- Ensure VDOM parameter threading is correct (default "root"; custom vdoms from config).
- Adding another per-FortiGate REST endpoint: add an 8th chain inside the Promise.all rather than appending after — keeps wall-clock at max(chain) instead of sum(chains).

---

## services/fortigateCoordPushService.ts

**What it owns:** Write-back orchestrator for FortiGate `gui-device-latitude` / `gui-device-longitude` (and FMG coordinate metavars when applicable) after `syncDhcpSubnets` resolves geocoded coords that diverge from the device's current CMDB values. The FMG metavar names are operator-configurable (`fortigateMonitor.latitudeMetavar` / `longitudeMetavar`, default `Latitude` / `Longitude`).

**Public API:** `pushCoordsToFortigate(integration, deviceName, latitude, longitude, latMetavar?, lngMetavar?): Promise<CoordPushResult>`. The metavar names default to `Latitude` / `Longitude`; the caller passes the integration's configured names. Ignored by the standalone FortiGate path (CMDB-only).

**Cross-service deps:** fortimanagerService (uses native FMG helpers `setFmgDeviceMetaFields` + `setFmgDeviceCmdbGuiCoords`), fortigateService (uses `fgRequest` for the standalone CMDB PUT).

**Used by:** src/api/routes/integrations.ts:syncDhcpSubnets Phase 3 — fires once per FortiGate after the per-HA-member loop, gated on `pushGeocodedCoords` + geocode success + `coordsClose()` mismatch. Geocode coords come from either the SNMP sysLocation or the FMG address metavar (address wins; see the geo cross-cutting section).

**Invariants:**
- FMG mode writes BOTH per-device metavars AND CMDB GUI coords. Standalone FortiGate writes only CMDB. Single source of truth for routing — never inline another transport choice in callers.
- All FMG writes go through the native lane (no `/sys/proxy/json` wrapper) — they don't share the proxy-lane concurrency=1 constraint.
- Best-effort: per-target failures are collected into the returned `{ok, targets[], error?}` shape but never thrown. Audit events (`integration.coords.pushed` / `integration.coords.push_failed`) live at the caller in integrations.ts, not here.
- FMG-mode CMDB writes land in FMG's CMDB but do NOT trigger an FMG install — the live FortiGate sees the change only when an operator runs Install Device Configuration in FMG. UI text on the toggle surfaces this caveat.
- Coords are formatted as `.toFixed(6)` strings before sending (FortiOS stores them as strings, not floats).

**When changing this:**
- Adding a new write target: add a new try/catch arm, push the target name onto the `targets` array on success, log + continue on failure (don't throw).
- If extending to integration types beyond fortimanager / fortigate, mirror the type-dispatch pattern from reservationPushService — never inline a new transport builder.
- Verify both modes when changing the FMG payload: re-discover with `pushGeocodedCoords` on; confirm metavars + CMDB both updated via `curl` directly against FMG's REST API.

---

## services/fortigateLocationService.ts

**What it owns:** Discovery-time REST pull of FortiGate SNMP sysLocation (`GET /api/v2/cmdb/system.snmp/sysinfo`). REST instead of net-snmp so it reuses the existing FMG-proxy / standalone transport and doesn't need a separate SNMP credential.

**Public API:** `fetchFortigateSysLocation({integration, deviceName}): Promise<string | null>`.

**Cross-service deps:** reservationPushService (imports `callFortiOs` + `buildTransportForIntegration`).

**Used by:** src/api/routes/integrations.ts:syncDhcpSubnets Phase 3 — gated on the integration's `fortigateMonitor.pullSnmpLocation` toggle. Fires ONCE per FortiGate per discovery cycle (NOT per HA member — cluster members share sysLocation by physical co-location).

**Invariants:**
- REST-only. Never bring back an SNMP path here — adding net-snmp would re-introduce a credential resolver + per-host gate that the REST approach deliberately sidesteps.
- Returns trimmed, whitespace-collapsed string OR null. Empty FortiOS response → null. Transport failures → null (logged at warn).
- Never throws. The discovery sync continues with no location update on failure.
- Works in BOTH FMG proxy and direct modes — FMG forwards the call to the FortiGate in proxy mode, so Polaris doesn't need network reachability to the FortiGate's mgmt IP.

**When changing this:**
- Adding new SNMP system-info fields (sysContact, sysDescription): same endpoint already returns them. Extend the interface and surface as additional return fields rather than adding new endpoints.
- Don't add retries here — the caller (syncDhcpSubnets) treats this as a single-shot, best-effort fetch; retry logic would burn discovery wall-clock for marginal value.

---

## services/fmgActivityService.ts

**What it owns:** DB-backed heartbeat of every local `FmgWorker`'s proxy + native lane state. The role that runs FMG traffic (discovery in split-role prod, the single process in "all" mode) writes a snapshot of `getAllFmgWorkers()` to the `fmgActivitySnapshot` Setting row every 2 s. The web role reads the same row back to render "Active FMG Calls" on the integrations page — bridging the in-memory state across the multi-process split.

**Public API:** `startFmgActivityHeartbeat()` (idempotent boot-path entry), `getFmgActivityForIntegration(integrationId)` (read-side; returns proxyInFlightLabel + proxyQueueDepth + nativeInFlightCount + updatedAt/role/ageMs/fresh), `STALENESS_MS` (10 s — older snapshots are flagged `fresh: false`), `stopFmgActivityHeartbeatForTests`.

**Cross-service deps:** fmgWorker (`getAllFmgWorkers()` for the snapshot), prisma (single `Setting` row read/write).

**Used by:** src/app.ts boots `startFmgActivityHeartbeat()` inside the `runsDiscoveryConsumers` block, src/api/routes/integrations.ts `GET /:id/fmg-activity` reads via `getFmgActivityForIntegration()`, public/js/integrations.js polls that endpoint every 2 s for every FortiManager-type integration card on screen.

**Invariants:**
- Heartbeat write rate is 2 s per FMG-running process; only roles with `runsDiscoveryConsumers=true` write. Single Setting row clobbers per write — no per-process slicing, so in dev "all" mode the lone process is the writer.
- Snapshot is `{ updatedAt, role, integrations: { [id]: { proxyInFlightLabel, proxyQueueDepth, nativeInFlightCount } } }`. An integration absent from the map = no FmgWorker has been instantiated for it yet (lazy create on first submit).
- Freshness window is 5× heartbeat interval (10 s) so a transient hiccup doesn't flap the UI; a genuinely-down heartbeat process surfaces inside the window.
- Read path returns a zeroed readout with `fresh: false` when the Setting row is missing — so the UI renders "no heartbeat" on a brand-new install before discovery runs.

**When changing this:**
- Changing the heartbeat interval: keep `STALENESS_MS ≥ 3×` the interval so the UI doesn't flap on a single missed write.
- Adding new FmgWorker fields you want surfaced: extend `FmgWorkerActivity`, both `buildSnapshot` and `getFmgActivityForIntegration`, the route response shape, and the `_renderFmgActivity()` helper in [public/js/integrations.js](public/js/integrations.js).
- Adding more cross-process state surfaces in the future: prefer one Setting row per concern (clobber-on-write is fine at 2 s cadence), not one big shared blob.

---

## services/fmgWorker.ts

**What it owns:** Per-integration FortiManager worker with two lanes — a proxy lane (strict concurrency=1 FIFO) for `/sys/proxy/json` calls and a native lane (unbounded) for every other FMG call. Module-level `Map<integrationId, FmgWorker>` lazy-created on first submit; never torn down.

**Public API:** `getFmgWorker(integrationId): FmgWorker`, `getAllFmgWorkers(): FmgWorker[]`, `FmgWorker.submitProxy<T>(label, task, signal)`, `FmgWorker.submitNative<T>(label, task, signal)`, `FmgWorker.proxyQueueDepth`, `FmgWorker.proxyInFlightLabel`, `FmgWorker.nativeInFlightCount`, `__resetFmgWorkersForTests`.

**Cross-service deps:** metrics (publishes `polaris_fmg_worker_queue_depth{integrationId}` + `polaris_fmg_worker_inflight{integrationId}` for the proxy lane, `polaris_fmg_worker_native_inflight{integrationId}` for the native lane).

**Used by:** src/services/fortimanagerService.ts (`rpc()` routes via `submitProxy` / `submitNative` based on the JSON-RPC payload URL — every call that touches FMG flows through this), src/services/fmgActivityService.ts (`getAllFmgWorkers()` for the 2 s heartbeat snapshot). No other module should call `submitProxy` / `submitNative` directly; by transitivity the rpc-path covers reservationPushService.ts, assetQuarantineService.ts, monitoringService.ts, and the integrations.ts routes that test / probe / manual-query FMG.

**Invariants:**
- Proxy lane is strict FIFO with concurrency=1 — honors FMG's "drops parallel /sys/proxy/json past 1-2" constraint. Cross-feature serialization holds here: an operator clicking "Reserve IP" mid-discovery has the reservation-push proxy call wait behind in-flight discovery proxy calls.
- Native lane is unbounded; the worker just tracks inflight count for observability. Native FMG endpoints (`/pm/config/...`, `/dvmdb/...`, auth) hit FMG's own DB and have no parallel-call constraint.
- Aborts (proxy lane): pre-dispatch abort drops the queued entry and rejects with AbortError. In-flight abort is the task's fetch-signal responsibility.
- Aborts (native lane): no queue, so abort just bubbles through the task's own fetch signal.
- One worker per integration id. Different integrations get independent workers and run fully concurrently across both lanes.

**When changing this:**
- Adding a NEW FMG-bound code path: just call `rpc()` with the integrationId; the lane dispatch is automatic from the JSON-RPC payload URL. Never call `submitProxy` / `submitNative` directly from outside fortimanagerService.
- If a new FMG endpoint pattern shows up that needs lane treatment different from "is it /sys/proxy/json", update `rpcPayloadIsProxy()` in fortimanagerService — keep the predicate the only place that decides which lane.
- Test both lanes when adding behavior — the proxy lane is exercised by FIFO + abort tests; the native lane by concurrent-fire + inflight-decrement-on-throw tests.

---

## services/fortimanagerService.ts

**What it owns:** FortiManager JSON-RPC API client & full discovery orchestration (DHCP subnets, device inventory, interface IPs, VLAN membership, DHCP reservations, FortiSwitches/FortiAPs, VIPs, ARP).

**Public API:** testConnection, resolveDeviceMgmtIpViaFmg, testRandomFortiGate, proxyQuery, fmgProxyRest, proxyQueryViaFortigate, discoverDhcpSubnets, FortiManagerConfig, DiscoveryResult, DiscoveryProgressCallback (and 6 DiscoveredXxx types). Every entry point accepts an optional `integrationId?: string` (and `discoverDhcpSubnets` additionally accepts `warmCacheIps?: Map<string,string>`); when supplied, internal `rpc()` calls funnel through `getFmgWorker(integrationId)` so FMG traffic stays serial against the "one-request-at-a-time" constraint. There is intentionally **no `/sys/logout`**: Polaris authenticates with a predefined REST API Admin api-key, which (per the FMG API Best Practices Guide) is permanent and shares one session per user — login/logout endpoints exist for session-based auth only. A prior hourly logout (commit 3e70476) tore the shared session out from under the split-role monitor/discovery processes that reuse it and was removed; if FMG reaps the session at its hard lifetime the next bearer call re-establishes it.

**Cross-service deps:** fortigateService (imports discoverDhcpSubnets for direct-mode fallback; imports fgTestConnection and proxyQuery for proxy testing); fmgWorker (every rpc call routes through `getFmgWorker` when an integrationId is in scope).

**Used by:** src/api/routes/integrations.ts,693,824,840,1107,1283 — discovery orchestration + test + manual proxy query + realtime push via FMG, src/services/monitoringService.ts — FMG proxy REST for uptime monitoring, src/services/reservationPushService.ts — push DHCP reservations to FortiGate via FMG proxy/direct, src/services/assetQuarantineService.ts — push quarantine targets via FMG proxy/direct.

**Invariants:**
- Proxy mode (`useProxy: true`, default) clamps per-FortiGate parallelism to 1 because FortiManager drops parallel `/sys/proxy/json` connections. The FMG worker's proxy lane enforces that serialization; the per-device CMDB scrapes (interface config, DHCP CMDB, VIPs, geo coords, etc.) run concurrently on the worker's native lane, so per-device throughput is higher than the proxy-lane bottleneck alone would suggest.
- Direct mode (`useProxy: false`) requires valid fortigateApiUser/fortigateApiToken on the FMG integration; mgmt IPs come from either the warm cache (monitor-up firewall Asset rows) or `resolveDeviceMgmtIpViaFmg` for cache-cold/new devices. Cache-cold mgmt-IP resolves now run concurrently across the worker pool (native lane is unbounded) — fresh installs no longer pay the serial-resolve penalty before per-device discovery can start.
- All FMG-bound calls go through `rpc()`, which inspects the JSON-RPC payload's first param URL and routes to `getFmgWorker(integrationId).submitProxy` (when it's `/sys/proxy/json`) or `submitNative` (every other URL). Per-device direct-FortiGate calls do NOT touch FMG and fan out up to `discoveryParallelism` wide independently of the worker.
- Transport-level resilience (`rpcInner`/`rpcAttempt`): retries **transient** failures only — HTTP 5xx + network/timeout — up to 2 times with exponential backoff (500ms, 1500ms), serialized INSIDE the FmgWorker lane slot so the proxy lane stays concurrency=1 and a struggling FMG isn't piled on. **Permanent** failures fail fast with no retry: HTTP 401/403/404/405 and the FMG RPC `-11` surfaced by callers. Outward `AppError.httpStatus` stays 502 for every transport fault — the upstream HTTP code is encoded in the message and used only to decide retryability, never re-exposed to Polaris's own clients (a raw 401 would trip the frontend's session-expired logout). An external abort (integration re-saved) short-circuits without retrying. This is a transport-layer policy beneath the discovery callers; do NOT add a second app-level retry loop on top (see `fetchFortigateSysLocation` note).
- Projected CMDB `get` calls pass `loadsub: 0` to skip child-table loads (FMG API Best Practices Guide), EXCEPT where a child table is intentionally needed: `system/interface` (secondary-ip) and `firewall/vip` (mappedip + realservers — the latter is the Virtual-Server pool consumed by `parseVipServerInfo`). Do NOT add a `fields` list to the `/dvmdb/.../device` full-device-record fetch or `system/dhcp/server` — naming restricted fields like `latitude` makes this FMG authorize each field individually and fail the whole query with `-11`.
- Parity invariant: both FMG and standalone FortiGate return identical DiscoveryResult shape for sync pipeline compatibility.
- FortiAP `/api/v2/monitor/wifi/managed_ap` row parsing centralized in `src/utils/fortiapMonitorRow.ts` (`parseFortiapMonitorRow` + `FORTIAP_MONITOR_FORMAT`) — shared with the standalone FortiGate path. Captures IP / MAC (with `board_mac` fallback) / model (with `deriveFortiapModelFromSerial` for blank-model APs) / `apUplinkInterface` (from `wan_status[].interface` then LLDP `local_port`) plus the live telemetry snapshot (`cpu_usage` / `mem_free` / `mem_total` / `sensors_temperatures`) which feeds the AssetSource observed blob and the runtime AP REST telemetry collector.
- Step 3d.5's detected-device loop additionally builds `switchMacByName: Map<switch_id, mac>` from rows where `is_fortilink_peer===true` and stamps each managed FortiSwitch's `baseMac` field after the AP-attribution pass. Zero extra `/sys/proxy/json` calls — joined from the existing query response, so the FMG proxy lane stays at the same call count. Parity-mirrored in `fortigateService.ts` Chain C.
- Cache-miss fallback in processDevice's direct-mode branch: if a warm-cache dispatch fails, re-resolve via FMG worker and retry once at the freshly-resolved IP. Cleared via `cachedNames.delete(deviceKey)` so the loop never iterates more than twice.
- All FMG name-keyed in-memory state (`mgmtIpByDevice`, `cachedNames`, `warmDispatched`, `devicesByName`) keys on `fmgNameKey(name)` (lowercased). FMG-stored device names and FortiOS system-status hostnames can disagree in case for the same device; lowercasing the key on both write paths (warm-cache pre-populate + FMG-verify resolve) means the worker's lookup succeeds no matter which producer seeded the entry. Display names in log lines + Events still use original casing carried on the rawDevice / asset row.
- HA detection is **zero extra calls**: `extractHaFromFmgDevice(raw)` reads `ha_mode` + `ha_slave[]` directly off each `/dvmdb/adom/<adom>/device` record FMG already returns. The "current primary" is identified by matching `ha_slave[].sn` against `device.sn`; `idx === 0` is the fallback. Standalone devices return `{ haMode: "standalone", haMembers: [] }` so downstream code branches uniformly.
- Direct-mode HA precedence: when FMG's `ha_slave[]` is populated, it wins over fortigateService's `ha-peer`-derived view (FMG's view is stable across failover; ha-peer reflects whichever physical box is currently active and would flip on failover).
- `DiscoveryResult.knownDeviceNames` preserves FMG-side casing (whatever `/dvmdb/adom/.../device` returned). The downstream Phase 2 / 2a roster check in `integrations.ts:syncDhcpSubnets` builds a lowercase `knownDeviceNamesLc` view and compares lowercase-on-both-sides, AND prefers `knownFirewallSerials` over the hostname check entirely — same device, same chassis, different name casing is a real-world FMG-vs-FortiOS condition (FMG-stored "evansville-fw-1" vs FortiOS-returned "EVANSVILLE-FW-1"). If you add a new consumer of `knownDeviceNames`, normalize the same way.
- `testRandomFortiGate` Fisher-Yates-shuffles the filtered device list and walks up to `MAX_RANDOM_FORTIGATE_ATTEMPTS = 2` entries — so one offline/in-maintenance gate doesn't fail the whole direct-transport test when the rest of the fleet is healthy. Only the per-gate steps (`resolveDeviceMgmtIpViaFmg` + `fgTestConnection`) retry; FMG-level failures (device list fetch, empty/filtered-out ADOM, missing mgmt interface) are returned as-is on the first try. The response carries an `attempts: string[]` listing every gate name tried so callers can surface "initial pick failed; backup pick succeeded" or "also tried: X" in the UI.

**When changing this:**
- Verify parity with fortigateService.discoverDhcpSubnets (DiscoveryResult shape + field semantics).
- Check reservationPushService & assetQuarantineService both call fmgProxyRest correctly for proxy mode + resolveDeviceMgmtIpViaFmg for direct mode, AND that both pass `integrationId` so the call routes through the FMG worker.
- Confirm monitoringService still resolves management IPs and calls fmgProxyRest with `integrationId` for proxy-mode health checks.
- Update docs/fmg-discovery.md if transport modes, roster filters, or per-class stamping change.
- Test proxy-mode parallelism clamp + direct-mode device resolution end-to-end. Confirm warm-cache producer fills the worker pool from t=0 on a fleet with monitor-up firewalls.
- New FMG-bound code paths MUST submit through `getFmgWorker(integrationId)` — bare `rpc()` without an integrationId loses cross-feature serialization and reintroduces the parallel-connection failure mode.

---

## services/geocoderService.ts

**What it owns:** Address-string → lat/lng geocoder backed by OpenStreetMap Nominatim with a positive+negative `GeocodeCache` (90-day TTL) and a process-global 1 req/sec rate limiter.

**Public API:** `geocode(query: string): Promise<{ latitude: number | null, longitude: number | null, cached: boolean }>`.

**Cross-service deps:** None (uses prisma directly for cache reads/writes; `getAppVersion()` for the Nominatim User-Agent).

**Used by:** src/api/routes/integrations.ts:syncDhcpSubnets Phase 3 — geocodes FortiGate SNMP sysLocation when `fortigateMonitor.pullSnmpLocation` is on.

**Invariants:**
- Normalization key: trim + collapse-whitespace + lowercase. Same on read and write so capitalization / spacing variants collide on one cache row.
- Cache stores BOTH positive AND negative results. A null lat/lng row means "Nominatim returned no match" — the negative-cache signal that prevents gibberish strings from repeatedly hitting upstream.
- Transport failures (timeout / non-2xx / parse error) do NOT write a cache row. Only the upstream's actual response (success OR empty array) writes — so a transient Nominatim outage doesn't poison subsequent retries.
- Rate limiter is module-level chained Promise enforcing ≥1100 ms between outgoing requests (Nominatim's usage policy is 1 req/sec; 100 ms safety margin). Cache hits BYPASS the gate entirely.
- User-Agent identifies Polaris per Nominatim's usage policy (`Polaris-IPAM/<version>`). Never use a generic / library-default UA.
- Never throws. All failures return `{latitude: null, longitude: null, cached: false}` so callers in the discovery hot path don't need to wrap.

**When changing this:**
- Don't add per-request retries — Nominatim's policy is "be patient and don't hammer us"; one shot per cycle, fall through on failure, retry on next discovery.
- TTL is 90 days. Lengthening it reduces upstream load further; shortening risks operators editing sysLocation and waiting too long to see the new pin location. Don't go below 7 days.
- Adding a second provider (Google / Mapbox): introduce a `provider` parameter, store provider per cache row (already in schema), and run all writes through a single normalization so the cache stays consistent.
- If extending to other domains (e.g. non-FortiGate asset location lookups), keep the rate limiter shared — Nominatim doesn't care which Polaris feature triggered the request, only the rate-per-process matters.

---

## services/interfaceTopologyService.ts

**What it owns:** Infer inter-Fortinet device topology edges (FortiGate ↔ FortiSwitch ↔ FortiAP stacks) from interface naming conventions & serial patterns without new live queries.

**Public API:** inferInterfaceTopology, InterfaceInferredEdge, InterfaceInferredRemote, InterfaceInferenceResult.

**Cross-service deps:** None (reads AssetInterfaceSample rows and in-memory asset inventory; calls utility functions).

**Used by:** src/api/routes/map.ts — topology graph for Device Map (sites/:id/topology endpoint); src/services/dependencyTreeService.ts — Phase 12 of FMG/FortiGate sync via `recomputeDependencyTree`.

**Invariants:**
- Reads latest AssetInterfaceSample per (assetId, ifName) from seed asset set within a 1-hour timestamp window; no live discovery queries. The window exists to filter out interfaces that have stopped reporting (asset down/decommissioned, monitoring disabled) — drawing a topology edge from a stale sample would be wrong data. Default system-info cadence is 600s, so 1 hour tolerates ~5 missed scrapes without admitting genuinely-stale interfaces. Without the bound the DISTINCT ON had to scan the entire active hypertable chunk and was observed at 13.5 min / 90M rows / 9 GB I/O on a fleet of ~600 infra assets.
- Serial-match candidates filtered to exact 1 inventory hit (ambiguous matches skipped); hostname-match same rule.
- Self-loops (asset's own serial/hostname) are rejected.
- Infers both directions when both sides' interface names encode peer identity; targetIfName null when only source side is parseable.
- Matches via parseFortinetPeerInterface utility; peer IP/MAC/model returned from remoteAssets even if outside seed set (cross-site edges).
- Returned edge ifNames are translated from aggregate name to underlying physical member when the aggregate has EXACTLY one physical child (ifType="physical" + ifParent=aggregate). Multi-member aggregates fall back to the aggregate name. The aggregate is still the inference signal (peer identity is encoded there); only the display ifName on the edge is normalized so topology labels read as physical-port-to-physical-port instead of peer-serial-encoded aggregate names. NOTE: this `preferPhysical` swap depends on `ifParent` being populated on the member rows. For FortiGate aggregates that comes from `collectSystemInfoFortinet`'s CMDB back-fill; for managed **FortiSwitch** trunks (FortiLink uplinks, named after the switch serial) it comes from `monitoringService.overlayFortiswitchTrunkMembers`, which reads the trunk→member map off the same managed-switch CMDB the VLAN overlay uses. Without that overlay a switch trunk has no member rows and falls through to the trunk name.

**When changing this:**
- Verify parseFortinetPeerInterface still extracts serial + hostname patterns correctly.
- Confirm ambiguity detection (multiple inventory matches) still blocks inference on both directions.
- Test cross-site edge rendering (remoteAssets for peers outside seed set) in map.ts.
- Validate serialMatchesPeerInterface and hostnameMatchesPeerInterface utility functions.
- The 1-hour window is a perf gate, not a correctness one — if tightening further (e.g. 30 min), confirm the system-info cadence isn't longer than the window/2 for any tier-3 settings; widening it (e.g. back to 24h) re-incurs the Phase 12 scan cost.

---

## services/ipService.ts

**What it owns:** IP validation, availability checking, and subnet capacity reporting.

**Public API:** assertValidIp, assertValidCidr, assertIpInSubnet, isIpAvailable, getActiveReservationsForSubnet, subnetCapacity.

**Used by:** src/api/routes/reservations.ts (multiple callers), src/services/reservationService.ts (ipInCidr, detectIpVersion), src/services/reservationPushService.ts (isValidIpAddress).

**Invariants:**
- IPv4-only for capacity calculations (IPv6 raises 400)
- All CIDR inputs are normalized (host bits zeroed)
- IP addresses must be validated before subnet containment checks
- Active reservations indexed on subnetId + status = "active"

**When changing this:**
- Review all calls to assertValidIp/assertValidCidr in routes (ipAddress validation gates many Reservation operations)
- Check utilization calculations depend on subnetCapacity (affects Dashboard utilization card)
- Test with both IPv4 and IPv6 where applicable

---

## services/manufacturerAliasService.ts

**What it owns:** Manufacturer alias CRUD (IEEE legal name → marketing name), in-memory alias map cache synced to Prisma extension, background backfill of normalized strings in Asset and MibFile rows, and idempotent default seed.

**Public API:** `listAliases`, `createAlias`, `updateAlias`, `deleteAlias`, `refreshAliasCache`, `seedDefaultAliases`, `applyAliasesToExistingRows`, `ManufacturerAliasRow`.

**Cross-service deps:** None (consumed by routes and jobs).

**Used by:** `src/api/routes/manufacturerAliases.ts — admin CRUD endpoints`, `src/jobs/normalizeManufacturers.ts — startup seeding and backfill`, `src/db.ts — Prisma extension normalizer hook`.

**Invariants:**
- In-memory map (`setAliasMap()` in `manufacturerNormalize.ts`) must be refreshed after every mutation.
- `seedDefaultAliases()` is idempotent; only inserts missing rows (no overwrites).
- `applyAliasesToExistingRows()` respects (manufacturer, model, moduleName) uniqueness; logs warnings when normalization would create duplicates.
- Prisma extension hooks `normalizeManufacturer()` on all Asset/MibFile create/update/upsert calls.

**When changing this:**
- Update `DEFAULT_ALIASES` constants when IEEE-registered names change or new vendor aliases are discovered.
- Verify `createAlias()` uniqueness check is case-insensitive (alias is lowercased).
- Test `applyAliasesToExistingRows()` backfill with duplicate-collapse edge cases (two rows collapsing to same canonical).
- Confirm `refreshAliasCache()` is called after every CRUD mutation (create/update do this; delete does not since no rows change).
- Inspect `src/db.ts` Prisma extension to ensure normalizer is wired to all manufacturer-write paths.

---

## services/mibService.ts

**What it owns:** Parsing, validation, and CRUD for uploaded SNMP MIB modules. The light validator (`parseMib`) gates uploads (1MB cap, rejects binaries, extracts moduleName + IMPORTS). The heavier peer (`parseMibStructured`) drives the Browse + MIB-aware Walk surface — extracts SYNTAX, INTEGER enum value labels, ACCESS, STATUS, DESCRIPTION, INDEX clauses, and SEQUENCE OF table structure. Per-(manufacturer, model, moduleName) uniqueness is enforced at create.

**Public API:** `parseMib`, `parseMibStructured`, `listMibs`, `getMib`, `createMib`, `deleteMib`, `getMibFacets`, `getProfileStatus`, `ParsedMib`, `ParsedMibStructured`, `MibSymbol`, `MibTable`, `MibBaseType`, `MibAccess`, `MibStatus`, `MibSymbolKind`, `MibEnumValue`, `MibSummary`, `MibFilter`, `CreateMibInput`, `ProfileStatus`, `ProfileSymbolStatus`.

**Cross-service deps:** `oidRegistry` (refreshRegistry, resolveSymbolAtVendorScope, listModelOverrides), `vendorTelemetryProfiles` (VENDOR_TELEMETRY_PROFILES), `mibParserUtils` (stripComments).

**Used by:** `src/api/routes/mibs.ts — list/get/upload/delete + Browse `/structure` + MIB-aware `/walk``, `src/services/oidRegistry.ts — refreshes the symbol table on create/delete`, `src/services/monitoringService.ts — via oidRegistry for vendor profile matching`.

**Invariants:**
- SMI parser validates UTF-8 text only (rejects NUL and control chars <0x20 except tab/CR/LF).
- Module header required: `<NAME> DEFINITIONS ::= BEGIN`; footer required: `END`. The module-name regex tolerates **mixed-case** identifiers (`[A-Z][A-Za-z0-9-]*`) — RFC-canonical names like `SNMPv2-MIB`, `SNMPv2-SMI`, `SNMPv2-TC` carry a lowercase `v` for version segments, matching the same tolerance the IMPORTS-parser uses below. An uppercase-only regex would capture the trailing `MIB` after `SNMPv2-` as the module name.
- Duplicate check on (manufacturer, model, moduleName) tuple catches generics via explicit query (NULL handling).
- Successful create/delete always refreshes oidRegistry immediately.
- `parseMibStructured` is a peer of `parseMib`, NOT a superset call. A regression in the structured parser must not be reachable from the upload hot path. Per-symbol parse failures degrade fields to null rather than dropping symbols.

**When changing this:**
- Verify `createMib` duplicate-check logic handles NULL fields in your test data.
- Confirm `parseMib` rejects binary/non-text files (test with fixture files).
- Run `getProfileStatus()` against your vendor MIBs to ensure symbol resolution still works.
- Update `DEFAULT_ALIASES` in `manufacturerAliasService.ts` if adding new vendor facets.
- Check `src/api/routes/mibs.ts` (NOT `serverSettings.ts`) for upload/list/delete endpoint compliance — the MIB routes were extracted there to take precedence over `/server-settings`'s blanket `requireAdmin`.
- Re-run `tests/unit/mibParseStructured.test.ts` — covers IF-MIB-style table detection, INTEGER enum extraction, multi-line DESCRIPTION, embedded `""` quote escapes, and comment-tolerant enum bodies.
- `stdMibLibrary.ts` re-uses `parseMibStructured` against bundled standard-MIB text files — any change to the parser must keep the 16 cases in `tests/unit/stdMibLibrary.test.ts` (SNMPv2-MIB / IF-MIB / HOST-RESOURCES-MIB / ENTITY-MIB / ENTITY-SENSOR-MIB / LLDP-MIB spot-checks) green.

---

## services/monitoringService.ts

**What it owns:** Asset health monitoring via probes, telemetry collection, and state machine transitions across five monitor states (unknown → recovering → up → warning → down).

**Public API:** `probeAsset`, `resolveMonitorSettings`, `resolveMonitorSettingsWithProvenance`, `recordProbeResult`, `recordTelemetryResult`, `recordHardwareSensorResult`, `recordSystemInfoResult`, `recordFastFilteredResult`, `collectTelemetry`, `collectHardwareSensors`, `collectFastFiltered`, `collectSystemInfo`, `collectLldpOnlyFortinet`, `collectLldpOnlySnmp`, `fortilinkInterfaceNamesFromCmdb`, `snmpWalkRaw`, `probeCredentialAgainstHost`, `getMonitorSettings`, `updateMonitorSettings`, `invalidateMonitorSettingsCache`, `getAdMonitorProtocol`, `runProbeFor`, `runTelemetryFor`, `runSystemInfoFor`, `runFastFilteredFor`, `runMonitorPass`, `pruneMonitorSamples`, `pruneTelemetrySamples`, `pruneSystemInfoSamples`, `ProbeResult`, `MonitorTierSettings`, `MonitorOverrideSettings`, `ResolvedMonitorSettings`, `AssetMonitorContext`, `ProvenanceTier`, `ResolvedSettingsWithProvenance`, `TelemetrySample`, `InterfaceSample`, `StorageSample`, `HardwareSensorSample`, `IpsecTunnelSample`, `LldpNeighborSample`, `SystemInfoSample`, `CollectionResult`, `SnmpWalkRow`, `SnmpWalkResult`, `MonitorCadence`, `CadenceOutcome`.

**Cross-service deps:** `fortigateService.ts`, `fortimanagerService.ts`, `timescaleService.ts`, `oidRegistry.ts`, `vendorTelemetryProfiles.ts`.

**Used by:** `src/app.ts` — boot timescale detection; `src/api/routes/credentials.ts` — probe credential testing; `src/api/routes/integrations.ts` — AD monitor protocol selection; `src/api/routes/assets.ts` — effective monitor settings + probe request; `src/api/routes/monitorSettings.ts` — cache invalidation; `src/jobs/monitorAssets.ts` — core monitor loop dispatch; `src/jobs/migrateMonitorSettingsHierarchy.ts` — cache invalidation; `src/services/capacityService.ts` — monitor settings for capacity calculation.

**Invariants:**
- **Four-tier resolver:** per-asset overrides (top) → class override → integration/manual tier → hardcoded floor. Call `invalidateMonitorSettingsCache(scope)` after any tier-3 or tier-2 write to refresh `resolveMonitorSettings()` on next call. The eight cadence/timeout fields (`intervalSeconds`, `cpuMemoryIntervalSeconds`, `temperatureIntervalSeconds`, `systemInfoIntervalSeconds`, `probeTimeoutMs`, `cpuMemoryTimeoutMs`, `temperatureTimeoutMs`, `systemInfoTimeoutMs`) cascade through every tier; `failureThreshold` and the three retentions stop at tier-2 (class override). CPU/memory and temperature dispatch independently: `collectTelemetry` consumes `cpuMemoryPolling` / `cpuMemoryTimeoutMs` / `cpuMemoryCredentialId` / `cpuMemoryMibId` and `collectHardwareSensors` consumes `temperaturePolling` / `temperatureTimeoutMs` / `temperatureCredentialId` / `temperatureMibId`, each opening its own SNMP session or FortiOS REST call. `runTelemetryFor` runs both in parallel each telemetry tick — they still share the telemetry cadence trigger (`cpuMemoryIntervalSeconds`); an independent `temperatureIntervalSeconds` timer is a future follow-up.
- **systemInfoIntervalSeconds linkage to integration.pollInterval:** when the integration tier doesn't explicitly set this field, `loadIntegrationTierSettings` derives the cadence from `integration.pollInterval × 3600` and stamps `tierSystemInfoFromPollIntervalCache.set(integrationId, true)`. `resolveMonitorSettingsWithProvenance` reads that sidecar cache and labels the field's provenance `"integrationPollInterval"` (the fifth ProvenanceTier value). Cache invalidation clears the sidecar alongside `tierCache`. Manual-tier orphan assets are not eligible — they fall through to the hardcoded floor. Both halves of the linkage must move together: changing the resolver without bumping the migration job (`migrateSystemInfoCadenceLinkage`) leaves existing 600s defaults frozen; changing the migration job without the resolver derivation leaves nulls that revert to the floor.
- **Five-state machine:** unknown → (cs≥threshold) recovering, (cf≥threshold) warning; recovering → (cs≥threshold) up, (cf≥threshold) down; up → (cf=1) warning, (cf≥threshold) down; warning → (cs≥threshold) up, (cf≥threshold) down; down → (cs=1) recovering, stay down.
- **Heavy-cadence suppression:** telemetry/systemInfo/fastFiltered run only when `monitorStatus === "up"`; all other states suppress to avoid unreliable samples.
- **Per-transport dispatch:** probes dispatch on polling method (rest_api → probeFortinet/probeFortinetController; snmp → probeSnmp; winrm → probeWinRm; ssh → probeSsh; icmp → probeIcmp). REST API probes to `/api/v2/monitor/system/status`; SNMP probes `sysUpTime` OID.
- **Per-host SNMP gate:** every SNMP path (probeSnmp + the `withSnmpSession` helper that fronts collectTelemetrySnmp / collectSystemInfoSnmp / collectLldpNeighborsSnmp / operator snmpWalkRaw) acquires a per-`host:port` FIFO lock so probe and heavy walks don't overlap on a single-threaded agent. Without it, a 10-min systemInfo IF-MIB+LLDP walk pins the agent and the cheap sysUpTime probe stretches from <50ms to 3-5 s (often past the probe timeout → reads as packet loss). Keyed on host:port not assetId so two assets sharing one SNMP target don't collide. FortiOS REST and FMG calls aren't routed through this gate — they have their own concurrency models. **probeSnmp resets `start = performance.now()` inside the gate's callback** so the reported `responseTimeMs` reflects only the device round-trip, not the FIFO wait behind a concurrent walk — otherwise probes queued behind a 20 s fastFiltered IF-MIB walk reported as ~20 s on the chart, producing a perfect zig-zag against the bare-probe ~2 ms samples.
- **vendorTelemetryProfiles + oidRegistry consumers:** collectTelemetry/collectHardwareSensors/collectSystemInfo/collectLldpOnlySnmp call `pickVendorProfile()` and `resolveOidSync()` for SNMP walks; boot calls `ensureRegistryLoaded()` for warm cache.
- **Credential fallback chain:** asset-level credential → integration-stored token/SNMP → inherited from FMG on FMG-discovered firewalls.
- **Sample writes are async-buffered, status writes are synchronous.** The six append-only sample tables (asset_monitor / asset_telemetry / asset_hardware_sensor / asset_interface / asset_storage / asset_ipsec_tunnel) go through `sampleWriteBuffer.enqueue*` and flush every 2 s. `Asset.update` for `monitorStatus` / counters / `last*At` and the per-asset `$transaction` for `assetAssociatedIp` and `persistLldpNeighbors` stay synchronous because they need read-modify-write or per-asset replace semantics that an append-only buffer can't provide. Future contributors adding a new cadence must NOT batch the asset.update — the state machine reads counters then writes new ones, and batching would break that. **These synchronous system-info persists are wrapped in `retryOnDeadlock`** (the `assetAssociatedIp` delete+insert `$transaction`, the LLDP/wireless `deleteMany`s, and the wireless endpoint-stamp `$transaction` that updates OTHER assets' `lastSeenAp`). They can lose a 40P01 deadlock against a concurrent system-info pass or the probe-patch bulk `Asset` UPDATE; the bulk LLDP/wireless upserts were already retried, but these were not, and the loser crashed the entire scrape (`runSystemInfoFor` → "System info collection crashed", ~126/day observed on the split-role monitor). Each op is idempotent (full-replace / last-write-wins) so re-run on deadlock is safe. **The wireless endpoint-stamp updates are additionally sorted by asset id** so every concurrent endpoint-stamp `$transaction` acquires its `assets` row locks in the same order — the PG deadlock log showed a 3-way cycle whose three participants were ALL exactly this `lastSeenAp` UPDATE (APs with overlapping matched-endpoint sets locking in different Map-insertion order). Ordering makes that cycle impossible; retryOnDeadlock is the backstop for any residual cross-path collision (e.g. vs the probe-patch bulk Asset UPDATE).
- **One Asset findUnique per probe.** `probeAsset(assetId, out?)` populates `out.snapshot` with the asset row it already loaded (with credential + integration includes). `recordProbeResult(assetId, result, preloadedAsset?)` accepts that snapshot to skip its own findUnique. Hot-path callers (runProbeFor) pass the out-object; the operator /probe-now route doesn't bother and pays the extra read.
- **FortiLink LLDP exclusion (`config.excludeFortilinkLldp`, default off).** The system-info dispatch (`resolveAndCollectSystemInfo`) drops `data.lldpNeighbors` whose `localIfName` is a FortiLink interface before returning, when the owning integration's toggle is on. FortiGate firewalls only (`isFortinetSrc && !isManagedSwitchOrAp`). The FortiLink set is authoritative from the CMDB `fortilink` flag via the pure `fortilinkInterfaceNamesFromCmdb` (fortilink-flagged interfaces + their member ports). The REST-interfaces path reuses CMDB already fetched in `collectSystemInfoFortinet` (`SystemInfoSample.fortilinkInterfaces`, always `[]`+ on the REST path); the SNMP-interfaces path leaves it `undefined` and the dispatch makes one gated CMDB call (`fetchFortilinkInterfaceSet`) only when the toggle is on — `undefined` vs `[]` is the signal for which path ran. Added to BOTH `FortiManagerConfigSchema` + `FortiGateConfigSchema` (parity) and read in the create + FMG/FortiGate-edit `monitorSettingsFormHTML` opts → rendered as a checkbox on the FortiGate LLDP stream subtab (`public/js/integrations.js`, `_readExcludeFortilinkLldpToggle`). Peer-inferred FortiLink rows (`peerInferredLldpService`) are unaffected.
- **LLDP asset match index is module-cached.** `persistLldpNeighbors` reads through `getLldpAssetMatchIndex()` which caches the index for 60 s and dedupes concurrent rebuilders via an inflight Promise. Stale-cache risk is one cycle of "LLDP neighbor matched to wrong asset" — self-corrects on next scrape. Discovery code that bulk-renames assets / rotates IPs / mass-MAC-edits can call `invalidateLldpMatchCache()` before its next sync if it wants the immediate refresh; the 60 s TTL is the safety net otherwise.
- **FortiSwitch port-VLAN overlay.** In the SNMP systemInfo path on `assetType="switch"` assets with a Fortinet source AND a resolvable `controllerFortigate`, `collectSystemInfo` calls `fetchFortiswitchControllerPortsCmdb(integration, controllerName, timeoutMs)` after `collectSystemInfoSnmp` lands and overlays per-port `nativeVlan` + `taggedVlans` + `trunksAllVlans` onto matching `InterfaceSample` rows by ifName == port-name. Fetcher hits `/api/v2/cmdb/switch-controller/managed-switch?datasource=1` once per (integration, controller) per 30 s (`fortiswitchControllerPortsCache` mirrors `fortinetControllerCache` TTL). Tagged set computed as `allowed-vlans − untagged-vlans`; the parser (`parseFortiosVlanList`) handles all three FortiOS shapes (array of `{vlan-id}` objects, raw number array, comma+range string) and drops `"all"` since "every VLAN" can't be a finite int list. Trunk-all detection reads `port["allowed-vlans-all"]` via `fortiosBool` (newer FortiOS) and falls back to the string sentinel `"all"` in `allowed-vlans` (older versions) — `trunksAllVlans=true` is a third state distinct from access (`taggedVlans=[]`) and explicit-list trunk (`taggedVlans=[10,20]`). Best-effort — overlay failure leaves all three fields at defaults (null/[]/false) and the interface scrape proceeds. Strictly additive; not wired for FortiGates, FortiAPs, or non-Fortinet SNMP switches in v1.
  - **Trunk-member overlay (same fetch).** `fetchFortiswitchControllerPortsCmdb` returns a per-switch `{ vlanByPort, trunkMembers }` object — the `ports[]` loop also records a `trunkName → memberPorts[]` map (any port entry whose `members`/`member` field is non-empty IS a trunk; parsed by `parseFortiosMemberList`, permissive across object/string/CSV shapes). `overlayFortiswitchTrunkMembers(interfaces, trunkMembers)` then stamps `ifParent=<trunk>` + `ifType="physical"` onto each member's `InterfaceSample` (synthesizing the row when SNMP IF-MIB omitted the subordinate port — same pattern as the FortiGate aggregate back-fill in `collectSystemInfoFortinet`) and marks the trunk row `ifType="aggregate"` (only when its type was null/physical — never clobbers a real aggregate type). **Why:** the FortiLink uplink trunk is auto-named after the switch serial; without the parent/member linkage, `interfaceTopologyService.preferPhysical` and `map.ts`'s `ifDetail` swap can't resolve it to the physical port (`port52`) and the Device Map FortiLink tooltip shows the opaque serial. **CAVEAT:** the exact CMDB member field/shape wants confirmation on a live FortiOS 7.x device (same posture as the SD-WAN collector) — the parser + overlay degrade silently to "no trunk resolved" on an unexpected shape, so a wrong guess never breaks the VLAN overlay or the interface scrape. Pure functions `parseFortiosMemberList` + `overlayFortiswitchTrunkMembers` are exported and unit-tested in `tests/unit/fortiswitchTrunkMembers.test.ts`.

**When changing this:**
- Audit state-machine transitions and verify no edge cases leave assets in phantom states (esp. recovery threshold tuning).
- Update the resolver's tier caches if any integration/manual/override schema changes.
- If adding/removing transport probes, update `pollingCompatibility.ts` matrix and route validation in `monitorSettings.ts`.
- Verify `dropChunks()` calls before sample deletion align with active retention tiers.
- Test supervisor isolation: probe tick (5s) must not block heavy tick (30s) via `runningProbe`/`runningHeavy` guards.

---

## services/oidRegistry.ts

**What it owns:** Per-asset scoped OID symbol resolution from MIBs (device → vendor → generic → seed), layered SCOPED symbol caching with per-symbol provenance, and lazy cache warmup at app startup. Also exports the low-level building blocks (`BUILT_IN_OIDS`, `parseObjectAssignments`, `tryResolveParts`) that `stdMibLibrary.ts` re-uses to resolve std MIBs against the seed only — no DB layering.

**Public API:** `resolveOid`, `resolveOidSync`, `ensureRegistryLoaded`, `refreshRegistry`, `resolveSymbolAtVendorScope`, `listModelOverrides`, `getMibSymbolCount`, `resolveSymbolsForMib`, `resolveSymbolForMib`, `parseObjectAssignments`, `tryResolveParts`, `BUILT_IN_OIDS`, `ResolveScope`, `SymbolStatus`.

**Cross-service deps:** `mibService` (via import in mibService for refreshRegistry calls), `mibParserUtils` (stripComments).

**Used by:** `src/app.ts — startup warmup`, `src/services/monitoringService.ts — telemetry probe resolution`, `src/services/mibService.ts — profile status introspection`, `src/api/routes/mibs.ts — Browse modal OID resolution + MIB-aware walk symbol → numeric OID lookup`, `src/services/stdMibLibrary.ts — std MIB symbol resolution against the seed`.

**Invariants:**
- Resolution is scoped per (manufacturer, model) tuple; both cached and layer-resolved case-insensitively.
- Cache rebuilt entirely on any `refreshRegistry()` call (no partial updates).
- Built-in seed (BUILT_IN_OIDS) always acts as final fallback; vendor OIDs override generic MIBs.
- Seed currently covers Cisco / Juniper / HP-Aruba / Dell-RADLAN / Fortinet FortiGate / FortiSwitch / FortiAP — each vendor seed includes the vendor-specific telemetry symbols (CPU / memory and, where applicable, disk / temperature) so probes work without uploading the proprietary MIB.
- `resolveOidSync()` returns null until `ensureRegistryLoaded()` has completed and the scope has been accessed.
- `tryResolveParts` accepts three token shapes per OID part: pure integers (`"42"`), known symbols (looked up in the seed/scope map), and **ASN.1 named-number syntax** (`name(digit)` → uses the digit). The named-number form is required by LLDP-MIB's root anchor `{ iso std(0) iso8802(8802) ieee802dot1(1) ieee802dot1mibs(1) 2 }` and benefits any uploaded vendor MIB that uses the same idiom. Strict additive change — strings the legacy code resolved still resolve identically.

**When changing this:**
- Add coverage to BUILT_IN_OIDS if new standard SMI roots or vendor enterprise prefixes are needed.
- Test scope layering with overlapping (manufacturer, model) MIBs to verify override order.
- Verify cache key normalization (case-insensitive) handles mixed-case manufacturer input correctly.
- Run `resolveSymbolAtVendorScope()` after updates to confirm vendor-floor symbol availability.
- Profile performance: cache rebuild is O(mibs × entries × resolution-passes); log timings on large uploads.
- Any change to `tryResolveParts` token-handling must keep `tests/unit/stdMibLibrary.test.ts` "resolves LLDP-MIB through ASN.1 named-number syntax" green AND not regress the 102 cases in `tests/unit/mibParseStructured.test.ts`.

---

## services/stdMibLibrary.ts

**What it owns:** Browse-tree + MIB-aware walk for the seven bundled standard MIBs (SNMPv2-MIB, IF-MIB, HOST-RESOURCES-MIB, ENTITY-MIB, ENTITY-SENSOR-MIB, LLDP-MIB; IF-MIB backs both `std:interfaces` and `std:if-ext`). Read-only — std MIBs are immutable at runtime. Loads text files from `src/services/stdMibs/<MODULE>.txt` lazily on first request via `parseMibStructured`, resolves every symbol's `fullOid` against the BUILT_IN_OIDS seed only (no DB MIB layering), and caches the result module-level for the process lifetime.

**Public API:** `STD_MIBS`, `StdMibDef`, `listStdMibs`, `getStdMibDef`, `getStdMibStructure`, `resolveStdSymbol`.

**Cross-service deps:** `mibService` (parseMibStructured, types), `oidRegistry` (BUILT_IN_OIDS, parseObjectAssignments, tryResolveParts).

**Used by:** `src/api/routes/mibs.ts — GET /std, GET /std/:key/structure, POST /std/:key/walk routes`.

**Invariants:**
- The 7 dropdown keys (`std:system`, `std:interfaces`, `std:if-ext`, `std:host-resources`, `std:entity`, `std:entity-sensor`, `std:lldp`) are owned in BOTH the backend `STD_MIBS` constant AND the frontend `_SNMP_STANDARD_MIBS` constant in `public/js/assets.js`. The frontend hardcodes the dropdown today; `GET /std` is for tooling parity. Adding/removing/renaming a std key requires updating both lists in lockstep + the bundled text file in `stdMibs/` + the `EXPECTED` table in `scripts/smoke-std-mibs.ts` + `tests/unit/stdMibLibrary.test.ts`.
- `parseObjectAssignments` (re-imported from `oidRegistry`) is the canonical extractor — the structured parser drops some `OBJECT IDENTIFIER` shorthand assignments that the regex resolver picks up. The std resolver calls both extractors and intersects: structured parse for the displayed symbol tree; raw assignments for OID resolution.
- Cache is permanent (process lifetime). No invalidation API — files change only via redeploy.
- The `.txt` files are read at runtime relative to the COMPILED module location (`STD_MIBS_DIR` = `dirname(import.meta.url)/stdMibs`), i.e. `dist/services/stdMibs/` in a built install. `tsc` does NOT copy them — `scripts/copy-build-assets.mjs` (the second half of `npm run build`) mirrors them into `dist/`. A new `.txt` dropped in `stdMibs/` is auto-covered (the copy globs `*.txt`), but if you ever read a non-`.txt` asset from here, add its extension to that script. Dev (`npm run dev` via tsx) reads from `src/`, so a missing-from-`dist/` regression is invisible until you ship — see `cross-cutting/deployment`.
- Bundle refresh is operator-initiated via `node scripts/fetch-std-mibs.mjs` which writes SHA-256 + source URL into `stdMibs/SOURCES.md`. Commit the regenerated text files + SOURCES.md together so the audit trail stays in sync.

**When changing this:**
- Run `npx tsx scripts/smoke-std-mibs.ts` to verify all 27 spot-checks still pass.
- Run `npx vitest run tests/unit/stdMibLibrary.test.ts` for the formal 17 cases (includes a guard that every declared std MIB `.txt` exists on disk).
- If adding a new std MIB: extend `STD_MIBS`, drop the text file in `stdMibs/`, add it to `MIBS` in `scripts/fetch-std-mibs.mjs`, add 2-4 spot-checks to `EXPECTED` in the smoke script, add at least one resolved-OID assertion to the unit test, and add the matching `{ id, label, oid }` entry to `_SNMP_STANDARD_MIBS` in `public/js/assets.js`.
- The IEEE LLDP-MIB carries an IEEE copyright header (preserved verbatim in the file). Re-read the header text on every refresh per Rogers Group's "legal/compliance language requires human review" policy.

---

## services/ouiService.ts

**What it owns:** IEEE OUI database download and CSV parsing; lazy in-memory lookup map; admin-editable overrides (prefix → manufacturer+device); cache persistence via Setting table.

**Public API:** lookupOui, lookupOuiBatch, lookupOuiOverride, refreshOuiDatabase, getOuiStatus, OuiOverride, getOuiOverrides, setOuiOverride, deleteOuiOverride.

**Used by:**
- src/api/routes/assets.ts — GET /assets/:id, look up MAC OUI (vendor name)
- src/api/routes/integrations.ts — POST /integrations/discover, tag assets with vendor during discovery
- src/api/routes/serverSettings.ts — GET/PUT /server-settings/oui, CRUD overrides + trigger refresh
- src/jobs/ouiRefresh.ts — Weekly cron job, refresh database and log entries/size

**Invariants:**
- IEEE database is downloaded from standards-oui.ieee.org/oui/oui.csv; stored as JSON in Setting table; loaded on-demand into module-level in-memory map (singleton pattern, reset only on refresh).
- Prefix format: "AABBCC" (6 hex chars); input normalization handles colon/dash/mixed-case (AA:BB:CC, aa-bb-cc, etc.).
- Overrides take priority over IEEE DB; back-compat layer supports legacy bare-string overrides (migrate to {manufacturer, device?} shape on load).
- lookupOuiBatch() avoids repeated DB reads; used by discovery to tag multiple assets in one pass.
- refreshOuiDatabase() runs at startup (skip if <6 days old) and weekly; on 30s HTTP timeout, entire refresh fails (not incremental).

**When changing this:**
- Test MAC normalization (colon/dash/mixed-case input) and prefix extraction.
- Verify override priority (override lookup before IEEE DB).
- Test batch lookup (multiple MACs in one call).
- Check CSV parser for quoted fields (commas inside quotes should not split).
- Ensure refresh doesn't block startup; use timeout so network failures don't hang boot.

---

## services/peerInferredLldpService.ts

**What it owns:** Read-time supplementation of the persisted `AssetLldpNeighbor` set with neighbor rows synthesized from `Asset.fortinetTopology` so the System tab Neighbor column reflects topology Polaris already knows about (most importantly: managed FortiAPs that the FortiSwitch's SNMP LLDP-MIB silently consumes without re-publishing).

**Public API:** `buildInferredNeighborsForAsset(assetId)`, `dedupeInferredNeighbors(real, inferred, aggregateParentByMember?)`, `aggregateMembershipMap(interfaces)`, `InferredLldpNeighbor`.

**Cross-service deps:** Reads `Asset` rows + `fortinetTopology` JSON via Prisma. The FortiAP branch additionally reads recent `AssetInterfaceSample` rows for the AP itself and passes them through `src/utils/fortiapInterfaceAlias.ts:normalizeFortiapInterfaceName` so the synthesized `localIfName` matches the AP's SNMP-canonical naming (`eth0`) rather than discovery's FortiAP-CLI form (`lan1`).

**Used by:**
- `src/api/routes/assets.ts` — `GET /assets/:id/system-info` (merges into `lldpNeighbors` response array)
- `src/api/routes/assets.ts` — `GET /assets/:id/interface-history` (filters inferred set to the requested ifName, then merges; fetches all real LLDP rows for the asset — not just the requested ifName — so a member-port row can suppress an aggregate's inferred row, and loads the latest full interface snapshot via `lastSystemInfoAt` for the membership map)

**Invariants:**
- Never writes the `AssetLldpNeighbor` table; rows exist only in the HTTP response body.
- Synthesized rows always carry `source: "peer-inferred"` so callers + the UI can distinguish them.
- Three synthesis branches:
  - Asset is `switch` → APs where `fortinetTopology.parentSwitch === self.hostname`; emit on the AP's `parentPort`.
  - Asset is `firewall` → switches where `fortinetTopology.controllerFortigate === self.hostname`; emit on the switch's `uplinkInterface` (FortiGate-side interface name from `fgt_peer_intf_name`).
  - Asset is `access_point` → if `self.fortinetTopology.parentSwitch` + `uplinkInterface` both set, resolve the switch by hostname and emit on the AP's local port normalized via `normalizeFortiapInterfaceName` against the AP's known SNMP ifNames (prefers `eth0` form when present so the inferred row lines up with the System tab's interface table).
- Direct-attached FortiAPs (controllerFortigate set, no parentSwitch) are intentionally skipped — `uplinkInterface` on an AP is the AP's own port, not the FortiGate's, so we can't pin the row to a FortiGate interface.
- Skip on missing data: empty self hostname → return []; missing `parentPort` / `uplinkInterface` on the peer side → skip that row.
- Dedup rule (applied by callers via `dedupeInferredNeighbors`): drop inferred row when a real LLDP row exists on the same `(localIfName, matchedAssetId)`. Real LLDP wins. A real row with no `matchedAsset.id` does NOT suppress inferred rows. **Aggregate-aware:** when callers pass an `aggregateParentByMember` map (member ifName → parent aggregate ifName, built by `aggregateMembershipMap(interfaces)`), a real row learned on an aggregate's *member* port also suppresses an inferred row emitted on the *aggregate* itself — the FortiLink case, where the FortiGate→FortiSwitch uplink is synthesized on `fortilink` but the real LLDP lands on physical member `a`. The map includes only members whose parent's `ifType === "aggregate"` (VLAN sub-interfaces, which also carry `ifParent`, are excluded).
- Hostname comparison is case-exact (Prisma `path: ["..."], equals: ...`) — matches what `connectionPathService` does. FortiOS-sourced hostnames are consistent across the surfaces Polaris discovers.
- `firstSeen` and `lastSeen` are stamped at request time — they're not persistent state, just shaped to match the real-row contract.

**When changing this:**
- Verify the three asset-type branches still cover the topology shapes you care about. If FortiAP direct-attached attribution becomes resolvable (e.g. a future discovery enhancement captures the FortiGate's physical port for direct APs), add the fourth branch and update the "intentionally skipped" docstring.
- Don't add upsert/cache layers without measuring — at branch-class fleet sizes (~2000 assets total, ~50 APs per site) the per-request findMany is sub-100ms and the cache invalidation surface isn't worth it.
- The dedup rule lives in the route handler, not the service. If you call from a new route, remember to merge with `dedupeInferredNeighbors(real, inferred, aggregateMembershipMap(interfaces))` before serializing — pass the membership map (and the asset's full real-LLDP set, not just the per-interface slice) or aggregate/member duplicates leak through.

---

## services/projectionDriftService.ts

**What it owns:** Best-effort fire-and-forget shadow drift detection after successful AssetSource upserts; logs disagreements only (observability, no behavior change).

**Public API:** `detectAndLogDrift(assetId, integrationKind)`

**Cross-service deps:** None (uses `projectAssetFromSources()` utility + pino logger).

**Used by:** (Not yet called; Phase 3b shadow phase pending Phase 3b.1 actual write implementation)

**Invariants:**
- Fire-and-forget: any internal error is swallowed via `logger.warn()`; drift detection failures must never break the Asset write.
- Drift is asymmetric: projection has X ≠ Y on asset → logged; projection has X, asset null → logged; projection null → silent (no comment = no disagreement).
- Logs to pino with `event: "asset.projection.drift"` (NOT audit Event table); high volume during full sweeps, operators grep app logs.
- Compared fields: hostname, serialNumber, manufacturer, model, os, osVersion, learnedLocation, ipAddress, latitude, longitude (match `ProjectedAsset` keys).
- Logs include `assetId, integrationKind, drifts[]` with per-field projected/current/winningSource provenance.

**When changing this:**
- Sync `PROJECTED_FIELDS` list against `ProjectedAsset` interface additions (assetProjection.ts).
- If projection rules change in `projectAssetFromSources()`, review which drifts are expected (e.g. hostname tiebreak logic).
- Check pino logger setup in `src/utils/logger.ts` for structured field compatibility.
- Once Phase 3b.1 write is implemented, wire `detectAndLogDrift()` into the post-upsert callback in discovery sync paths.

---

## services/queueService.ts

**What it owns:** Monitor work queue mode dispatch (cursor vs. pg-boss) and pg-boss runtime lifecycle. Boot-time mode capture ensures the running process's queue strategy is frozen at startup despite subsequent Setting writes.

**Public API:** `detectPgboss`, `isPgbossInstalled`, `getQueueMode`, `setQueueMode`, `getBootTimeMode`, `initializeQueue`, `startPgbossWorkers`, `stopPgbossWorkers`, `isPgbossRunning`, `publishMonitorJob`, `QUEUE_NAMES`, `QueueMode`.

**Cross-service deps:** `monitoringService.ts`.

**Used by:** `src/app.ts` — queue initialization and pg-boss worker lifecycle; `src/jobs/monitorAssets.ts` — queue mode dispatch and job publishing; `src/api/routes/serverSettings.ts` — queue mode write; `src/services/capacityService.ts` — capacity snapshot input (queue mode + pg-boss status).

**Invariants:**
- **Boot-time mode capture:** mode read once at startup into `bootTimeMode`; `setQueueMode()` updates Setting + cache but never affects running process. New mode takes effect on next restart only.
- **Six queue names (Phase 2):** `polaris-monitor-probe`, `polaris-monitor-fastfiltered`, `polaris-monitor-telemetry`, `polaris-monitor-systeminfo`, `polaris-monitor-lldp`, `polaris-monitor-storage` (jobs prefixed `polaris-monitor-*`). LLDP and Storage each get their own dedicated worker pool (default 12 workers, env `POLARIS_MONITOR_LLDP_WORKERS` / `POLARIS_MONITOR_STORAGE_WORKERS`) running `runLldpFor` / `runStorageFor` from monitoringService. Floating priority order: probe > fastFiltered > lldp > storage > telemetry > systemInfo. The publisher in `monitorAssets.ts` gates LLDP/Storage on `Asset.lastLldpAt + lldpIntervalSeconds` / `Asset.lastStorageAt + storageIntervalSeconds`; the legacy `collectSystemInfo` still walks both as session-coalesced side effects on the same SNMP session and the persist paths are idempotent against double-walks.
- **Stalled-worker watchdog:** monitors pgboss.job for >50 created jobs with 0 active; auto-recovers up to 3 times per hour; logs every minute after cap hit.
- **Singleton job policy:** queues are created with `policy: "singleton"` + `singletonKey: ${assetId}:${cadence}` on publish so duplicate `(assetId, cadence)` sends are absorbed while a job is queued or active. `publishDueWork()` can fire every tick without piling stale work, and distinct assetIds run in parallel up to `localConcurrency`. (An earlier iteration passed `policy: "exclusive"` here, which is not a documented pg-boss policy and silently capped each queue to ~1 active job globally regardless of `localConcurrency` — turning a 16-worker pool into a serial consumer and diluting effective probe/telemetry cadence by 10×+ on large fleets. If you see queue depth sustained in the hundreds with active count stuck at 1-2, check this value first.)
- **Two pools per queue:** dedicated `boss.work()` subscriptions own a flat 24 slots per queue (env `POLARIS_MONITOR_PROBE_WORKERS` / `_FAST_WORKERS` / `_HEAVY_WORKERS`); a single floating loop (`startFloatingWorkers`, default 32 via `POLARIS_MONITOR_FLOATING_WORKERS`) polls all four queues in `FLOAT_PRIORITY` order via `boss.fetch()` and dispatches manually with `boss.complete(name, id)` / `boss.fail(name, id, ...)`. Floating capacity flows to whichever queue has backlog. Singleton-key dedup at the publish layer prevents floating ↔ dedicated collisions on the same `(assetId, cadence)`. The loop is shut down via `floatingLoopRunning = false` in both `stopPgbossWorkers` and the auto-recovery path BEFORE calling `boss.stop()` so it doesn't try to fetch against a dead boss instance.
- **Per-queue handler timeout (`EXPIRE_BY_QUEUE`):** pg-boss kills handlers that exceed `expireInSeconds` with `handler execution exceeded Ns` and marks them failed before the in-handler try/catch can stamp an error. The values are sized per cadence to the worst-case real work — probe 30s (single network call), fastFiltered 60s (one collector round-trip), telemetry 180s (SNMP CPU/mem/sensor walks), systemInfo 300s (full interface + storage + IPsec + LLDP walk). A uniform 60s cap was killing telemetry/systemInfo jobs mid-walk on slow SNMP devices, producing queue backlog that workers couldn't drain (every kill re-published the job on the next tick, looking like worker shortage when actually each slot was burning 60s per zombie). Raising the cap doesn't add parallelism — it reduces it by letting slow jobs finish on the first attempt instead of cycling through worker slots.

**When changing this:**
- Verify boot initialization runs before monitor ticks fire (happens in `app.ts` startup order).
- If tuning worker counts, check `POLARIS_MONITOR_*_WORKERS` env vars align with concurrency in `monitorAssets.ts`.
- Test pg-boss fallback to cursor when extension/role permissions fail silently.
- Ensure graceful pg-boss shutdown on SIGTERM drains in-flight jobs before process exit.

---

## services/reservationPushService.ts

**What it owns:** DHCP reserved-address push/unpush to FortiGate via FMG proxy or direct REST.

**Public API:** normalizeMac, pushReservation, updatePushedReservation, unpushReservation, releaseDhcpLease, plus the transport helpers `buildTransportForIntegration` / `findScopeIdForCidr` / `listReservedAddresses` / `callFortiOs` (+ types `Transport`, `FortiOsReservedAddress`) exported so peer services can reuse the same FMG-proxy / direct-FortiGate dispatcher for read-only single-scope work.

**Cross-service deps:** fortigateService (fgRequest), fortimanagerService (fmgProxyRest, resolveDeviceMgmtIpViaFmg).

**Used by:** src/services/reservationService.ts (pushReservation on create, unpushReservation on release, releaseDhcpLease on dhcp_lease release); src/services/subnetRefreshService.ts (read-only per-subnet refresh consumes the transport helpers).

**Invariants:**
- MAC address must be 48-bit (normalized to xx:xx:xx:xx:xx:xx)
- Transport selection: useProxy=true → FMG proxy, useProxy=false → direct FortiGate REST
- Direct mode requires fortigateApiToken + mgmtInterface on integration config
- Scope resolution by matching gateway+netmask or ip-range start-ip
- Verify-by-readback mandatory; failure throws AppError (triggers reservation rollback)
- Description format: "Polaris/<user>: <hostname>" or "Polaris: <hostname>"
- Lease release (releaseDhcpLease) uses /api/v2/monitor/system/dhcp/release-lease (best-effort, no rollback)

**When changing this:**
- Test both FMG proxy and direct modes with actual FortiOS DHCP server configs
- Verify MAC normalization handles all separators (colons, dashes, dots, none)
- Check scope resolution fallbacks (gateway+netmask, then ip-range)
- Test verify-by-readback on slow devices (echoed id missing, need IP+MAC lookup)

---

## services/reservationService.ts

**What it owns:** Reservation creation, updates, release, expiry, and DHCP push orchestration.

**Public API:** listReservations, getReservation, createReservation, updateReservation, releaseReservation, nextAvailableReservation, expireStaleReservations.

**Cross-service deps:** reservationPushService (pushReservation, updatePushedReservation, unpushReservation, releaseDhcpLease, normalizeMac).

**Used by:** src/api/routes/reservations.ts (all CRUD + next-available), src/jobs/expireReservations.ts (expireStaleReservations every 15 min).

**Invariants:**
- MAC address required when push eligible (subnet discovered by FMG/FortiGate with pushReservations=true)
- Full-subnet reservation (ipAddress=null) → subnet.status = "reserved"; per-IP → remains available
- No duplicate active reservations (unique constraint on subnetId, ipAddress, status="active")
- Subnet must not be deprecated (409 if status="deprecated")
- Push failure rolls back the Polaris reservation (fail-on-failure semantics)
- `listReservations` decorates every row with `pushEligible: boolean` (true when integration is fortimanager/fortigate AND `config.pushReservations === true` AND `ipAddress` is non-null) and strips the raw integration config from the response — callers only need the flag and config can carry credentials. Mobile reservations-tab reads this to color the Reserve button green.
- updateReservation accepts an optional `macAddress`; on push-eligible subnets a MAC change pushes a PUT to the FortiGate via reservationPushService.updatePushedReservation BEFORE the Polaris write — device-side failure throws and Polaris stays untouched. Clearing the MAC on a push-eligible subnet is rejected with 400 (DHCP reservations are MAC→IP).
- updateReservation auto-stamps `owner = caller.username` when `input.owner === undefined`. Pairs with the discovery sync's MAC-aware owner-preservation rule in `integrations.ts` `syncDhcpSubnets` Phase 6 — discovery only overwrites owner with `asset.assignedTo` when the discovered MAC differs from `reservation.macAddress`, so a Polaris-stamped owner survives across discovery cycles for stable reservations.
- Released reservations clear pushedTo* fields and drop historical released rows (unique constraint relief)
- `expireStaleReservations` applies the SAME unique-constraint relief for `expired`: inside one `$transaction` it first DELETEs (set-based `DELETE…USING` self-join) any stale `expired` row sharing (subnetId, ipAddress) with an active row about to expire, THEN runs the active→expired `updateMany`. Without the pre-delete a reserve→expire→re-reserve→expire cycle leaves a colliding `expired` row, and since the flip is one bulk updateMany a single P2002 aborts the whole batch (job fails every 15 min, nothing expires). NULL ipAddress (full-subnet) never collides (NULL distinct) and is excluded by the `=` join.
- Discovered dhcp_lease release attempts bestEffort via releaseDhcpLease (failure does not block Polaris release)

**When changing this:**
- Test createReservation's push eligibility detection and MAC validation order
- Verify releaseReservation's transaction scope (unpush, lease release, subnet status reset)
- Check expireStaleReservations is called every 15 min via jobs/expireReservations.ts
- Audit the atomic create-and-push path for rollback edge cases (orphaned device entries)

---

## services/reservationStaleService.ts

**What it owns:** Stale DHCP-reservation detection, alerting, and alert management (snooze, ignore).

**Public API:** getStaleSettings, updateStaleSettings, listStaleReservations, snoozeReservation, setStaleIgnored, flagStaleReservations.

**Used by:** src/api/routes/reservations.ts (list/snooze/ignore endpoints), src/jobs/flagStaleReservations.ts (flagStaleReservations every 6 hours).

**Invariants:**
- Stale threshold (staleAfterDays) defaults to 60 days, 0 = disabled
- Cold-start grace: effective baseline = max(createdAt, detectionStartedAt) to avoid flooding on first run
- A row is stale if (lastSeenLeased < threshold OR never seen leased before) AND (threshold > 0)
- Snooze extends alert by staleAfterDays from now (not from threshold); clears staleNotifiedAt
- Ignored rows stay suppressed regardless of threshold; detectionStartedAt persists across runs
- flagStaleReservations emits one reservation.stale Event per fresh transition (staleNotifiedAt null → timestamp)
- Discovery clears staleNotifiedAt on re-sighting (re-arms alert for future silence)

**When changing this:**
- Verify staleAfterDays threshold propagates to all callers (threshold=0 should disable all alerts)
- Test cold-start grace window (rows pre-dating detectionStartedAt get full threshold window)
- Check flagStaleReservations only fires on active dhcp_reservation rows (not discovered dhcp_lease)
- Audit snooze idempotency: repeated snooze clicks should extend from "now" not from prior snooze

---

## services/dnsResolvedReservationService.ts

**What it owns:** Auto-creation, update, and release of `sourceType="dns_resolved"` Reservation rows that mirror Assets whose primary `ipAddress` isn't covered by an authoritative reservation. Plays no part in DHCP push, conflict raising, or asset writes themselves — strictly a downstream observer of the Asset table.

**Public API:** `reconcileDnsResolvedForAsset(assetId)`, `reconcileDnsResolvedForAllAssets()`, `releaseDnsResolvedForAsset(assetId)`, `releaseDnsResolvedAt(subnetId, ipAddress)`, `ReconcileResult` interface.

**Used by:** `src/db.ts` Prisma extension (per-asset reconcile on create/update/upsert; release on delete); `src/jobs/reconcileDnsResolvedReservations.ts` (periodic sweep); `src/api/routes/integrations.ts` `syncDhcpSubnets` + `registerFortinetHost` (inline `releaseDnsResolvedAt` before each authoritative create); `src/services/reservationService.ts:createReservation` (same inline release for manual creates).

**Invariants:**
- `sourceType="dns_resolved"` + `createdBy="system:dns-resolved"` is the system-actor signature — both are required to identify a row as system-owned.
- Identity match for "is this asset's existing row?" = `createdBy=SYSTEM_ACTOR AND sourceType=dns_resolved AND status=active AND (macAddress=asset.macAddress OR hostname=asset.hostname)`. Reservation has no `assetId` FK so this is the proxy.
- Eligible asset statuses: `active | maintenance | storage | quarantined`. `decommissioned | disabled` always release-without-creating.
- IPv4 only (gated by `detectIpVersion(ip) === "v4"`).
- Defers silently to ANY non-released non-dns_resolved active reservation at the same `(subnetId, ipAddress)`. Never raises a Conflict.
- Never pushes to FortiGate — writes go through `prisma.reservation.create` directly, not `reservationService.createReservation`.
- All public functions are best-effort: they log at warn and never throw out of the public surface so a transient DB error can't break the asset write that called them.
- Events emitted: `reservation.dns_resolved.created`, `reservation.dns_resolved.updated`, `reservation.dns_resolved.released` (info level).

**When changing this:**
- Adding a new authoritative `sourceType`? Add a `releaseDnsResolvedAt(subnetId, ip)` call in `integrations.ts` next to the new create, and (if it can be created from the manual UI) in `reservationService.createReservation`. The activeResMap exclusion already covers the discovery read path.
- Adding a new column to the eligibility check? Update `assetEligible()` and ensure the periodic job's `findMany` scope still surfaces rows that need release-without-create. The job intentionally scans even ineligible-by-status assets so they can release stale rows.
- Switching to a real `Reservation.assetId` FK? Replace `findOwnedSystemRows`'s identity-match SQL with a direct join, and the per-asset reconcile becomes trivially correct (no more "hostname or MAC" heuristic).
- Verify the unique-on-active constraint: create an authoritative reservation at an IP that has a dns_resolved row; the release MUST run before the create (the order matters — Postgres can't have two active rows at the same `(subnetId, ipAddress)`).
- Performance check at 2000 monitored assets: the periodic sweep should complete in seconds. If it slows, raise BATCH from 25; the inner work is one `findContainingSubnet` + one upsert per asset, both index-friendly.

---

## services/sampleWriteBuffer.ts

**What it owns:** Periodic batch-flush buffer for the six append-only monitor sample tables (asset_monitor_samples / asset_telemetry_samples / asset_hardware_sensor_samples / asset_interface_samples / asset_storage_samples / asset_ipsec_tunnel_samples). Collapses per-work-item `prisma.<table>.create*` calls into one `createMany` per 2 s flush window so the monitor hot loop stops eating DB pool capacity per probe.

**Public API:** `enqueueMonitorSample`, `enqueueTelemetrySample`, `enqueueHardwareSensorSamples`, `enqueueInterfaceSamples`, `enqueueStorageSamples`, `enqueueIpsecTunnelSamples`, `flushAllSampleBuffers`, `startSampleWriteBuffer`, `shutdownFlushSampleBuffers`, `FLUSH_INTERVAL_MS`, all six row-type interfaces.

**Cross-service deps:** `prisma` (db.js), `retryOnDeadlock` (utils/dbRetry.js), `startSampleWriteTimer` + `setSampleBufferDepth` (metrics.js), `logger` (utils/logger.js).

**Writers (the only callers of `enqueue*`):**
- `src/services/monitoringService.ts:recordProbeResult` — `enqueueMonitorSample` for the probe outcome row.
- `src/services/monitoringService.ts:recordTelemetryResult` — `enqueueTelemetrySample` (CPU/memory only).
- `src/services/monitoringService.ts:recordHardwareSensorResult` — `enqueueHardwareSensorSamples` (per-sensor; dispatched by the separate `collectHardwareSensors` call that `runTelemetryFor` issues in parallel with `collectTelemetry`).
- `src/services/monitoringService.ts:recordSystemInfoResult` — `enqueueInterfaceSamples`, `enqueueStorageSamples`, `enqueueIpsecTunnelSamples`. Also additively folds the MAC of each operator-pinned monitored interface into `AssetMacAddress` (source="monitor-interface") via `addMacAddresses` — additive-only, so unlike discovery's `reconcileMacAddresses` it never wipes rows owned by other sources, and discovery/agent reconciles (which hydrate-existing → merge) preserve it.
- `src/services/monitoringService.ts:recordFastFilteredResult` — same three as systemInfo, smaller subset (pinned interfaces only).
- `src/api/routes/agents.ts:POST /samples` — the Polaris Agent ingestion path: `enqueueMonitorSample` (responseTime, also via `recordProbeResult`), `enqueueTelemetrySample` + `enqueueHardwareSensorSamples` (telemetry), `enqueueInterfaceSamples`, `enqueueStorageSamples`. **This writer runs on the `web` role**, not monitor — which is why the web role must also run the flush tick (see Boot).

**Readers:** none directly. The sample tables are read by `assets.ts` route handlers (chart endpoints), `capacityService.ts` (sample-table breakdown), and Cytoscape topology builders — none of those see the buffer, only the persisted rows after a flush.

**Boot + shutdown:**
- `src/app.ts:startSampleWriteBuffer()` called once after queue init, gated on `cfg.runsWriteBuffers`. **That flag is true for BOTH `monitor` AND `web`** (and `all`) — monitor produces samples via probes, web produces them via the agent `/samples` + `/probe-now` ingestion. If web ever loses the flush tick (it did before this was fixed — `runsWriteBuffers` was monitor-only), agent-sourced rows pile up in the web process's in-memory buffer and only land on the next graceful shutdown flush, while `lastTelemetryAt` (a direct synchronous `Asset.update`, not buffered) stays misleadingly fresh.
- `src/app.ts` SIGTERM/SIGINT hook awaits `shutdownFlushSampleBuffers()` before `process.exit(0)` so a graceful restart drains the buffer — this is the ONLY thing that flushed agent samples while the web role lacked the tick.

**Invariants:**
- **Append-only.** No conflicts on createMany — every row is a fresh time-series sample with a synthetic UUID `id`. Don't try to add upsert/dedupe logic; if you need replace semantics, do it synchronously in the record function before enqueueing (cf. `persistLldpNeighbors`, which is NOT buffered for this reason).
- **Snapshot-on-flush.** `flushTable` splices the current array up front so concurrent enqueues during the awaited `createMany` land in a fresh array. On retry-exhausted failure the snapshot is re-prepended for the next tick.
- **Per-table flush guard.** `flushing[key]` prevents re-entry on the same table — a 2 s tick that fires while a slow flush is still mid-write becomes a no-op for that table, no concurrent writer per table.
- **Trade-off documented:** up to 2 s of sample rows lost on hard crash. Acceptable because samples are an append-only time series and the next cadence tick re-supplies. Asset-level state (status pill, counters, lastMonitorAt) is buffered separately by `src/services/probePatchBuffer.ts` with last-write-wins semantics — same 2 s window, different shape because state needs replace + read-your-writes, the append-only contract here doesn't fit.
- **Detail tier only.** This buffer covers the six SOURCE tables. The twelve `*_hourly` / `*_daily` rollup tables use INSERT...ON CONFLICT DO UPDATE from `sampleRollupService.ts` instead — rollup writes are inherently upsert (idempotent re-runs over the same window must rewrite buckets in place) and the append-only buffer contract has no upsert path.

**When changing this:**
- New sample table → add a `BufferKey`, an `enqueueXxx` helper, a `TABLE_LABEL` entry, and a `switch` arm in `writeBatch`. Touch the test file too — same shape.
- Flush interval change → consider both UI latency (samples take this long to appear on charts) and crash-window data loss. The current 2 s was the explicit operator choice.
- Don't add a `prisma.$transaction` here. `createMany` is one network round-trip already; wrapping it in a transaction just adds round-trips without giving us anything (each table is independent, no cross-table invariant).

---

## services/searchService.ts

**What it owns:** Global typeahead search across all domain entities, with input classification (IP/CIDR/MAC/text), whitespace/quoted-phrase tokenization into AND-combined terms, parallel entity-specific queries capped at 8 results per group, AND scope-prefix shortcuts (`block:`/`b:`, `network:`/`n:`, `asset:`/`a:`, `reservation:`/`r:`, `map:`/`m:`) that bypass the per-group cap.

**Public API:** `searchAll(rawQuery, allowed?)`, `SearchAllowed`, `normalizeMac`, `parseSearchTerms`.

**Cross-service deps:** none (uses cidr.js utils and prisma directly).

**Used by:** `src/api/routes/search.ts — GET /api/v1/search endpoint`. Total 1 call site. The route derives the optional `allowed` group map from the caller's role (`blocks`→ipBlocks, `subnets`→subnets, `reservations`→reservations, `assets`→assets, `sites`→deviceMap; `ips` needs subnets AND reservations) — denied groups return empty without running their query helpers, in both scoped and unscoped paths. Omitting `allowed` = all-allowed (historical behavior for non-route callers).

**Invariants:**
- **Multi-term AND** (`parseSearchTerms`): the post-scope-strip query is tokenized on whitespace, double-quoted runs kept whole (`"rogers group" metro` → two terms; a dangling opening quote swallows the rest as one phrase; quotes stripped, empty terms dropped). `searchAll` returns empty when zero terms survive. Every query helper builds `AND: terms.map(t => ({ OR: [cols…] }))` via the `andOfTerms(terms, cols)` helper, so a row must satisfy **every** term (each in at least one of its columns). A single term collapses to a one-element AND — byte-for-byte the pre-multi-term `OR`-of-columns behavior. **IP/CIDR/MAC classification, the `cidrExact`/`ipExact` exact-match boosts, and MAC normalization only fire for single-term queries** (`singleTerm = terms.length === 1`); multi-term is always plain text. In `runAssetSearch`, the side-table pathways (`externalId`/`mac`/`ip`) and the JSON-blob raw scan AND each term **within their single field/blob** (so cross-pathway AND — term A in hostname, term B in a side-table MAC — is not matched; the asset's own columns are the only cross-column AND). The JSON raw SQL builds its per-term ILIKE list with `Prisma.join(…, " AND ")` on each side of the UNION; `parseSearchTerms`'s non-empty guarantee keeps those `WHERE` fragments from going empty. The `<kind>:` source prefix is only stripped in single-term mode.
- MAC normalization (`normalizeMac`) handles any whitespace/colon/dash/dot separator (so `00:00:00:00:00:00`, `000000000000`, `00-00-00-00-00-00`, and Cisco `0000.0000.0000` all resolve); result is uppercase colon form. The DB match against a normalized MAC is **case-insensitive** (`{ equals, mode: "insensitive" }` on both `Asset.macAddress` and `AssetMacAddress.mac`) because stored MAC case is inconsistent — monitoring/FMG-CMDB paths uppercase, FMG endpoint-client discovery stores the device value verbatim (often lowercase).
- CIDR vs plain IP vs MAC classification is hierarchical: CIDR requires `/` with `/\d{1,2}$` pattern; IP uses `isValidIpAddress()` fallback; MAC is compact 12-hex-digit match with any separator.
- PER_GROUP_LIMIT (8) caps all six hit groups (blocks/subnets/reservations/assets/ips/sites) in the default unscoped path; order is stable (name/hostname/cidr asc).
- **Scope prefixes** parsed by `parseSearchScope` short-circuit `searchAll`: `block:` / `b:` → only `blocks`; `network:` / `n:` → only `subnets`; `asset:` / `a:` → only `assets` (with origin-FortiGate decoration intact); `reservation:` / `r:` → only `reservations`; `map:` / `m:` → only `sites` (pinned firewalls). Other groups return empty arrays in the scoped path. Cap is lifted from 8 to `SCOPED_LIMIT` (200). Min query length drops to 1 char after the prefix so `block:f` works; unscoped queries still require 2 chars. `results.query` echoes the original raw input (prefix included) so the desktop dropdown's stale-response check holds. Scope prefixes are case-insensitive and tolerate whitespace after the colon. They DO NOT collide with the `entra:` / `ad:` / `fgt:` / `intune:` / `fortiswitch:` / `fortiap:` source-kind prefix consumed inside `stripSourceKindPrefix` — none of those start with the scope letters.
- `searchBlocks` / `searchSubnets` / `searchReservations` / `searchAssets` / `searchPinnedFirewalls` / `runAssetSearch` all accept an optional `limit` parameter that defaults to `PER_GROUP_LIMIT`; the scoped path passes `SCOPED_LIMIT` through. Inside `runAssetSearch` the limit drives sub-query `take`s, the JSON-blob raw-SQL `LIMIT` (limit × 4), the dedup-merge break conditions, and the final `.slice` — they all move together.
- Pinned firewalls (assetType=firewall + lat/lng set) are queried as their own group via `searchPinnedFirewalls` so the Device Map section always has an 8-row budget; `searchAssets` passes an empty baseFilter so pinned firewalls ALSO appear in the Assets group (intentional double-listing — operators searching for a firewall hostname expect to find it under Assets too, and `byAsset` hostname match ranks it above the JSON-blob endpoint matches behind it). Both pathways funnel through `runAssetSearch(terms, mac, baseFilter, limit?)` which owns the AND-of-OR clauses + five cross-search pathways + dedup merge — keep them in lock-step when adding new asset-search fields (add the new column to the `assetCols(t)` builder so it's part of every term's OR).
- `runAssetSearch` runs six parallel pathways merged into one limit-row dedup pipeline: `byAsset` (direct Asset AND-of-OR over the `assetCols` builder, including `assignedTo`, `department`, and the per-term `macAddress` contains / normalized-equals), `sourceHits` (`AssetSource.externalId` with `entra:` / `ad:` / `fgt:` / `intune:` / `fortiswitch:` / `fortiap:` prefix-strip), `macSideHits` (`AssetMacAddress.mac`), `ipSideHits` (`AssetAssociatedIp.ip`), `ipHistHits` (`AssetIpHistory.ip` — historical / since-rotated addresses), and `jsonHitIds` (raw-SQL UNION over `assets.associatedUsers::text` + `asset_sources.observed::text` ILIKE — backed by the GIN trigram indexes from migration `20260507200000_search_json_trgm_indexes`). `byAsset` wins ties; the side / source / JSON pathways fill remaining budget in that order. Apply `baseFilter` to every pathway (including the JSON-id reload) so the firewall vs. non-firewall partition holds.
- `decorateAssetHit(a, origin)` is the single source of truth for asset-hit shaping + origin-FortiGate context stamping; reused by both the unscoped path's `.map` and the scoped `asset:` path. Adding new fields to an asset hit's `context` belongs in this helper.
- Asset origin resolution (for topology modal focus) prioritizes most-recent DHCP sighting, falls back to `learnedLocation` for Entra/AD-discovered hosts.
- AssetSource externalId search strips `entra:`, `ad:`, `fgt:`, `intune:`, `fortiswitch:`, `fortiap:` prefixes so operators can paste either form.

**When changing this:**
- Test IP classification edge cases (IPv6, /32 subnets, partial CIDR).
- Verify site/firewall filtering doesn't drop valid results.
- Confirm AssetSource dedup logic preserves the right hit when both asset and source rows match.
- Check PER_GROUP_LIMIT doesn't regress for the unscoped path; dropdown expects exactly 8 per group on bare typeahead.
- Adding a new scope prefix: extend `parseSearchScope`'s regex (long form + short form, both case-insensitive), the `SearchScope` union, the scope-branch dispatcher in `searchAll`, AND the matching hint chips on desktop (`_showSearchShortcutHints` in `public/js/app.js`) + mobile (`renderSearchEmpty` in `public/js/mobile/tabs.js`). The chips' wiring assumes a `<prefix>:` shape — keep that contract. Both renderers also gate their virtual-Device-Map injection on a scope-prefix regex (`_renderSearchDropdown` in `public/js/app.js`, `renderSearchResults` in `public/js/mobile/tabs.js`) — when scope is non-map the synthesized site rows from asset hits are suppressed so a scoped `a:` / `r:` / `n:` / `b:` query doesn't bleed into the Device Map section. Add any new non-map prefix to both regexes.
- Adjusting `SCOPED_LIMIT` — current 200 is "bounded but generous"; the asset path runs six parallel queries each capped at `limit`, so going much higher (>500) is when fan-out cost starts mattering.
- Validate MAC normalization handles all common formats (colon, dash, dot, no separator) and that the stored-value match stays case-insensitive (`tests/unit/normalizeMac.test.ts`).
- Validate tokenization edge cases (quoted phrase, mixed quoted/bare, unterminated quote, quotes-only) in `tests/unit/parseSearchTerms.test.ts`. When adding a searched column, confirm it's inside the per-term `OR` (not a bare top-level filter) so multi-term AND still holds.

---

## services/serverSettingsService.ts

**What it owns:** Server-wide configuration: NTP (servers, timezone) and CA certificate management (upload, list, delete). Server-leaf certs are managed externally (nginx reads `POLARIS_PROXY_CERT_PATH`).

**Public API:** `getNtpSettings`, `updateNtpSettings`, `testNtpSync`, `listCertificates`, `addCertificate`, `deleteCertificate`.

**Cross-service deps:** none.

**Used by:** `src/api/routes/serverSettings.ts — CA upload/list/delete + NTP settings`. Server-cert mutation routes (`POST /certificates` category=server, `DELETE` of a server cert) return 409 unconditionally — handled directly in the route handler, doesn't reach the service.

**Invariants:**
- NTP and certificate lists persist in Settings table under `key: "ntp"` and `"certificates"`.
- Certificate store is a single JSON array in the "certificates" Setting; each cert carries id, category (ca/server), type (cert/key), PEM, and metadata. The route surface only handles `category="ca"`; the cleanup migration `20260608000000_drop_legacy_server_certs` strips any legacy `category="server"` entries on upgrade.
- Backup/restore flows NOT in this service (they live in updateService).

**When changing this:**
- Test CA upload validation (PEM parsing, magic-byte checks if added).
- Confirm cert list dedup handles UUID collisions.

---

## services/subnetRefreshService.ts

**What it owns:** Per-subnet "refresh from device" reconciler — the action behind the **Refresh** button in the IP panel slide-in. Queries the originating FortiGate for ONE DHCP scope (CMDB reservations + live leases), reconciles against Polaris's `dhcp_reservation` + `dhcp_lease` rows on the same subnet, and bumps `Subnet.lastDiscoveredAt`. Manual / VIP / interface-IP rows are left alone.

**Public API:** refreshSubnet(subnetId, actor) → { lastDiscoveredAt, created, updated, released, skipped }.

**Cross-service deps:** reservationPushService (buildTransportForIntegration, findScopeIdForCidr, listReservedAddresses, callFortiOs, normalizeMac), events.logEvent.

**Used by:** src/api/routes/subnets.ts (POST /subnets/:id/refresh route handler — user-or-above).

**Invariants:**
- Only works on subnets whose `discoveredBy` integration is type fortimanager or fortigate, AND `fortigateDevice` is set; 400 otherwise.
- CMDB reservations win on overlap with a live lease for the same IP (matching syncDhcpSubnets' source-of-truth ordering).
- Manual / VIP / interface-IP rows on the same subnet are skipped — the next full integration discovery is where Polaris raises hostname/owner conflicts on those rows via upsertConflict.
- Releases dhcp_*-sourced active rows whose IPs are no longer on the device (operator removed them on the FortiGate). Does NOT touch reservations on other subnets.
- Bumps `Subnet.lastDiscoveredAt` only on success (so the IP panel's "Discovered N minutes ago" updates).

**When changing this:**
- Keep the scope narrow: don't reach into asset sightings / decommissions / map regions — those are owned by `syncDhcpSubnets` and reconcile on the next full integration cycle.
- If the read shape from FortiOS `/api/v2/monitor/system/dhcp` changes, update both `fetchLiveLeasesForScope` here AND the corresponding shape in fortimanagerService.ts / fortigateService.ts so the partial refresh and full discovery stay in sync.
- Description-to-hostname extraction (`extractHostnameFromDescription`) is the inverse of `buildDescription` in reservationPushService — keep them paired.

---

## services/subnetService.ts

**What it owns:** Subnet creation, allocation, bulk templates, and lifecycle (manual vs discovered).

**Public API:** listSubnets, getSubnet, createSubnet, allocateNextSubnet, bulkAllocate, previewBulkAllocate, updateSubnet, getSubnetIps, deleteSubnet.

**Cross-service deps:** ipService (indirectly via cidrContains/cidrOverlaps from utils/cidr.ts).

**Used by:** src/api/routes/subnets.ts (all operations), src/services/reservationService.ts (subnet lookups, status checks), src/services/utilizationService.ts (subnet status grouping).

**Invariants:**
- Subnet must be contained within parent block CIDR
- No overlapping sibling subnets in the same block (checked before create)
- IPv4-only for auto-allocation (allocateNextSubnet, bulkAllocate)
- Subnet status = "deprecated" rejects new reservations
- Full-subnet reservation (ipAddress=null) sets subnet status → "reserved"
- Prefix length must be [8, 32] for IPv4
- **First-claim parity (discovery side, lives in `src/api/routes/integrations.ts` syncDhcpSubnets Phase 1):** when a discovery cycle's CIDR matches a manual subnet (`existing.discoveredBy == null`), the row gets brought into parity with a freshly-discovered subnet — `name` rewritten to `DHCP: <scope> (<fortigate>)`, `status` reset to `available`, `tags` union-merged with `["dhcp-discovered", <integrationType>]`, `purpose` stamped only when blank. Subsequent passes see `discoveredBy` set and skip the claim branch (operator can rename/retag after claim and edits survive). One `subnet.claimed` Event per first-claim.

**When changing this:**
- Test allocateNextSubnet's findNextAvailableSubnet logic (concurrent allocations must not race)
- Verify bulkAllocate's anchor-aligned packing (all-or-nothing transaction)
- Check updateSubnet does not allow status changes that violate reservation constraints
- Review overlapping-sibling check performance for large blocks

---

## services/timescaleService.ts

**What it owns:** TimescaleDB extension detection and hypertable migration for the eight sample tables + sixteen rollup tables (24 hypertable candidates); `dropChunks` pre-filter for retention pruning. Boot-time detection caches hypertable status; subsequent `isHypertable()` checks return cached value without round-tripping.

**Public API:** `detectTimescale`, `isTimescaleAvailable`, `isHypertable`, `getDetectionState`, `dropChunks`, `getEffectiveCompressAfterDays`, `migrateToHypertables`, `SAMPLE_TABLES`, `ROLLUP_TABLES`, `ALL_HYPERTABLE_CANDIDATES`, `SampleTableName`, `RollupTableName`, `ManagedHypertableName`, `DetectionState`.

**Cross-service deps:** none.

**Used by:** `src/app.ts` — boot detection and hypertable migration; `src/services/monitoringService.ts` — `dropChunks` calls in pruning + `getEffectiveCompressAfterDays` to lower-bound the selection-aware slow prune off compressed chunks; `src/services/capacityService.ts` — hypertable status for capacity snapshot; `src/jobs/reclaimBloatedChunks.ts` — `isHypertable` gate before scanning for compressed-chunk heap bloat.

**Invariants:**
- **Boot-time detection cache:** `detectTimescale()` caches result; cache updates only on successful probe. Re-detection runs after `migrateToHypertables()` completes so `isHypertable()` reflects post-conversion state.
- **`dropChunks` no-op on plain Postgres:** checks `isHypertable(tableName)` early and returns immediately if false; safe to call unconditionally as a pre-filter before per-class `deleteMany`.
- **`migrateToHypertables()` idempotent:** creates hypertables only if not already present. The compression policy is only removed + re-added when the `compress_after` window actually CHANGED (`compressionPolicyMatches` introspects `timescaledb_information.jobs.config->>'compress_after'`) — an unconditional recreate every boot resets the policy's `next_start` ~12h out, so a host that reboots more often (in-app updates cycle `polaris.target`; crash loops) would never let the policy reach its first run, and chunks would never compress. `TIMESCALE_COMPRESS_AFTER_DAYS` changes still take effect next startup (window differs → recreate).
- **Boot-time self-heal compression (`compressEligibleBacklog`):** after the conversion loop, compresses any chunk already past its window but still uncompressed — does immediately what the 12h policy scheduler otherwise might never get to. Sequential + oldest-first + capped at `MAX_BACKLOG_COMPRESS_CHUNKS_PER_TABLE` (8) per table so a large first-run/post-outage backlog can't stall boot or saturate the DB; remaining chunks resume next boot or via the policy. Only touches chunks older than the window, so it never compresses a chunk the unselected 24h `deleteMany` still writes to. This is the guard against the uncompressed delete-churn bloat that ballooned `asset_interface_samples` to 114 GB in prod (single 63 GB uncompressed chunk). Best-effort — per-chunk errors logged, never thrown.
- **Chunk-granular drops:** `drop_chunks` can only drop a chunk when ALL rows are older than cutoff; fast O(1) filter for old chunks before residue cleanup via `deleteMany`.

**When changing this:**
- Verify `detectTimescale()` is called before any sample write so hypertable status is fresh.
- If modifying `SAMPLE_TABLES` / `ROLLUP_TABLES`, keep in sync across detection, pruning, and migration logic, plus capacityService's local per-table projection map. `tests/unit/timescaleTables.test.ts` drift-guards the inventory against sampleRollupService, the monitoringService prune layer, and prisma/schema.prisma (with an explicit exemption list — `asset_custom_widget_samples` is the one known unmanaged sample table).
- Test plain-Postgres fallback path: verify `dropChunks` no-op and `deleteMany` handles all pruning when extension unavailable.
- Check compression policy drift if operators change `TIMESCALE_COMPRESS_AFTER_DAYS` mid-boot cycle (only takes effect next restart).
- If TimescaleDB ever renames the compression-policy config key (`compress_after`), update `compressionPolicyMatches` — but its catch-all returns `false` (recreate) on any introspection failure, so a key rename degrades to the old always-recreate behavior + the backlog pass, never breaks.

---

## services/totpService.ts

**What it owns:** RFC 6238 TOTP secret generation, enrollment QR codes, time-windowed code verification (±30s), and argon2id-hashed backup code generation and consumption.

**Public API:** generateSecret, buildEnrollment, verifyCode, generateBackupCodes, consumeBackupCode.

**Cross-service deps:** none.

**Used by:**
- src/api/routes/auth.ts — POST /totp/enroll, QR code + secret generation
- src/api/routes/auth.ts — POST /totp/enroll, render QR SVG
- src/api/routes/auth.ts — POST /login/totp, verify TOTP code during login
- src/api/routes/auth.ts — POST /totp/confirm, validate code at enrollment finish
- src/api/routes/auth.ts — POST /login/totp, consume backup code on fallback
- src/api/routes/auth.ts — POST /totp/confirm, generate backup codes on enable
- src/api/routes/auth.ts — DELETE /totp, consume backup code on disable
- src/api/routes/auth.ts — DELETE /totp, verify code before disabling

**Invariants:**
- TOTP secret must be base32-encoded; verify operations accept ±1 step (30s drift tolerance) to absorb client/server clock skew.
- Backup codes are 10 hex pairs (XXXX-XXXX format), argon2id-hashed on generation, never returned in plaintext after enrollment.
- Backup code consumption is stateless (caller must persist the returned array). Login-time code attempts are protected by the login lockout gate (5 failures, 15 min); the enrollment-confirm and self-disable routes (`POST /totp/confirm`, `DELETE /totp`) are additionally rate-limited by `totpCodeLimiter` (10 / 15 min per IP, `src/api/middleware/rateLimits.ts`).
- Two-phase login flow: password success → pendingToken issued; TOTP/backup-code step consumes pendingToken and upgrades to full session.

**When changing this:**
- Test both TOTP verification (standard code + ±1 step boundary) and backup code round-trips (generation, hashing, consumption, array mutation).
- Audit all call sites in auth.ts for pendingToken lifecycle (issue at line 118, consume at 195/226/233).
- If adjusting RFC 6238 params (SHA1, 6 digits, 30s step): users must re-enroll; plan migration messaging.
- Verify no secrets leak into logs (codes are transient; hashes are stored on User rows — check password.ts utility).

---

## services/updateService.ts

**What it owns:** In-app software update check, availability detection (Docker vs git checkout), update application pipeline (backup→pull→npm ci→prisma generate→tsc→migrate→restart), and progress tracking.

**Public API:** `initUpdateStatus`, `getUpdateStatus`, `isUpdateMechanismAvailable`, `clearUpdateStatus`, `checkForUpdates`, `applyUpdate`, `getRecentCommits`, `restartService`.

**Cross-service deps:** none (spawns git/npm/prisma, reads/writes .update-status.json, creates DB backup).

**Used by:** `src/api/routes/serverSettings.ts,1143,1151,1159 — Application Updates card endpoints`; `src/api/routes/serverSettings.ts — POST /restart` (Capacity Advisor "Restart Polaris to apply" button uses `restartService` standalone, without the update pipeline); `src/jobs/updateCheck.ts,31 — hourly check job`. ~7 call sites.

**Invariants:**
- Update mechanism disabled in Docker (`/.dockerenv` present, `.git/` absent) or when no `.git/` checkout exists; `getUpdateStatus()` returns `state: "disabled"` with a human-readable reason.
- Status persists in `.update-status.json` at APP_DIR root; survives restarts.
- applyUpdate() runs background; only one apply in flight at a time (`_applying` flag).
- Backup is optional (skippable via Setting "update.skip_backup"); pre-update backups registered in "backup_history" Setting.
- Encryption: backup password → AES-256-GCM ciphertext wrapped in `[POLARIS\0][salt][iv][authTag][ct]` envelope.
- **Seven-step pipeline (order is load-bearing):** (1) backup, (2) git pull, (3) `npm ci --production=false`, (4) **explicit `npx prisma generate`**, (5) **clean `dist/` then `npm run build`** (= `tsc` + the post-tsc asset copy in `scripts/copy-build-assets.mjs`; never bare `npx tsc`, or the bundled std MIB `.txt` files never reach `dist/` and std SNMP-walks break), (6) `npx prisma migrate deploy`, (7) restart (NSSM on Windows, systemd exit(1) on Linux). Steps 4 + 5's `rm -rf dist` are defenses against the failure mode in `cross-cutting/schema-migrations-and-prisma-client-lifecycle` — never collapse them back into "trust npm ci postinstall."
- **Update source repo is configurable.** `ensureUpdateRemote()` runs before the fetch in `checkForUpdates()` AND before the pull in `applyUpdate()`. When `POLARIS_UPDATE_REPO` (env) is SET it repoints the `origin` remote at that URL (idempotent — only rewrites when the URL differs; `git remote add`s if origin is missing; non-fatal). When UNSET it's a no-op — the install's existing `origin` is left as-is (updates come from wherever it was cloned). `getUpdateRepoInfo()` reports the active repo + source (`"env"` vs `"origin"`) and is exposed at `GET /server-settings/updates/repo` for the Application Updates card's "Update source" row. The two fallback scripts (`deploy/update-linux.sh`, `deploy/update-windows.ps1`) read the same `.env` var and repoint origin only when set, in lockstep — keep all three in sync when changing the env-var name or the set/unset semantics.
- Generate-then-build-then-migrate order matters: client must be generated against the NEW schema BEFORE tsc compiles consumers, and migrations apply LAST so the client and DB are in sync at restart. Reversing any of these breaks the next start of the process.

**When changing this:**
- Test update path on both git-backed and Docker installs; verify "disabled" message is clear.
- Check backup encryption round-trip: verify restored backup is valid SQL.
- Confirm npm ci timeout (5 min) doesn't kill slow installs; adjust if needed.
- Test git pull fallback chain (origin/HEAD → origin/main → origin/master).
- Verify restart doesn't kill in-flight requests; 1.5s delay before exit(1) should be enough.
- **Do not reorder steps 3–6** without re-reading `cross-cutting/schema-migrations-and-prisma-client-lifecycle`. A reorder that puts migrate before generate-then-tsc reintroduces the failure mode where dropped columns crash the running client.
- The `rm -rf dist` between steps 4 and 5 is non-negotiable when Prisma client file layout could have changed between versions. Without it, stale `dist/generated/prisma/*.js` files can shadow the regenerated client and the running process selects columns the schema no longer has.

---

## services/utilizationService.ts

**What it owns:** Aggregates subnet usage statistics (blocks, subnets, reservations) for dashboards.

**Public API:** getGlobalUtilization, getBlockUtilization, getRecentManualReservations.

**Used by:** src/api/routes/utilization.ts (GET / for dashboard, GET /blocks/:id for per-block drill-down). `src/api/routes/dashboard.ts` (`/dashboard/summary` consumes `getGlobalUtilization` for `blockUtilization` and `getRecentManualReservations` for `recentReservations`).

**Invariants:**
- Global utilization counts all blocks, subnets, and active reservations in one query set
- IPv6 block addresses capped at Number.MAX_SAFE_INTEGER to avoid precision loss
- Deprecated subnets excluded from allocatedAddresses calculation
- Subnet status grouping: available, reserved, deprecated
- `getRecentManualReservations(limit, sourceTypes?)` — default `sourceTypes=undefined` filters to `["manual"]` (back-compat); explicit array narrows or broadens; empty array disables the filter entirely. Caller (the dashboard route) validates source-type values against the known enum before passing through.

**When changing this:**
- Test large fleet performance (blocks query with full subnet tree may be slow with 100k+ subnets)
- Verify usagePercent calculation (allocatedAddresses / blockAddresses) matches business intent
- Check that deprecated subnets are correctly filtered from block capacity

---

## services/userDashboardService.ts

**What it owns:** Per-user dashboard layout persistence. Wraps the `UserDashboard` Prisma model.

**Public API:** `getLayoutForUser(userId)` (returns `EMPTY_LAYOUT` when no row exists — never throws on absence), `saveLayoutForUser(userId, layout)` (upserts, returns the saved layout), `EMPTY_LAYOUT` constant, `DashboardLayout` / `DashboardWidgetInstance` types.

**Used by:** `src/api/routes/userDashboard.ts` (GET + PUT `/me/dashboard`).

**Invariants:**
- Absent row = empty dashboard (no defaults seeded; fresh sign-in is a clean slate so the "Use the + Widget button to get started" empty-state renders).
- Layout JSON is round-tripped untouched — the service does NOT validate shape. Validation lives at the route layer via Zod (`LayoutSchema` in `src/api/routes/userDashboard.ts`); never call `saveLayoutForUser` with un-validated input.
- Per-user only; admins do NOT have an override path (UI preference, not security-relevant). No Event audit log.

**When changing this:**
- If you add fields to the layout shape, bump `version` and add a migration path in the route (currently `z.literal(1)`).
- The User model has a `dashboard UserDashboard?` back-relation — drop-on-cascade is handled by the Prisma FK, no extra cleanup needed when a user is deleted.

---

## services/vendorTelemetryProfiles.ts

**What it owns:** Built-in vendor telemetry profiles (Cisco, Juniper, Mikrotik, Fortinet FortiSwitch, Fortinet FortiAP, Fortinet FortiGate, HP-Aruba, Dell) matching assets by manufacturer + OS + model regex and exposing symbolic OID queries for CPU / memory / disk / temperature via oidRegistry resolution.

**Public API:** `VENDOR_TELEMETRY_PROFILES`, `pickVendorProfile`, `memoryQueryToDoubleScalar`, `VendorTelemetryProfile`, `CpuQuery`, `MemoryQuery`, `DiskQuery`, `TemperatureQuery`. `memoryQueryToDoubleScalar(mem)` translates a hardcoded `MemoryQuery` into the editable Manufacturer Profile's double-scalar shape (`{type, symbol, symbolB, transform}` with the matching `CombinerKind`) — consumed by `seedManufacturerProfiles` and `backfillManufacturerProfileMemoryComposition`. Returns null for empty memory blocks.

**Cross-service deps:** None (vendorTelemetryProfiles is leaf; consumed by monitoringService + mibService).

**Used by:** `src/services/monitoringService.ts — probe strategy selection for telemetry`, `src/services/mibService.ts — profile status reporting in MIB database UI`.

**Invariants:**
- `match` regex is tested against `"${manufacturer ?? ''} ${os ?? ''} ${model ?? ''}".trim()` (all three fields optional).
- Entries ordered in priority; first match wins (no fallback after). Both FortiSwitch and FortiAP must precede the generic Fortinet entry because all three match `manufacturer="Fortinet"`; the model-specific regexes (`/fortiswitch/i`, `/fortiap/i`) sit before the broad `/fortinet|fortigate|fortios/i` so FortiSwitches/FortiAPs don't fall into the FortiGate OID tree.
- CPU/memory/temperature symbols resolve from one of three layers (in priority order): an uploaded MIB at the asset's scope, an entry in `oidRegistry`'s `BUILT_IN_OIDS` seed (currently covers Cisco / Juniper / HP-Aruba / Dell-RADLAN / Fortinet FortiGate + FortiSwitch + FortiAP — these vendors show "READY" out of the box), or — when neither resolves — the HOST-RESOURCES-MIB fallback inside the probe.
- `TemperatureQuery.mode` is `"scalar" | "table"`. `pickVendorProfileMerged` maps the manufacturer-profile `temperature` metric's `type`: `table` → `mode: "table"` (the SNMP collector runs the full `fgHwSensorTable` hardware-sensor walk via `collectHardwareSensorsFortinetSnmp`), `scalar` → `mode: "scalar"` (single `.0` reading, used by FortiAP `fapTemperature` after the fgHwSensorTable + ENTITY-SENSOR walks both come back empty). This is what makes the operator's `table` / `fgHwSensorTable` profile override actually populate (it was silently coerced to a broken scalar GET before the Hardware Sensors work).
- Profile selection is read-only; no runtime mutations.

**When changing this:**
- Verify new `match` regex pattern against real asset manufacturer/OS values (case-insensitive).
- Confirm CPU/memory/temperature symbol names match the MIB files referenced in CLAUDE.md SNMP stack section.
- Test `pickVendorProfile()` with mixed-case inputs and edge cases (null manufacturer with os set).
- Add model-specific profile entries (e.g. FortiSwitch, FortiAP) BEFORE the generic vendor entry — order is the precedence mechanism.
- Update CLAUDE.md narrative if renaming or reordering built-in profiles.
- If adding a new temperature query, ensure the matching OID is seeded into `oidRegistry.BUILT_IN_OIDS` or upload coverage is required from the operator.

---

## services/windowsServerService.ts

**What it owns:** Windows Server DHCP discovery via WinRM PowerShell remoting (DHCP scopes, subnets, include/exclude filtering).

**Public API:** testConnection, discoverDhcpScopes, WindowsServerConfig, DiscoveredDhcpScope.

**Cross-service deps:** None (WinRM client; no service-to-service calls).

**Used by:** src/api/routes/integrations.ts,523,697,1109,1372 — discovery trigger, subnet sync, test connection.

**Invariants:**
- WinRM simple auth (HTTP/HTTPS, default port 5985/5986); no Kerberos.
- PowerShell Get-DhcpServerv4Scope query returns ScopeId (MAC + subnet); mapped to DiscoveredDhcpScope shape (cidr/name/fortigateDevice/dhcpServerId).
- `fortigateDevice` field repurposed to hold DHCP server hostname for compatibility with FMG/FortiGate discovery result shape.
- `dhcpInclude`/`dhcpExclude` scope filtering applied server-side before returning.
- Results fed to same syncDhcpSubnets pipeline as FMG/FortiGate (produces Subnet rows, no device inventory).
- No per-device iteration; single WinRM call returns all scopes on that server.

**When changing this:**
- Verify WinRM URL construction (scheme + port based on useSsl flag).
- Check PowerShell query still works on target Windows versions (Server 2016+).
- Confirm dhcpInclude/dhcpExclude filtering still matches scope IDs/names correctly.
- Test DiscoveredDhcpScope mapping (cidr/name/fortigateDevice/dhcpServerId) feeds syncDhcpSubnets correctly.
- Validate error messages for auth failures, service not running, connection timeouts.
