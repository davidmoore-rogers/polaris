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

- [Cross-cutting concerns](#cross-cutting-concerns) (19)
- [Per-service touches](#per-service-touches) — alphabetical; covers the highest-traffic of the 65 services in `src/services/` (not every service has a section)

---

# Cross-cutting concerns

## cross-cutting/five-state-monitor-machine

**What it is:** Asset.monitorStatus ∈ {up, warning, recovering, down, unknown} driven by consecutiveFailures/consecutiveSuccesses counters (see "Five-state monitor machine" in CLAUDE.md).

**Writers** (files that mutate or emit this state):
- `src/services/monitoringService.ts` — runProbeFor() updates Asset.monitorStatus/consecutiveFailures/consecutiveSuccesses after each probe result, stamps Asset.monitorStatusChangedAt whenever monitorStatus changes value (any-to-any, not just up↔down), emits monitor.status_changed Event on transitions INTO up/warning/down (not recovering/unknown, never per-poll), fires propagateAfterStatusChange() — but only on the confirmed up/down edge, NOT on the warning edge — to push the change into descendant dependencySuppressed state. **Reboot detection:** the SNMP probe (probeSnmp) now keeps the sysUpTime TimeTicks it already reads as its reachability OID and returns it as ProbeResult.uptimeSec; recordProbeResult stamps it onto the AssetMonitorSample (uptimeSec) + Asset.lastUptimeSec via the probe-patch buffer, and when the reading drops vs. the cached lastUptimeSec (>60s tolerance) sets Asset.lastRebootAt and emits a `device.reboot` Event (level warning). Non-SNMP probes carry no uptime — the probePatchBuffer flush COALESCEs lastUptimeSec/lastRebootAt so they're preserved, not nulled.
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
- `src/api/routes/map.ts` (GET /sites) + `src/services/topologyGraphService.ts` (the topology graph builder) — Device Map reads monitorStatus for FortiGate/switch/AP health coloring via monitorStatusToHealth() (lives in topologyGraphService, imported back by map.ts)
- `src/jobs/monitorAssets.ts` — Queue eligibility check consults monitorStatus + dependencySuppressed
- `src/api/routes/dashboard.ts` — `/dashboard/summary` reads `monitored=true AND monitorStatus in (warning, down)` for the Monitor Alerts card and orders by `monitorStatusChangedAt asc nulls last` so the oldest outages surface first
- `src/services/nocDashboardService.ts` — `/dashboard/noc-summary` reads monitorStatus (status tiles, down nodes, sites-with-issues), asset_monitor_samples.responseTimeMs (slowest response = avg of each asset's most-recent 10 probes), asset_storage_samples used/total (highest disk usage, per-volume), lastMonitorAt (stale polls), and the `device.reboot` Events (recent reboots) for the NOC widgets. Per-widget filters: `resolveFilteredAssetIds` reads `Asset.assetType` + `Asset.tags` (region:<name>) to constrain every feed
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
- `src/services/discovery/discoveryEngine.ts` — upsertFortigateFirewallAssetSource() / upsertFortinetInfraAssetSource() for FMG/FortiGate firewall/switch/AP discovery
- `src/services/discovery/discoveryEngine.ts` — Entra/Intune upsert paths (buildEntraSource / buildIntuneFdmSource + upsertEntraIntuneSources)
- `src/services/discovery/discoveryEngine.ts` — fortigate-endpoint AssetSource stamping on DHCP endpoint discovery
- `src/services/discovery/discoveryEngine.ts` — Active Directory / Windows Server discovery paths upsert ad / windowsserver source rows
- `src/jobs/backfillAssetSources.ts` — One-shot startup: derives sources from legacy assetTag / sid: / ad-guid: tag conventions
- `src/utils/assetSourceDerivation.ts` — deriveAssetSources() implements source derivation rules for both shadow-write and backfill
- `src/services/assetMergeService.ts` — `absorbAssetRelations(tx, from, to)` re-binds ALL of an absorbed asset's AssetSource rows (+ the four side tables + a ManagedAgent the survivor lacks) onto the survivor — the inverse of the per-source Split (`POST /assets/:id/sources/:sourceId/split`, which re-binds ONE source onto a fresh asset). Both rely on the global `(sourceKind, externalId)` uniqueness so a re-bind can never collide. TWO callers: `mergeAssets()` (operator merge, `POST /assets/:id/merge`) and `acceptAssetConflict`'s sibling-conflict ghost absorb in `src/services/conflictResolutionService.ts` (`POST /conflicts/:id/merge`) — the conflict path used to let the ghost delete CASCADE those rows, silently destroying provenance the survivor never had (an AD-only target absorbing a ghost that held entra + intune + fortigate-endpoint + vcenter-vm came out with only ad + a re-created vcenter-vm row). Both paths also share `resolveMonitoringCarry()` (the `monitored` OR-carry + MONITOR_CONFIG_FIELDS/MONITOR_PIN_FIELDS adoption). The automatic `mergeDuplicateHostnameAssets` job and `mergeEndpointGhostIntoAsset` still cascade-delete/drop ghost sources on purpose — their ghosts are placeholders (see those entries).

**Readers** (files that consume it):
- `src/utils/assetProjection.ts` — projectAssetFromSources() reads AssetSource rows and applies priority rules to build ProjectedAsset shape
- `src/api/routes/assets.ts` — Asset read endpoints attach AssetSource rows in the assetSources relation
- `src/utils/assetSourceState.ts` — `deriveAssetSourceState(sourceKind, observed)` reads the lifecycle field each source kind uses (entra `accountEnabled` / ad `accountDisabled` / vcenter-vm `powerState` / vcenter-host `connectionState`+`powerState` / fortiswitch `connected` / fortiap `status` / arc `status` / arc-k8s `connectivityStatus`) and normalizes it to one tri-state reading. Called by `GET /assets/:id/sources` (embedded as `state` per row); rendered by `public/js/assets.js` (`_assetSourceStateBadge` + `_assetSourceStateSummaryHTML`) and `public/js/mobile/asset-detail.js` (`loadSources`)
- `src/services/projectionDriftService.ts` — Compares projectAssetFromSources() output against Asset field values to detect drift
- Discovery paths use projectAssetFromSources() output as the source of truth for Asset field writes (Phase 3b.1 cutover pending)

**Invariants:**
- Every AssetSource row must have sourceKind + externalId (unique key); created/updated by discovery or the shadow-write extension.
- inferred=true rows are backfill skeletons; projection ignores them (they predate real discovery).
- observed JSON blob is owned by the discovery pathway that explicitly writes it (Phase 2+); shadow-write never touches observed on update, only on initial create.
- Priority rules in projectAssetFromSources() are immutable for production stability; tuned from shadow-drift logs and locked with operators.
- **Operator hostname override** (`Asset.hostnameOverride`, migration 20260714000000): set/cleared ONLY by PUT `/assets/:id` (`assets:write`) — a changed Hostname in the edit form pins both `hostname` + `hostnameOverride`; a blanked field clears the pin and reverts `hostname` to the fresh projection. Enforcement is central: `enforceOperatorOverrides` in `src/db.ts` (pure guard `applyHostnameOverride` in `src/utils/assetInvariants.ts`, unit-tested in tests/unit/hostnameOverride.test.ts; the same guard read also serves the IP pin — see the ipOverride bullet below) re-asserts the pin over ANY asset update/upsert that stages `hostname` without touching `hostnameOverride` — so none of the ~17 projection write sites (discoveryEngine.ts, agents.ts, fortimanagerService.ts, source split/merge) know about it. The guard's row read only fires on hostname-staging writes (discovery cadence, not the monitor hot path). Pinned assets are excluded from `mergeDuplicateHostnameAssets` grouping (both the SQL dup scan and the findMany — a pin colliding with a real device's hostname is operator intent, not a ghost) and from hostname drift logging in `projectionDriftService`.
- **Operator IP override** (`Asset.ipOverride`, migration 20260716000000): hostnameOverride's sibling with discovery-gets-a-vote semantics. Set/cleared ONLY by PUT `/assets/:id` — a changed IP Address in the edit form pins `ipAddress` + `ipOverride` (+ `ipSource="manual"`); a blanked field clears the pin and reverts `ipAddress`/`ipSource` to the fresh projection; either transition also closes the asset's pending ip-override conflict (`resolvePendingIpOverrideConflicts`, actor-stamped). Enforcement is central: `enforceOperatorOverrides` in `src/db.ts` (ONE shared row read with the hostname guard; pure guard `applyIpOverride` in `src/utils/assetInvariants.ts`, unit-tested in tests/unit/ipOverride.test.ts) intercepts any update/upsert staging `ipAddress` without `ipOverride`. Staged IP == pin → pin RELEASED in the same write, then fire-and-forget `handleIpOverrideReleased` (ipOverrideService) closes pending ip-override conflicts + logs `asset.ip_override.released`. Staged IP != pin → write rewritten back to the pin (staged `ipSource` rewritten to "manual" so provenance matches), then fire-and-forget `raiseIpOverrideConflict` creates/refreshes ONE pending Conflict per asset (`proposedAssetFields.collisionReason="ip-override"`; a rejected row with the same proposed IP suppresses re-raise). Staged clear (null) → re-asserted silently, no conflict. Resolution lives in `src/services/conflictResolutionService.ts` (`acceptIpOverrideConflict` writes ipAddress+ipOverride+ipSource in one update so the guard defers; reject is event-only) — merge degenerates to accept. Pinned assets skip ipAddress drift in projectionDriftService. updateMany is not guarded (no writer stages ipAddress through it — re-verified 2026-07).
- Fortinet infrastructure (firewall/switch/AP) sources are derived from serial + manufacturer + assetType during backfill; discovery writes explicit "fortigate-firewall" / "fortiswitch" / "fortiap" source rows.
- `fortiswitch` observed blob owns `baseMac` — management MAC of the FortiLink-peer interface, captured by cross-joining `/api/v2/monitor/switch-controller/detected-device` rows where `is_fortilink_peer===true` AND `switch_id===<this switch's switch-id>` against the `managed-switch/status` roster, done inside the per-FortiGate detected-device loop in BOTH `fortimanagerService.ts` (Step 3d.5) and `fortigateService.ts` (Chain C / Step 3e.5). Stamped on `Asset.macAddress` + `macAddressRows` at create time AND reconciled into `AssetMacAddress` on update so the next discovery cycle's MAC-keyed dedup paths (Phase 7 device-inventory, Phase 7.5 MAC-table enrichment, and the FortiSwitch lookup's MAC fallback) recognize the switch and never spawn a phantom `fortigate-endpoint` asset alongside it. One-shot job `mergeFortiswitchEndpointGhosts` handles historical orphans created before this capture landed; the broader periodic `mergeDuplicateHostnameAssets` (boot + every 30 min) catches the post-baseMac shape (switch already has its MAC, but a sibling `fortigate-endpoint` row with the same hostname still exists) AND every other duplicate-hostname pattern (workstation ghosts from multi-MAC devices, Phase-1 backfill `manual`-only leftovers, FortiAP equivalents) by grouping on `lower(hostname)` and picking a canonical by source-kind tier.
- fortigate-endpoint source is stamped on endpoint-type assets discovered via DHCP; marked as infra if assetType is "firewall"/"switch"/"access_point".
- `fortigate-firewall` observed blob owns the THREE coord tiers (`snmpGeocodedLatitude/Longitude`, `metavarLatitude/Longitude`, `latitude/longitude`) plus `snmpLocation`. Latitude/longitude projection rules walk the three tiers in that order on the SAME source kind, validating each (lat,lng) pair as a whole via `isValidGeoCoord` so a half-valid tier falls through instead of mixing values. `snmpLocation` is its own projected field (string).
- HA-cluster firewalls (a-p / a-a) get one `fortigate-firewall` source row PER physical member, keyed on each member's own stable serial. The observed blob carries member-specific `serial` / `hostname` / `mgmtIp` plus cluster-wide `haMode` / `haRole` / `haPeerSerial`. The standby member's `mgmtIp` is null (cluster IP only reaches the active member). Phase 3 fan-out keys each member's Asset lookup on its OWN serial — never on `device.sn` which flips on failover.
- `fortigate-firewall` carries `mgmtMac` (the management-interface MAC, scalar identity) + `interfaceMacs` (**every physical interface MAC**). Both read from `/api/v2/cmdb/system/interface` — fetched WITHOUT a name filter so all interface MACs are captured — on the SAME query that resolves `mgmtIp` (zero extra REST calls), in `fortigateService.ts` (standalone + FMG-direct, which delegates here) AND the FMG proxy-lane interface query in `fortimanagerService.ts` (`fields:["name","ip","macaddr"]`, no filter). Normalized via `normalizeMacOrNull` / `normalizeMacsDistinct` (`src/utils/mac.ts` — colon-uppercase, all-zero loopback/tunnel MACs dropped, deduped). The union (mgmt MAC first) is stamped on `Asset.macAddress` (= mgmt MAC) + all of them into `macAddressRows` at create AND reconciled into `AssetMacAddress` on update (mirrors the `fortiswitch` baseMac pattern), **primary HA member only** (undefined for the standby — the MACs belong to the active box). Purpose: get the firewall into discovery's in-memory `byMac` index keyed on EVERY interface MAC, so Phase 7 device-inventory / Phase 7.5 MAC-table recognize it no matter which interface a peer FortiGate sighted (the ghost MAC isn't always the mgmt interface) and never spawn a duplicate `fortigate-endpoint`. `mgmtMac` + `interfaceMacs` are recorded in the observed blob for the Sources tab but are NOT projection-owned (`macAddress` is written directly, like `learnedLocation`). Pre-existing firewall ghosts converge via `mergeDuplicateHostnameAssets`. Note: a firewall asset can now carry many MAC rows (one per physical port); the asset details modal renders them in the contained `All MACs (N)` block.

**When changing this:**
- Modify priority rules only if tuned against real drift logs and agreed with operators (don't guess).
- If adding a new discovery source kind, pair it with an AssetSource upsert in the discovery path AND update deriveAssetSources() rules for backfill coverage.
- If a source kind's observed blob gains (or renames) a lifecycle field, add the mapping to `deriveAssetSourceState` in `src/utils/assetSourceState.ts` + a case in tests/unit/assetSourceState.test.ts — otherwise the Sources tab silently renders "State not reported" for it. Only map a field that is genuinely an enabled/disabled statement; `unknown` is the honest answer for presence-only evidence, and an admission state ("discovered") is not an outage.
- Adding a new mergeable Asset scalar field? Add it to `MERGEABLE_FIELDS` in `src/services/assetMergeService.ts` AND the `_mergeCompareFields` list in `public/js/assets.js` (they must stay in sync — the modal and the service agree on what's diffable/winner-pickable).
- Test shadow-write: create an asset with assetTag, verify AssetSource row exists; update assetTag, verify the row is refreshed.
- Run projectionDriftService on next discovery cycle and check pino logs for "asset.projection.drift" — should be silent on stable sources.
- Verify backfill catches the new source kind: run startup job, spot-check a few assets have the right AssetSource rows.

---

## cross-cutting/polling-method-resolver

**What it is:** Four-tier cascade resolving which polling method (REST API / SNMP / WinRM / SSH / ICMP / Disabled / Polaris Agent) is used for each asset's response-time / telemetry / system-info / fastFiltered probes (see "Monitor Settings Hierarchy" + "Polling-method compatibility matrix" in CLAUDE.md). The `"agent"` method short-circuits the periodic puller (probeAsset / collectTelemetry / collectSystemInfo / collectFastFiltered all early-return) because the Polaris Agent on the host pushes its own samples via `POST /api/v1/agents/samples`.

**Writers** (files that mutate or emit this state):
- `src/api/routes/assets.ts` — PUT /assets/:id sets per-asset override columns (responseTimePolling / cpuMemoryPolling / temperaturePolling / interfacesPolling / lldpPolling / storagePolling); also `lldpIntervalSec` / `storageIntervalSec` (Phase 2 carve-out).
- `src/services/monitorSettingsService.ts` (thin routes in `src/api/routes/monitorSettings.ts`) — POST/PUT MonitorClassOverride upserts class-tier overrides. **As of Phase 2, integration-scoped writes (`integrationId !== null`) are rejected with 400** — manual scope only.
- `src/api/routes/integrations.ts` — Integration config JSON holds tier-3 `monitorSettings` (flat baseline) PLUS Phase 2 per-class `streams` blocks under `<klass>Monitor.streams.<stream>` (FMG/FortiGate: fortigateMonitor/fortiswitchMonitor/fortiapMonitor; AD/Entra/WinSrv: workstationMonitor/serverMonitor).
- `src/api/routes/serverSettings.ts` — PUT /server-settings updates tier-4 manualMonitorSettings Setting
- `src/jobs/migrateMonitorSettingsPerClass.ts` (Phase 2) — One-shot startup migration seeding per-class streams from the flat baseline + folding historical integration-scoped MonitorClassOverride rows + deleting absorbed rows. Idempotent via `monitorSettingsPerClassMigratedAt` Setting marker. Invalidates the resolver cache at the end.
- `src/services/monitoringService.ts:resolveMonitorSettings / resolveMonitorSettingsWithProvenance` — Only readers; these are pure resolvers, not writers. **Phase 2 cache key is `${integrationId}:${assetType}`** so each per-class branch caches independently; `invalidateMonitorSettingsCache({integrationId})` without assetType walks every `<integrationId>:*` entry.
- **Cross-transport streams** — `processes` + `eventLog` are full members of the hierarchy (columns on `Asset` + `MonitorClassOverride`, resolved by `resolveStream`). `resolveStream` gates on BOTH `isPollingMethodCompatible(source, m)` AND `isMethodValidForStream(stream, m)` (the `STREAM_METHODS` matrix in `utils/pollingCompatibility.ts`: processes ⊄ rest/icmp; eventLog ⊄ snmp/icmp). Default `disabled` for all sources. When adding the per-transport collectors, the resolved `processesPolling`/`eventLogPolling` is the dispatch key — mirror the interfaces/storage collector wiring. Per-asset writes (PUT /assets/:id processesPolling/eventLogPolling) + the agent `/config` self-heal are NOT yet wired (foundational layer is config surface + resolution only).

**Readers** (files that consume it):
- `src/services/monitoringService.ts:runMonitorPass` — per-stream (probe/telemetry/systemInfo/fastFiltered) dispatch branches consult resolved settings to pick method + timeout + retry logic
- `src/jobs/monitorAssets.ts` — publishDueWork() and light/heavy loops call resolveMonitorSettings() to determine which assets are due for each cadence
- `public/js/assets.js` — Asset Monitoring tab UI renders manual override tier (per-asset dropdowns + per-stream SNMP credential pickers + per-stream MIB pickers); class override editor renders all three sub-rows (polling, credential, MIB) per stream
- `public/js/integrations.js` — Integration Monitoring tab renders the integration tier as **per-class subtabs** (FortiGate/FortiSwitch/FortiAP for FMG+FortiGate; Workstations/Servers for AD/Entra/WinSrv) each wrapping a **per-stream subtab strip** (Response Time / CPU/Memory / Temperature / Interfaces / LLDP / Storage). Each stream subtab carries polling-method dropdown + credential picker + interval + timeout (failure threshold only on Response Time). Class overrides have moved to the Assets-page Monitoring Settings modal. **Phase 2 save handler**: per-class subtabs serialize their own stream values into `Integration.config.<klass>Monitor.streams.<stream>` (FMG/FortiGate via `_readFortigateMonitorBlock("…", {klass, isPrimary})` + `_readClassMonitorBlock("…", {klass, isPrimary, includeStorage?})`; AD/Entra/WinSrv still use the legacy flat path in the current UI iteration). Helper: `_readClassStreamSubtabs(klass, isPrimary, includeStorage)`. **Phase 2 load handler**: `_classStreamsBlockFor(klass, opts)` picks the matching per-class block from opts; `_classSettingsOverlay(flatSettings, classStreams)` overlays it onto the flat baseline before passing to each stream subtab so each class's own saved values render. Canonical helper: `_classStreamSubtabHTML(idPrefix, sourceKind, klass, stream, settings, credentials, isPrimary, opts)` — see `TEMPLATES.md` "Polling methods section (per-stream subtab strip)" entry for the full contract. Per-source-default label generator: `_polarisSourceDefaultPolling(source, stream)` + `_polarisSourceLabel(source, fmgDirectMode)`. Class subtab spec: `_CLASS_SUBTAB_SPECS`. Form readers: `_polarisReadPollingFourStream` / `_polarisReadCredFourStream` / `_polarisReadMibFourStream`. Geographic Location (pullSnmpLocation / pushGeocodedCoords) now lives in its own top-level tab on FMG + standalone FortiGate, NOT under Monitoring. ICMP is rendered only on Response Time stream dropdowns (filtered in `_polarisPollingDropdownHTML`); backend write-time check in `monitorSettingsService.ts:assertPollingCompatible` mirrors this.
- `src/api/routes/assets.ts` — GET /assets/:id/effective-monitor-settings endpoint returns full resolved stack + provenance (used by System tab intermittency-bar replay, by per-stream chart badges to label which tier supplied each polling method — see _streamBadgeText in public/js/assets.js — AND by the stale-data banner threshold; the three callers in assets.js cache `eff.resolved` in `_effectiveResolvedByAssetId` so banner slots can re-evaluate against the class/integration cadence after first paint. A fourth reader: the asset view modal prefetches it (admin-only) in the single fetch wave to gate the SNMP Walk tab via `_assetUsesSnmpPolling` — hidden unless some stream resolves to "snmp" or `customWidgetPolling="snmp"`; fail-open on fetch error. Those three of the readers that fire during a panel OPEN — the SNMP Walk gate, `_renderIntermittencyBar`, `_updateStreamSourceBadgesFromEffective` — share ONE request via `openViewModal`'s closure-scoped `effSettings()` memo, passed down as the optional `effP` parameter; a new open-path consumer should take `effP` too rather than adding a fourth identical GET. The sub-panel refreshes (interface / sensor / IPsec / SD-WAN detail) deliberately pass nothing and re-fetch, since they can run after a settings change)
- `src/api/routes/assets.ts` — GET /assets/:id exposes `discoveredByIntegration.useProxy` (FMG only) so the System tab chart badges can render "Proxy via <fmg>" vs "Direct" without a second round-trip; integration `config` otherwise stripped to keep API tokens out of the response
- `src/api/routes/assets.ts:enrichAssetList → computeMonitoringMethods` — GET /assets (list) calls `resolveMonitorSettings` per row to derive the compact `monitoringMethods` array for the Assets table's **Monitored Via** column. Active `ManagedAgent` short-circuits to `["agent"]`; ICMP is subordinate (surfaces only when it's the sole method). Runs `Promise.all` over the page (page-bounded, cached tiers, no extra DB) — `public/js/assets.js:assetMonitoredViaCell` labels the keys ("Multiple" when >1).
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
- `agent/internal/scriptexec/` — sandboxed executor for server-pushed automation scripts (AgentCommand action=`run_script`, agent ≥0.13.0). Refuses payloads whose sha256 doesn't match the body, unknown interpreters, and platform-mismatched ones (bash/sh/python3 not on Windows; cmd only on Windows); body → 0700 temp dir (always removed), args as ONE argv entry (never shell-interpolated), `exec.CommandContext` timeout (≤600s), 64 KB stdout/stderr caps via a non-erroring limited writer. `main.go`'s `pollAndRunCommands` dispatches on action — run_script → scriptexec, stop/start/restart → service control, anything else → explicit refusal via command-result. Results go back through `ReportCommandResultFull` (exitCode/stdout/stderr). Keep semantics in LOCKSTEP with the server-side `automationScriptRunner.ts` (same caps, same argv posture, same interpreter list = `notificationTypes.SCRIPT_INTERPRETERS`).
- `agent/cmd/polaris-agent/service_windows.go` (+ `service_other.go` stub) — Windows Service Control Manager integration via `golang.org/x/sys/windows/svc`. On Windows the entry point calls `svc.IsWindowsService()` first; if true, dispatches to `svc.Run(...)` which calls `Execute(args, r, status)` on the `polarisService` handler. The handler reports StartPending → Running, spawns `runAgent` in a goroutine, then translates SCM `Stop`/`Shutdown` requests into `context.Cancel`. Without this scaffolding, the SCM kills the process after ~30 s because plain Go binaries don't call `StartServiceCtrlDispatcher`. Non-Windows stub returns false so main() falls through to the SIGTERM-driven path.
- `agent/internal/transport/ws.go` — outbound WebSocket client using `gorilla/websocket`. NewWSDialer wires TLS pinning (same `pinned.TLSConfig` used by HTTP) + carries the bearer in subprotocol. RunWithReconnect loops Dial + Run with exponential-backoff + full-jitter; never gives up.
- `agent/internal/config/config.go` — Load/Save the INI-style agent.conf. Save() is atomic (write-tempfile + rename) and chmods 0600.
- `agent/internal/transport/client.go` — HTTP client that fires Enroll / PushSamples / Heartbeat / FetchConfig. Bearer stored on the Client struct; SetBearer() called once after enrollment.
- `agent/internal/pinned/tls.go` — VerifyPeerCertificate that compares the leaf SHA-256 against the pin from agent.conf. tls.Config has InsecureSkipVerify=true so the standard chain check (which consults system roots) is skipped — pin verification is the only thing that fires.
- **Cert pin source.** The pin embedded in `ManagedAgent.serverCertFingerprint` at install kickoff comes from `certInfo.getServerCertFingerprint()`, which reads the same cert file nginx serves (`POLARIS_PROXY_CERT_PATH`). Phase 2's dual-pin column (`additionalServerCertFingerprints[]`) lets operators stage a new pin via the Maintenance card before rolling nginx's cert. **`runInstall` re-reads the LIVE cert** at push time (not the stored `row.serverCertFingerprint`) and persists it onto the row — a reinstall against a host first enrolled before a cert rotation would otherwise bake the stale pin into agent.conf, the pinned TLS handshake would fail, and the agent would sit forever at "enrolling". Fresh installs already captured the current cert; this makes reinstall self-heal too.
- **Privilege model / `ManagedAgent.privilegeTier`.** The Linux systemd unit is **unprivileged by default** (`User=polaris-agent`, `DynamicUser=yes`, `NoNewPrivileges=true`, `ProtectSystem=strict`) — enough for monitoring, but it can't attribute Application Map connections (gopsutil's socket→PID join reads other users' `/proc/<pid>/fd`). The **`ptrace` tier** adds `AmbientCapabilities=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH` (+ `CapabilityBoundingSet`) to that same hardened unit — enough for connection attribution WITHOUT full root. **The pair is load-bearing:** a foreign `/proc/<pid>/fd` is a 0500 owner-only dir whose *open* is a plain DAC check (`proc_fd_permission` → `generic_permission`) that only CAP_DAC_READ_SEARCH passes — CAP_SYS_PTRACE is consulted only at the readlink (`ptrace_may_access`) step. A SYS_PTRACE-only unit EACCESes at the open, gopsutil returns every socket with `Pid=0`, and the agent collects zero connection rows while looking perfectly healthy (prod, all 8 Linux agents, 2026-07-29; verified with `systemd-run -p DynamicUser=yes -p AmbientCapabilities=…` reproducing both cap sets). Agents installed with the old SYS_PTRACE-only unit stay broken until reinstalled — the unit text is written only at install/reinstall. Security cost stated in every warning: DAC_READ_SEARCH bypasses read permission checks on all files, SYS_PTRACE reads any process's memory — operator-opt-in with a confirmation. **Verified-vs-requested:** `privilegeTier` is only the tier requested at install kickoff; the agent (≥0.17.1, Linux) reports its actual CapEff mask on every heartbeat → `ManagedAgent.reportedCapEff`, decoded by `utils/capEff.decodeCapEff` and rendered three-state on the installed-agents Privilege column + the System-tab Privileges row (pair-verified amber ✓ / stale-unit red "reinstall" / unverified amber). A reinstall therefore visibly updates the column within one heartbeat; a binary upgrade alone also refreshes the report (caps come from the running unit, read at process start). **Full root was retired** with process/service control (Satellite-posture change); `privilegeTier` values are `unprivileged` | `ptrace` | (legacy) `root`. The tier → `[Service]` block mapping lives in **`src/utils/agentUnit.ts`** (`linuxServiceBlock` / `normalizePrivilegeTier`, pure + unit-tested; `linuxServiceBlock` only ever emits unprivileged/ptrace). Operators pick the tier via the "Grant CAP_SYS_PTRACE" checkbox on the per-asset install modal + the bulk Deploy Agent modal (confirmation-gated); it rides `POST /:id/agent/install` + `bulk-agent-install` (`privilegeTier` field, Linux-only, "unprivileged"|"ptrace") → `ManagedAgent.privilegeTier` → `agentInstallService.linuxInstallScript(tier)`. An EXISTING Linux agent changes tier via the installed-agents list **Reinstall** action (`privilegeTier` body on `POST /:id/agent/reinstall`); a legacy-`root` agent **downgrades** to unprivileged/ptrace on reinstall (the list endpoint returns `privilegeTier` so the dialog pre-checks the ptrace box for ptrace/root agents, and the list itself renders a **Privilege** column + a "N with CAP_SYS_PTRACE" header count via `_agentPrivilegeCell` in `public/js/agent-build.js` — so an elevated or legacy-root fleet member is visible without opening each host). Windows agents always run as LocalSystem, macOS LaunchDaemons as root. The asset System-tab agent panel (`assetAgentSubpanelHTML`) surfaces a **Privileges** row (Unprivileged / CAP_SYS_PTRACE / Root-legacy on Linux, LocalSystem on Windows, Root on macOS) read from the `privilegeTier` field `GET /:id/agent` returns. **Process/service start/stop/restart control was removed** — no `serviceControlAvailable`, no control routes, no agent servicecontrol collectors; the `processControl` RBAC key remains orphaned in the catalogue. **Lockstep when changing the systemd unit:** `utils/agentUnit.linuxServiceBlock` is the single source of the unit text — the fresh-install `deploy/` scripts do NOT install the agent (only Polaris itself), so there's no second copy to sync. Validate `DynamicUser=yes` + `AmbientCapabilities=CAP_SYS_PTRACE` on the target systemd version (RHEL 8 / systemd 239) — if the ambient cap is dropped under DynamicUser, fall back to a static `polaris-agent` system user.

- **INVARIANT — the Linux installer must chown `agent.conf` to the state directory's owner, never to root.** `linuxInstallScript` writes `/var/lib/polaris-agent/agent.conf` and the unit runs as a `DynamicUser`. systemd chowns the *StateDirectory* to the dynamic UID at start but leaves files already inside it alone, so a `root:root` conf is readable on a **first** install (systemd migrates the brand-new directory and chowns the whole tree into `/var/lib/private/`) and **unreadable on every reinstall** (the private dir already exists and is already owned by the dynamic user). The failure is silent from Polaris's side: the installer exits 0, `installStatus` reaches `enrolling`, and the host crash-loops on `load config: … permission denied` with `Restart=on-failure` forever — no `installError`, nothing marks it failed, and the enrollment token quietly expires after its 10-minute TTL. The script derives the owner with `stat -Lc '%u:%g'` on `${CONF_DIR}` (`-L` because the path is a symlink into `/var/lib/private/` post-migration) and falls back to `0:0` for the first-install case. After `/enroll` the agent owns the file itself — `Config.Save` writes tempfile + rename as its own user. Prod incident 2026-07-27 (dlvcorpos2, 60k+ restarts). Mirror-check: `LINUX_UNINSTALL_SCRIPT` must remove `/var/lib/private/polaris-agent` as well as the `/var/lib/polaris-agent` symlink, or the next install inherits a stale bearer + servicelog cursors.

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
- `src/services/agentAutoDeployService.ts:runAutoDeployForClass` — discovery-time auto-deploy for AD/Entra workstation/server classes. Creates the same `pending` ManagedAgent row the manual `/agent/install` route does (osPlatform/arch/installTransport/serverCertFingerprint/installCredentialId) then fires `startInstall`. **Reuses the manual install machinery — DO NOT diverge from the `/agent/install` row-creation contract; if that route's required ManagedAgent fields change, change here too.** Eligibility filter is `managedAgent: { is: null }` (one row per asset = idempotent; never re-kicks). Driven from `discoveryEngine.ts:runWorkstationServerAgentAutoDeploy` (post-sync pass) which reads `config.{workstationMonitor,serverMonitor}.agentDeploy` and checks `checkAutoDeployPreconditions()` once. Opt-in (default off); bounded by `agentDeploy.maxConcurrent` (cap 20) minus in-flight + `RUN_CEILING=200`.
- `src/utils/winrm.ts:winrmRunOne` — minimal WS-Management WinRS client. CreateShell → RunCommand → poll Receive until `CommandState=Done` → DeleteShell (always in finally). Used only by agentInstallService Windows-via-WinRM path; not for monitoring probes (those use the lightweight Identify-only path in monitoringService.probeWinRm).
- `src/api/routes/agents.ts:agentsBinaryRouter` — `GET /api/v1/agents/binary/:filename`. Public, whitelist-checked against `data/agents/manifest.json` (only filenames the manifest declares for the current version are served; everything else 404s). Directory-traversal protected. Both Windows install paths download from here via the embedded `Invoke-PolarisPinnedDownload` PS helper, which talks straight to nginx over a `System.Net.Sockets.TcpClient` + `SslStream` + raw HTTP/1.1 — bypasses HttpWebRequest / Invoke-WebRequest because the latter's HKCU-dependent proxy resolution and ALPN/HTTP2 negotiation are flaky under powershell.exe launched non-interactively over OpenSSH on Windows.
- `public/js/assets.js:assetAgentSubpanelHTML` / `_wireAgentSubpanel` — System-tab Polaris Agent sub-panel renderer + button wiring. Visible only when the operator has expressed intent (an agent exists OR at least one per-asset *Polling column is "agent"). Auto-polls every 3 s while installStatus is one of pending / uploading / enrolling / uninstalling; stops when the modal closes (checked via the `#asset-agent-panel`'s `data-asset-id` sentinel).
- `public/js/assets.js:_openInstallAgentModal` — install modal using canonical `openModal(title, body, footerHTML)` + bound primary-button onclick (validation can hold the modal open). On Windows, exposes a WinRM/SSH transport radio that swaps the cred picker between winrm-typed and ssh-typed credentials; on Linux/macOS only the SSH cred picker is shown. POSTs `{credentialId, osPlatform, arch, transport}` to `/agent/install`. OS pre-fills from `Asset.os`.
- `public/js/assets.js:_confirmUninstallAgent` — wraps `showConfirm` Promise; on resolve(true) calls `api.assets.deleteAgent(id, {force})`.
- `src/api/routes/agents.ts:POST /enroll` — consumes the enrollment token, mints a long-lived bearer, transitions installStatus → "active"; emits `agent.enrolled`. Cert-pin mismatch sets installStatus="failed" and emits `agent.install_failed`.
- `src/services/agentTokenService.ts:verifyBearer` — runs on EVERY bearer-gated call; best-effort bumps `lastSeenAt`/`lastSeenIp`, AND self-heals a stuck `installStatus="enrolling"` → `"active"`. This covers the re-install/re-push case where `startInstall` reset status to "enrolling" but the agent reused the bearer already in agent.conf and short-circuited `/enroll` (so nothing else would ever flip it active). Scoped to "enrolling" only — never touches upgrading/uninstalling/failed states.
- `src/api/routes/agents.ts:POST /samples` — bumps lastSeenAt (via verifyBearer) + lastTelemetryAt / lastSystemInfoAt per stream; calls recordProbeResult({fromAgent:true}) for the responseTime stream so the five-state machine runs on agent-pushed RTTs. The responseTime sample also carries `uptimeSec` (Go agent's `host.Uptime()`); it's passed into the ProbeResult so the agent host's uptime lands on `Asset.lastUptimeSec` (+ reboot detection) via the same probe path SNMP/FortiOS use. The `eventLog` stream branch is NOT a sample table — it calls `osEventLogService.ingestOsEventLog` to curate entries into the audit Event table (`os_event.*`, resourceType=asset), gated by the `Setting("agentEventLog").enabled` master switch (drops a stale agent's push when off). See cross-cutting/osEventLog. **Process streams (Feature C):** `processInventory` → `persistAssetProcesses` (current-state full-replace); `processTelemetry` → `enqueueProcessSamples` (per-pinned-program CPU/RAM, cadence="fast"); `processLog` → `enqueueProcessLogSamples`; `processConnections` → `persistProcessConnections` (Application Map accumulate+age rows, pushed names intersected with the CURRENT `Asset.mappedProcesses` as a stale-config guard). `GET /config` ships `streams.processes.enabled` (= processesPolling resolves to agent) + a `pinnedProcesses` array (`Asset.monitoredProcesses` joined to `AssetProcessConfig` → `{name, logSource, logPathGlob}`) so the agent telemetry/log loops know which programs to sample + where their logs are, + a plain `mappedProcesses: string[]` array for the connections loop (independent of pinnedProcesses — a mapped-only program must not wake the telemetry/log loops). The heartbeat `computeConfigEtag` folds BOTH pin sets by content (`join("\u0001")`), not count, so a same-count pin swap still refreshes running agents.
- `src/api/routes/agents.ts:POST /system-info` — upserts the `polaris-agent` AssetSource row (externalId = managedAgent.id, observed = full host identity blob), then re-projects hostname / serialNumber / manufacturer / model / os / osVersion against all sources for the asset. Also writes MAC inline: normalize `primaryMac` → colon-upper, merge into `AssetMacAddress` via `reconcileMacAddresses` preserving entries from other sources, set `Asset.macAddress` to the freshest entry by `lastSeen`. MAC isn't owned by `projectAssetFromSources` — every discovery path writes it inline; the agent path matches that convention. Opportunistically bumps `ManagedAgent.agentVersion` when the body carries it.
- `src/api/routes/agents.ts:POST /heartbeat` — refresh agentVersion + bump lastSeenAt.
- `src/services/agentTokenService.ts` — `mintEnrollmentToken` (10-min TTL), `consumeEnrollmentToken` (atomic swap → bearer + stamps asset's 5 per-stream `*Polling` columns to `"agent"` in the same transaction so the active agent owns every stream, and flips `monitored=true` when status permits — `shouldEnableMonitoringOnEnroll` — followed by a `recomputeMonitorOverrideForAssets` pass + `monitor.enabled_by_agent` Event), `revokeBearer` (sets bearerRevokedAt).
- `src/api/routes/agents.ts:GET /config` (write side) — self-heals polling-method drift. When any of `responseTimePolling` / `cpuMemoryPolling` / `temperaturePolling` / `interfacesPolling` / `lldpPolling` / `storagePolling` / **`processesPolling`** isn't `"agent"`, re-stamps all seven, invalidates the monitor-settings cache for the asset's scope, and emits `monitor.polling_overridden_by_agent` (info) with the prior values. **`processes` is agent-default-ON** — an installed agent collects its host's process inventory as part of doing its job (like interfaces/storage), no operator toggle. (`eventLog` is deliberately NOT self-healed — it stays opt-in via the global `agentEventLog` switch because host log text can carry PII + is high-volume.) Covers historical assets enrolled before consumeEnrollmentToken stamped polling columns (pre-commit d43b9d8) and any post-enroll operator clears. Idempotent — once stamped, subsequent /config polls find no drift and skip the write.

**Readers** (consume state):
- `src/api/middleware/auth.ts:requireAgentBearer` — verifies the bearer against the ManagedAgent token store and attaches `{managedAgentId, assetId}` to `req.managedAgent`. Used by every `/api/v1/agents/*` route except `/enroll`.
- `src/api/routes/agents.ts:GET /config` — resolves the asset's monitor settings via `resolveMonitorSettings` and returns the per-stream `enabled` (true when that stream is `polling==="agent"`), cadences, and timeouts; carries an ETag so the agent can short-circuit unchanged polls. The `eventLog` block additionally carries the curation filter (`minLevel` / `windowsChannels` / `linuxMinPriority` / `maxPerPush`) read from `Setting("agentEventLog")` via `getAgentEventLogConfig()`, and is `enabled` only when the stream resolves to agent AND the global master switch is on (the filter is part of the ETag, so a config change invalidates the 304).
- `src/services/monitoringService.ts:probeAsset / collectTelemetry / collectHardwareSensors / collectSystemInfo / collectFastFiltered` — early-return on agent-mode so the periodic puller doesn't touch hosts that the agent owns.
- `src/services/monitoringService.ts:recordProbeResult` — agent-mode guard skipped only when `opts.fromAgent === true`.

**Invariants:**
- ManagedAgent.assetId is `@unique` — one agent install per asset. Reinstall is "delete row + new install."
- Bearer is bound to the assetId at issuance; the /samples handler stamps `req.managedAgent.assetId` server-side and ignores any client-supplied assetId on the wire.
- Cert pin is captured at install kickoff via `certInfo.getServerCertFingerprint()`, which reads `POLARIS_PROXY_CERT_PATH`. Install REFUSES when no fingerprint is available (cert file unreadable, no encrypted transport to pin).
- Enrollment token is one-shot (consumed atomically) and TTL'd to 10 minutes. After consumption it's NULLed on the row; the install state moves to `active` and stays there until DELETE.
- `recordProbeResult` and `record*Result` early-return on agent-mode UNLESS `opts.fromAgent === true` — defends against the synthetic periodic-tick clobbering the agent's real signal.
- **Interface-snapshot timestamp anchor.** The `GET /assets/:id/system-info` read loads the current interface table by exact-equality `assetInterfaceSample.timestamp == lastSystemInfoAt`. The agent must therefore stamp its interface sample rows AND `lastSystemInfoAt` with the SAME value in the `/samples` interfaces branch (the agent reports a full NIC table per push). The agent sends interfaces and storage in SEPARATE pushes, so the storage branch's own `lastSystemInfoAt` bump can move the anchor ahead of the latest interface rows — the read guards against this by falling back to the newest interface sample timestamp when `lastSystemInfoAt` is ahead of it. (The SNMP/FortiOS path writes interfaces+storage in one pass with one `now`, so it never trips either case.) Regression history: agent interface rows were stamped with the agent clock while `lastSystemInfoAt` got the server clock, so the equality match returned zero rows and the System tab interface table was empty for all agent-monitored assets.

**Agent stream config (Phase 0).** Historically the agent IGNORED the `/config` `streams` map and ran every loop unconditionally. The opt-in **`eventLog`** stream changed that: `main.go` keeps an `atomic.Value` `eventLogRuntimeCfg` updated by `applyServerStreams(resp)`, called on startup + heartbeat-ETag change (`refreshConfig`) + the WS `refresh-config` frame. `eventLogLoop`/`pushEventLogOne` gate on `loadEventLogCfg().enabled` so toggling the stream server-side takes effect live (no reinstall). The eventlog collector (`agent/internal/collectors/eventlog*.go`) reads NEW entries since a per-channel cursor in `eventlog-cursors.json` (next to agent.conf; first run seeds at "now" so no history dump), normalizes severity, dedupes, caps, and ships `transport.EventLogSample` rows on stream `"eventLog"`. Windows reader = `wevtutil` (thin-first; native wevtapi is the later swap), Linux = `journalctl --after-cursor`, darwin/other = nil stub. The server `/samples` eventLog branch does NOT write a sample table — it calls `osEventLogService.ingestOsEventLog` (audit Events).

**When changing this:**
- New sample stream: add Zod variant to `SamplesBodySchema`, map to enqueue helper, mirror in the Go agent collector (Phase 3+). For an OPT-IN stream, also gate the agent loop on a server `/config` stream flag via `applyServerStreams` (see the eventLog precedent) rather than running it unconditionally.
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

**Bumping VERSION also requires regenerating the Windows VERSIONINFO
resources** — `make -C agent winres` rewrites the committed
`agent/cmd/polaris-agent/rsrc_windows_{amd64,arm64}.syso` (source:
`winres.json` in the same directory) with the new file/product version.
The .syso files are committed so the server-side `go build` links them
with zero extra tooling; a stale .syso means Explorer → Properties →
Details shows the OLD version on a NEW binary. Non-Windows builds ignore
them entirely.

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
  in-flight upgrade-all status), installed (full per-host list — one row
  per ManagedAgent joined with a thin Asset slice for the "Installed
  agents" slide-in on the Polaris Agents tab; drives per-host
  reinstall/upgrade/remove via the `/assets/:id/agent/*` routes),
  upgrade-all (delegates to `upgradeAllOutdated` in agentInstallService),
  auto-build-setting GET+PUT, auto-upgrade-setting GET+PUT.
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
- `src/services/agentSigningService.ts` — Azure Trusted Signing of the
  two Windows binaries as a post-build step (opt-in via the
  `agent.codeSigning` Setting; Integrations → Polaris Agents → Code
  signing). Owns the masked-secret config (clientSecret follows the
  notificationChannelService MASK/merge discipline), the Entra ID
  client-credentials token fetch, the `java -jar jsign.jar
  --storetype TRUSTEDSIGNING` invocation (token via env
  `POLARIS_SIGNING_TOKEN`, never argv), the `signingAvailability()`
  probe (java on PATH + jar at `tools/jsign.jar` /
  `/opt/polaris/tools/jsign.jar` / `STATE_DIR/tools/jsign.jar`), and
  the durable `agent.signing.lastFailure` Setting behind the sidebar
  alert. `agentBuildService.signWindowsBinaries()` calls it between the
  platform loop and the manifest write; phase `"signing"`, steps
  `sign / windows-<arch>`. **FAIL-OPEN:** a signing failure emits
  `agent.build.sign_failed` (warning) + stamps the failure Setting but
  the build completes and ships unsigned — never blocks agent rollout.
  A fully-signed build (or disabling signing) clears the stamp. Routes:
  `GET/PUT /server-settings/agents/signing` (PUT =
  `serverSettingsSystem:fullwrite`) + `POST .../signing/test`
  (token-fetch dry run); the alert feed is
  `GET /assets/agent-signing-alert` gated `assets:write` (the
  agent-deploy permission — deliberately NOT under /server-settings,
  whose router-level gate only admin passes), polled every 30s by
  `pollSigningAlert()` in `public/js/app.js` with per-user-per-failure
  localStorage dismissal (`polaris.signing-alert.dismissed.<username>`).
- `deploy/setup-{rhel,ubuntu,windows}{,-nodb}.{sh,ps1}` — install Go
  alongside Node + mkdir `$APP_DIR/data/agents` + `$APP_DIR/.cache/go-build`;
  also install Java 17 headless + the SHA-256-pinned jsign jar to
  `$APP_DIR/tools/jsign.jar` (warn-don't-abort — signing is opt-in).
- `Dockerfile` — pulls `golang-go` from bookworm-backports; pre-creates
  `/app/state/.cache/go-build`; installs `default-jre-headless` + the
  pinned jsign jar at `/opt/polaris/tools/jsign.jar`.

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
- Signing (when enabled) runs AFTER the platform loop and BEFORE the
  manifest write — jsign mutates the .exe in place, and nothing
  downstream hashes the binary bytes (integrity = the agent's TLS cert
  pin), so in-place signing is safe. If a per-binary hash is ever added
  to the manifest, compute it after signing. Signing failures are
  fail-open by explicit operator decision: build completes, warning
  Event + failure-stamp Setting + sidebar alert instead of a block.
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
- Bumping the pinned jsign version: update the version + SHA-256 in ALL
  of `Dockerfile`, all six `deploy/setup-*.{sh,ps1}`, and the manual
  install one-liners in `docs/INSTALL.md` ("Optional: Code signing").
  The default jar probe paths in `agentSigningService.JSIGN_JAR_CANDIDATES`
  are version-less (`tools/jsign.jar`), so only the download sites move.

---

## cross-cutting/deployment

**What it is:** The artifacts an operator touches to install, update, or run Polaris on a host: `deploy/setup-{rhel,ubuntu,windows}{,-nodb}.{sh,ps1}` (six fresh-install scripts; Linux variants install split-role + nginx + self-signed cert in one shot since Phase 3), `deploy/migrate-to-nginx.sh` (legacy-install cutover script, used by pre-Phase-3 hosts that were originally provisioned with the now-removed `polaris.service`), `deploy/update-{linux,windows}.{sh,ps1}` (host-side updaters), `deploy/polaris-{web,monitor@,discovery,migrate}.service` + `polaris.target` (systemd units), `deploy/nginx/polaris.conf` + `polaris-nginx-dependency.conf` (nginx reference config + polaris-web Wants=nginx drop-in), `Dockerfile`, `docker-compose.yml` (gained an nginx service in Phase 3), `.env.example`, `docs/INSTALL.md`, and the first-run setup wizard at `src/setup/setupRoutes.ts`. None of these are read by the running app at request time — they shape how the app gets onto a host and what state it expects to find. See CLAUDE.md "Deployment & Updates" and the "Before any push, audit deployment surfaces" rule.

**Writers** (changes in `src/` that the deployment surface must mirror):
- New environment variable consumed by the app — must appear in `.env.example` with a comment, be documented in the CLAUDE.md "Environment Variables" block, be added to `docs/INSTALL.md` if operator-set, and seeded by the relevant `deploy/setup-*.{sh,ps1}` if those scripts write `.env` for the operator. **A var the app auto-generates (a secret) needs seeding on BOTH script branches**: the fresh-`.env` heredoc AND the `.env already exists` backfill, or an existing install that re-runs setup silently never gets it. `SESSION_SECRET`, `HEALTH_TOKEN`, `METRICS_TOKEN` and `POLARIS_SECRET_KEY` are the generated set; only `POLARIS_SECRET_KEY` currently backfills (the others predate the pattern and are load-bearing enough that a fresh value on re-run would log everyone out / break existing scrape configs — think before extending it).
- New runtime dependency — bump in `Dockerfile` (apt/dnf install line) AND in every `deploy/setup-*.{sh,ps1}` that provisions a fresh host. Node major version, Postgres major version, Go pin, system `ping` / `snmpwalk` / `pg_dump` — anything spawned via child_process or required by Prisma / pg-boss counts.
- New `POLARIS_ROLE` capability or worker tunable — `src/utils/role.ts → roleConfig`, matching systemd unit in `deploy/polaris-*.service`, and `polaris.target`'s `Wants=` line. New tuning env vars need declaring in the unit's `Environment=` block or in `/etc/polaris/polaris.env` (sourced by units).
- New Prometheus metric stamped from inside a monitor worker or discovery consumer — confirm the role exposing it has a `/metrics` listener. Web/all serve `/metrics` from the main Express app; monitor + discovery boot a standalone listener via `src/utils/metricsServer.ts` only when `POLARIS_METRICS_PORT` is set (defaults in `deploy/polaris-monitor@.service` = `910%i`, `deploy/polaris-discovery.service` = `9110`). A metric added without a scrape target stays invisible — symptom is "no data" panels on the Grafana dashboard. If the Prometheus scrape config in `docs/grafana/README.md` needs a new job, update it.
- New disk-space minimum — bump `src/setup/setupRoutes.ts → RECOMMENDED_DB_FREE_GB` AND the disk-sizing table at the top of `docs/INSTALL.md`. CLAUDE.md "Deployment & Updates" calls this pair out by name.
- New singleton scheduler / one-shot startup migration — confirm it's gated to `POLARIS_ROLE=web` (or unset = `all`) in `src/app.ts` so multi-process installs don't run it on every monitor / discovery replica.
- New first-run setup step — wizard route + UI in `src/setup/`; the `.setup-complete` marker write at finalize still needs to fire (CLAUDE.md "First-run setup lock").
- New encrypted-backup format change — the magic header is `POLARIS\0` (CLAUDE.md naming note); the restore path must accept the current version's dump and reject older formats with a clear error.
- New Go-version requirement in the agent — bump in lockstep across `agent/go.mod`, every `deploy/setup-*.{sh,ps1}` Go pin, and the Dockerfile `golang-go` source. Already documented in `cross-cutting/polaris-agent` "When bumping agent/go.mod's go 1.x directive."
- Java 17 headless + the jsign jar (agent code signing, optional at runtime) — provisioned by `Dockerfile` and all six `deploy/setup-*.{sh,ps1}` (SHA-256-pinned download to `<app dir>/tools/jsign.jar`, warn-don't-abort). Version bumps follow the checklist in `cross-cutting/polaris-agent-build` "Bumping the pinned jsign version."
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
- **The multi-container `docker-compose.yml` stack is the one install path that auto-generates NO secrets.** It supplies `DATABASE_URL` in `./state/.env`, and a set `DATABASE_URL` is exactly the condition that makes `src/app.ts` boot normally instead of starting the wizard — so the wizard's `SESSION_SECRET` / `HEALTH_TOKEN` / `METRICS_TOKEN` / `POLARIS_SECRET_KEY` generation never runs, and no `deploy/setup-*` script runs either. The single-container / Unraid path DOES reach the wizard and is covered. Anything that makes a generated secret load-bearing must document the compose-side manual step in `docs/INSTALL.md` → Docker.
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

The canonical to mirror for a standalone-device-with-its-own-API type (most common new case) is **standalone FortiGate**. For a manager-that-fronts-many-devices type, mirror **FortiManager**. For asset-only types (no subnets/reservations), mirror **Entra ID / Active Directory** — or **Azure Arc** when the new type is a cloud control plane fronting on-prem hosts (it reuses the Workstations/Servers class blocks unchanged, so most registries need no new branch, but it adds a two-axis filter pair and reuses `entraClientCredentials` at a different OAuth scope) — or **vCenter** when the new type owns multiple asset classes with different capabilities (its `vmMonitor`/`hostMonitor` blocks, `vms`/`hosts` UI subtabs, foreign `AssetDependencyParent.source` value, and warm-cache telemetry polling method are the newest asset-only extensions; vCenter also added per-type entries to `monitorOverrideService`'s block-key maps + both raw-SQL sweeps, `autoMonitorInterfacesService`/`autoMonitorStorageService` class maps, `ClassQuerySchema`/`StorageClassQuerySchema`, `capacityAdvisorService.IntegrationBreakdown`, and the `conflictSourceFor` dispatch in `conflictResolutionService.ts` — walk those too for any multi-class type). See [TEMPLATES.md → Integration type](TEMPLATES.md#integration-type-config--discovery--sync--frontend-modal) for the model-after instruction. This entry is the authoritative checklist.

**Writers** (files that need a per-type branch):
- `src/services/<type>Service.ts` — NEW. Exports `testConnection(config)`, `discoverDhcpSubnets(config, signal?, onProgress?, ...)` returning the shared `DiscoveryResult` shape from `fortimanagerService.ts`, `proxyQuery(config, method, path, query?, body?)` for the manual /query route, and any per-type helpers (e.g. an `xxxRequest()` low-level fetcher used internally).
- `src/api/routes/integrations.ts` — TYPE-SPECIFIC CONFIG SCHEMA: define `<Type>ConfigSchema` (Zod object) at the top of the file. Must include the four uniform top-level keys (`host`, `port`, `verifySsl`, `verboseLogging`) plus `monitorSettings`, `deviceInclude` / `deviceExclude` / `interfaceInclude` / `interfaceExclude` (when applicable), and type-specific credentials. Mirrors `FortiGateConfigSchema` (standalone-device template) or `FortiManagerConfigSchema` (manager-fronted template).
- `src/api/routes/integrations.ts:CreateIntegrationSchema` — DISCRIMINATED UNION BRANCH: add `z.object({ type: z.literal("<type>"), name: ..., config: <Type>ConfigSchema, enabled, autoDiscover, pollInterval })`.
- `src/api/routes/integrations.ts:testConnection handler` — add `else if (integration.type === "<type>")` calling `<type>Service.testConnection(config as any)`.
- `src/services/discovery/discoveryEngine.ts:runDiscovery dispatch` — add a branch calling `<type>Service.discoverDhcpSubnets(...)` (or `syncXxxDevices()` for asset-only types) and pass the resulting `DiscoveryResult` to `syncDhcpSubnets(input.type, result, ...)`.
- `src/services/discovery/discoveryEngine.ts:syncDhcpSubnets` — update the `integrationLabel` ternary with the human-readable label (`"Palo Alto"`, etc.). Function body is generic across types; no other branch needed inside.
- `src/api/routes/integrations.ts:/query proxy route` — add `if (integration.type === "<type>")` calling `<type>Service.proxyQuery(...)`. Define the per-type request body shape (Fortinet uses `{ method, path, query? }`; PAN-OS would use `{ method, path, query?, xpath? }`).
- `src/api/routes/integrations.ts:credential validation` — extend the `(input.type === "fortimanager" || input.type === "fortigate")` predicates to include the new type when it uses the same credential model (SNMP/SSH credential overrides).
- `src/api/routes/integrations.ts:masked-secret restore` — add the new type's secret field names (`apiToken`, `clientSecret`, etc.) to the list `isMaskedSecretSentinel` checks against on PUT.
- `src/services/discovery/discoveryEngine.ts:discoveryScheduler dispatch` — add the new type's auto-discovery branch alongside the FMG/FortiGate/Windows/Entra/AD branches.
- `src/utils/pollingCompatibility.ts` — UNION `AssetSourceKind`: add `| "<type>-firewall"` (or similar). MATRIX `COMPATIBILITY`: add the set of allowed polling methods. SWITCH `assetSourceKindFromIntegrationType`: map `case "<type>": return "<type>-firewall"`.
- `src/utils/assetProjection.ts` — UNION `AssetSourceKind`: add the new source kind. RULES `HOSTNAME_RULES`, `SERIAL_RULES`, `MANUFACTURER_RULES`, `MODEL_RULES`, `OS_VERSION_RULES`, `IP_ADDRESS_RULES`: add an entry per field at the position matching the source's trustworthiness for that field. Manufacturer rules typically pick a fixed string (`"Palo Alto Networks"`) ignoring the observed blob.
- `src/services/monitoringService.ts:defaultPollingForSource` — add a per-stream defaults branch for the new source kind. REST-capable appliances mirror FortiGate (**`icmp` on response-time**, `rest_api` on telemetry/temperature/interfaces, `disabled` on LLDP/storage); identity sources mirror AD (`icmp` on response-time, `not_delivered` on the heavy streams).
- `src/services/monitoringService.ts:transport dispatch` — extend `isFortinetSrc`-style branching only when the new type uses a different credential model than FortiOS (e.g. a header-key auth scheme instead of bearer). If the new type's `config` has `apiToken` like FortiGate, no transport-dispatch change is needed.
- `public/js/integrations.js:_POLLING_COMPAT` — add the new type's allowed polling methods, mirroring its backend pollingCompatibility entry.
- `public/js/integrations.js:_SOURCE_TELEMETRY_MIB` — add the per-type telemetry MIB default (or null if the type doesn't expose SNMP telemetry).
- `public/js/integrations.js:<type>GeneralHTML(defaults)` — NEW form helper. Mirrors `fortiGateGeneralHTML` or `fortiManagerGeneralHTML`. Append `verboseLoggingFormHTML(d)` at the bottom of the returned string so the Debug section stays uniform.
- `public/js/integrations.js:<type>FiltersHTML(defaults)` — NEW (when applicable). Mirrors `fortiGateFiltersHTML` for device/interface/DHCP include/exclude wildcards.
- `public/js/integrations.js:<type>FormHTML(defaults)` — NEW. Combines General + Filters, mirrors `fortiGateFormHTML`.
- `public/js/integrations.js:get<Type>FormConfig()` — NEW reader. Returns the config object parsed from the modal's input fields. Must include `verboseLogging: readVerboseLoggingFromForm()` so the Debug section roundtrips.
- `public/js/integrations.js:form dispatch ternaries` — extend each to include the new type. These switch on `type === "<value>"` for form HTML selection, config reader selection, label rendering, and per-type booleans.
- `public/js/integrations.js:openCreateModal tab visibility` — if the new type supports DHCP Push / Quarantine Push, extend `isFmg || isFgt` to include it. If not, add a separate branch alongside `isAd || isEntra || isWin` (Monitoring tab only).
- `public/js/integrations.js:openCreateModal edit branch tab visibility` — same extension on the edit path.
- `public/js/integrations.js:type-list picker grid` — NEW button (`pick-<type>`) + its click listener calling `openCreateModal("<type>")`.
- `public/js/integrations.js:type-label ternaries` — `intg.type === "<type>" ? "<HumanLabel>" : ...` in both places (integrations list + modal title).
- `public/js/integrations.js:Monitoring tab visibility` — if the new type owns devices that can be monitored as a class (FortiSwitch / FortiAP style), extend `isFmgFgt`. Most new types skip this — only the FMG-FortiGate-managed-device pattern needs the class-level auto-monitor cards.
- `public/js/integrations.js:_CLASS_SUBTAB_SPECS` — per-type Monitoring class subtab set. `monitorSettingsFormHTML` has a generic single-subtab fallback, so a missing entry degrades quietly rather than erroring.
- `public/js/integrations.js:_isWsSrvRichType()` — the ONE predicate deciding whether a workstation/server type gets the full card set (agent auto-deploy + interface/storage auto-monitor) or the bare addAsMonitored card. Three callers (auto-monitor seed stash, `headerForClass`, `_wireMonitoringTabSubtabs`' prefix map) share it; they used to be three retyped lists, and any two drifting apart is what produces "the cards render but saved selections don't seed".
- `public/js/integrations.js:_polarisSourceLabel()` — the source name in every `Inherit (Source <X>: …)` option across the Monitoring tab and the Assets-page override editors. A missing entry silently mislabels every one of them "Manual".
- `public/js/integrations.js:loadIntegrations()` — the empty-state copy, the type badge, the `detailRows` chain, and the Query-API button.
- `public/js/integrations.js:verifyPresence gate` — the integration-level presence-verification checkbox (an explicit type list, NOT `_isWsSrvRichType` — its membership genuinely differs: it includes vCenter and excludes Windows Server).
- `public/js/integrations.js:_intgEditFormSpec()` / `_wireIntgEditTest()` / `_wireIntgEditSave()` — the edit-path defaults blob, the blank-secret strip that makes "leave blank to keep current secret" work, and the class-block + monitor-settings save gates.
- `public/js/integrations.js:open<Type>ApiQueryModal()` — needed whenever the type has a `/query` branch; it is the operator's only self-service way to answer "why didn't device X get discovered".
- `public/js/assets.js:sourceSupportsAgent` — gates the **Install Polaris Agent** button on the asset modal. Load-bearing for any type whose story includes agent deploy.
- `public/js/assets.js:_assetIntegrationLabelWithController()` typeLabels and `public/js/app.js:renderIntegrationFailedStatus()` typeLabel — both fall through to the RAW type string, so a missing entry renders e.g. `azurearc` to the operator.
- `src/services/presenceVerificationService.ts` — the `sourceKind: { in: [...] }` candidate filter. A new asset-only source kind must be added or the pass finds zero candidates.
- `src/utils/assetSourceDerivation.ts` — suppress the `manual` fallback for the new type's tag, or the shadow-write extension mints a spurious `manual` source row in the window between `Asset.create` and the explicit source upsert.
- `src/utils/assetInvariants.ts` — `LastSeenSource` union + `POLLING_DEFERRED_SOURCES`, but ONLY when the new type reports a real-time presence signal (a stored directory timestamp must never write `lastSeen`).
- `src/services/conflictResolutionService.ts` — `AssetConflictSource`, `conflictSourceFor`, `conflictSourceLabel`, both source-tag blocks, the default-assetType pick, and the observed-blob builder.
- `src/services/capacityAdvisorService.ts` — `IntegrationBreakdown` field + initializer + the count arm.
- `tests/unit/pollingCompatibility.test.ts` — the matrix test locks an exact ordered array per source. A new kind MUST be added; without it `assetSourceKindFromIntegrationType` silently resolves to `manual` (the most permissive matrix).
- `docs/INSTALL.md` — the "Secrets at rest" credential-kind sentence.

**Readers** (files that consume the new type without needing a new code branch):
- `src/services/discovery/discoveryEngine.ts:syncDhcpSubnets` body — consumes `DiscoveryResult` generically; new types ride it for free if their service returns the exact shape.
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

**What it is:** FMG and standalone FortiGate integrations share feature surfaces that must move together: integration modal tabs (General / Filters / Monitoring / DHCP Push / Quarantine Push / Description Sync / SD-WAN / Geographic Location), transport dispatch via buildTransportForIntegration(), and filter helpers. This entry is narrower than [cross-cutting/integration-type-onboarding](#cross-cuttingintegration-type-onboarding) — that one covers adding any new type; this one covers the FMG↔FortiGate paired-feature parity that must move together once both types exist.

**Writers** (files that mutate or emit this state):
- `src/api/routes/integrations.ts` — POST / PUT integration handlers parse both fortimanager and fortigate integration types, store config.pushReservations / pushQuarantine / monitorSettings / deviceInclude/Exclude in the same JSON shape
- `src/services/reservationPushService.ts` — buildTransportForIntegration() dispatches to FMG proxy/direct or FortiGate direct transport based on integration.type
- `src/services/assetQuarantineService.ts` — quarantineAsset() / releaseQuarantine() use buildTransportForIntegration() for both FMG and FortiGate
- `src/services/fortigateLocationService.ts` — fetchFortigateSysLocation() uses buildTransportForIntegration() + callFortiOs() for both FMG and FortiGate
- `src/services/fortigateCoordPushService.ts` — FMG-mode pushes to metavars + CMDB natively (no proxy); standalone pushes CMDB via direct REST. Same source-of-truth dispatch pattern as the other push services.
- `src/services/descriptionSyncService.ts` — description push/adopt (interface comments + device descriptions, Polaris-primary) uses buildTransportForIntegration() + callFortiOs() for both FMG (proxy AND bypass/direct) and standalone FortiGate; gated by config.syncDescriptions on both types.
- `public/js/integrations.js` — Integration modal tab bodies for General (useProxy, Filters), Monitoring, DHCP Push, Quarantine Push, Description Sync. FortiGates Monitoring subtab now also carries the `pullSnmpLocation` / `pushGeocodedCoords` toggles.

**Readers** (files that consume it):
- `src/services/discovery/discoveryEngine.ts` — Discovery sync paths read pushReservations toggle to decide whether to push DHCP changes
- `src/services/discovery/discoveryEngine.ts` — Discovery sync paths read pushQuarantine to decide whether to push quarantine entries
- `src/services/reservationService.ts` — Reserve/release flows call buildTransportForIntegration() to dispatch push/unpush calls
- `src/services/assetQuarantineService.ts` — Quarantine push consults buildTransportForIntegration() and pushQuarantine toggle
- `public/js/assets.js` — Asset details modal wires up quarantine/release buttons that call the quarantine endpoints
- `src/utils/integrationFilter.ts` — assetMatchesIntegrationFilter() checks deviceInclude/Exclude for FMG/FortiGate and ouInclude/Exclude for AD (not shared)

**Invariants:**
- FMG and FortiGate must have identical modal tab layouts and toggle names (pushReservations, pushQuarantine, syncDescriptions, pullSdwan, monitorSettings JSON, deviceInclude/Exclude).
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

## cross-cutting/asset-management-access

**What it is:** `Asset.managementAccess` is a read-only summary of a Fortinet device's management-access (`allowaccess`) config: `{ source, interfaceName, profileName, mgmtIp, protocols: string[] | null, https, ssh, snmp, checkedAt }`. Read during FMG/FortiGate discovery; drives the asset slide-over's Open HTTPS / Open SSH buttons and the FortiAP SNMP-disabled warning. Monitor/discovery-owned — never projected from `AssetSource`.

**Writers** (files that mutate this state):
- `src/services/fortinetManagementAccessService.ts → collectManagementAccess` — builds the summaries from FortiOS CMDB reads (firewall `system/interface`, FortiAP `wireless-controller/{wtp-profile,wtp}`, FortiSwitch `switch-controller/managed-switch`). Pure parsers exported + unit-tested. Read-only against the device.
- `src/services/discovery/discoveryEngine.ts → syncDhcpSubnets` Phase 13.6 — groups discovered firewalls/switches/APs by controller FortiGate, calls `collectManagementAccess`, joins `Map<serial, summary>` to assets via the `AssetSource` rows (externalId === serial), writes in chunked `$transaction` batches. Gated `mode in {full, finalize}`; always-on; FMG/FortiGate only; best-effort.

**Readers** (files that consume it):
- `public/js/assets.js` — `_assetMgmtAccess` / `_managementAccessButtonsHTML` (footer Open HTTPS + Open SSH split-button) + `_managementAccessNoticeHTML` (AP warning banner). SSH launch via `ssh://[user@]host` URI or copy-command, per-user prefs in localStorage (`polaris.ssh.action`, `polaris.ssh.user`). `managementAccess` rides on the `GET /assets/:id` payload (full-row `include`, no narrowing select).

**Invariants:**
- Read-only — nothing here writes the device. `protocols: null` means the access list couldn't be read (best-effort switch path); the UI renders buttons optimistically with an "unverified" note rather than hiding them.
- Firewall management interface is the operator-named `Integration.config.mgmtInterface` (reused, not a new field). FortiSwitch defaults to `internal` (override: `config.switchManagementInterface`).
- FortiSwitch + FortiAP REST field shapes are **not yet verified on a live FortiOS 7.x device** — keep parsers defensive (never throw; degrade to `protocols: null`).

---

## cross-cutting/asset-last-seen-presence

**What it is:** `Asset.lastSeen` means **verified network presence** — the last time Polaris had direct evidence the device was alive on the network — with `Asset.lastSeenSource` carrying the evidence label. Every write routes through `src/utils/assetInvariants.ts → bumpLastSeen()` (no-regress: only advances; stamps provenance) EXCEPT the monitor hot path, which writes through the `probePatchBuffer` bulk-update (see below). Directory timestamps (Entra `lastSyncDateTime`, AD `lastLogonTimestamp`) are deliberately NOT presence — they live on `AssetSource.lastSeen` and render separately as "Last Directory Activity".

**Polling is authoritative for monitored assets:** when `Asset.monitored === true`, `bumpLastSeen` refuses the discovery-origin sources (`POLLING_DEFERRED_SOURCES` = `discovery` / `device-inventory` / `dhcp-lease`) so only the monitor probe drives presence. A monitored-but-down device's `lastSeen` freezes at its last successful poll regardless of what discovery reports. The device-inventory-outranks-lease ordering below only matters for UNmonitored assets.

**Writers** (files that mutate this state):
- `src/services/monitoringService.ts → recordProbeResult` — **monitor hot path**: a successful probe stamps `lastSeen = now, lastSeenSource = "probe"` via `enqueueProbePatch` (the `probePatchBuffer` bulk `UPDATE ... FROM VALUES` flush, NOT a Prisma write / not `bumpLastSeen`). A failed probe omits both, so the flush's `COALESCE(v.last_seen, t."lastSeen")` freezes presence at the last success. This is the sole presence authority for any monitored asset.
- `src/services/discovery/discoveryEngine.ts → syncDhcpSubnets` — FMG/standalone-FortiGate sync stamps (all gated by `bumpLastSeen`, so suppressed on monitored assets):
  - Phase 6 DHCP: gated on `entry.seenLeased` (live lease), source `"dhcp-lease"`. Offline static reservations neither bump nor flip status. **Defers to device inventory** (unmonitored): when the entry's MAC is in this cycle's `result.deviceInventory` (the `inventoryMacSet`), the lease bump + status flip are skipped so Phase 7's real `last_seen`/`is_online` wins — a bound-but-idle lease must not stamp `now`. Lease-only assets (inventory disabled / MAC not in the device table) keep the lease bump. **Skipped entirely for Fortinet-discovery-owned infra** (`isFortinetOwnedInfra` = firewall/switch/access_point assetType + non-null `fortinetTopology`): those devices' presence is owned by their own discovery loops (gated on answered-live/connected) + the probe, and a lease that stays bound past shutdown must not keep an offline-in-FMG gate's lastSeen advancing every run. Operator-typed non-Fortinet "firewall"/"switch" assets (no topology stamp) keep the endpoint-style bump — a client sighting is their only evidence.
  - Phase 7 device inventory: evidence is the FortiGate's per-client `last_seen` (or `now` when `is_online`), source `"device-inventory"`. Resurrection (`decommissioned → active`) requires `is_online`. **Authoritative over the lease** for any MAC it covers (unmonitored). On monitored assets `bumpLastSeen` drops it — the probe owns presence. **Skipped for Fortinet-discovery-owned infra** (`invIsFortinetOwnedInfra`, same rule + rationale as the Phase 6 guard — FortiOS's cached `is_online` lags reality and infra boxes appear as DHCP clients of their own gate).
  - Firewall / FortiSwitch / FortiAP phases: source `"discovery"`; switch gated on `sw.connected`, AP on `apOnline` (status "connected" or blank), firewall gated on `!memberDevice.offline` (an offline-in-FMG gate is CMDB-cache-sourced, `DiscoveredDevice.offline=true`, so it neither bumps lastSeen nor resurrects a decommissioned firewall — the FMG parse now emits offline gates for their cached IP config instead of skipping them). Suppressed on monitored assets. With the Phase 6/7 owned-infra skips above, these gates + the probe are the ONLY lastSeen writers for Fortinet infra — an offline firewall's Last Seen freezes at the last cycle it answered. The fortigate-firewall **AssetSource** row's lastSeen follows the same rule (`upsertFortigateFirewallAssetSource` takes `lastSeen: Date | null`; offline pulls pass null and refresh only observed/syncedAt).
- `src/services/discovery/discoveryEngine.ts → syncEntraDevices / syncActiveDirectoryDevices` — do NOT write lastSeen (cut over in the directory-decoupling change). Directory activity goes to `AssetSource.lastSeen` via the source upserts.
- `src/services/presenceVerificationService.ts → runPresenceVerification` — AD/Entra post-sync pass (default on, `config.verifyPresence`): sources `"agent"` (ManagedAgent heartbeat), `"probe"` (answering monitor probe via `lastMonitorAt`), `"ping"` (ICMP fallback). Ping failure writes nothing. Now that the hot path stamps `"probe"` directly, monitored assets typically hit the "already fresh" short-circuit here.
- `src/services/conflictResolutionService.ts` — accept path (`"conflict-accept"`, via bumpLastSeen), reject-creates-asset path (`"conflict-reject"`), ghost absorption carries the ghost's source along.
- `src/services/assetMergeService.ts` + `src/jobs/mergeDuplicateHostnameAssets.ts` — max(lastSeen) winner carries its `lastSeenSource` onto the survivor.

**Readers** (files that consume it):
- `src/jobs/decommissionStaleAssets.ts` — `lastSeen < cutoff` eligibility, with a **veto** when any `entra`/`intune`/`ad`/`polaris-agent` AssetSource row has `lastSeen >= cutoff` (cloud-only laptops / agent-reporting hosts stay alive). Null lastSeen is never eligible.
- `src/services/discovery/discoveryEngine.ts → buildEntraSyncIndex.directoryActivityByAssetId` — the Entra duplicate-registration tiebreaker compares **directory activity** (AssetSource.lastSeen), not Asset.lastSeen.
- `public/js/assets.js` — slide-over "Last Seen" row renders `lastSeen + " · via " + LAST_SEEN_SOURCE_LABELS[lastSeenSource]`; "Last Directory Activity" row computed from the sources fetch; assets table + CSV/PDF exports show the date only.
- `src/services/presenceVerificationService.ts → classifyPresenceSignal` — "already fresh" short-circuit reads it.

**Invariants:**
- Never write `Asset.lastSeen` / `lastSeenSource` directly — route through `bumpLastSeen(data, existing, evidenceAt, source)`. The ONE exception is the monitor hot path (`recordProbeResult` → `probePatchBuffer`), which stamps `"probe"` on success through the bulk UPDATE; the buffer's COALESCE provides the same no-regress guarantee on the failed-probe path.
- For monitored assets, polling wins: `bumpLastSeen` returns false for `discovery`/`device-inventory`/`dhcp-lease` when `existing.monitored === true`. Pass an `existing` that carries `monitored` from discovery call sites (the sync preloads all asset scalar fields, so it does).
- lastSeen never moves backward. A stale evidence source (FortiOS remembering a device from weeks ago) must not regress a fresher sighting.
- Absence of evidence is not evidence of absence: failed pings, offline inventory rows, disconnected switch/AP entries, and failed probes leave lastSeen (and status) untouched.
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
- `src/services/reservationPushService.ts:classifyPushError` — Single source of truth for permanent (400/404/409, 502 with "verify mismatch" / "not visible on read-back" / "Authentication failed" / "permission denied") vs transient (everything else — defaults to retry-eligible). Used by both create-time and retry-tick paths. The "permission denied" fragment catches HTTP 403 from BOTH transports (`fortigateService.fgRequest` and `fortimanagerService.rpc` word it the same way) — an access-profile or trusthost problem needs an operator on the device, so retrying until the queue gives up only buries the reason. Note 403 is deliberately NOT folded into the 401 "Authentication failed" wording: a 403 means the token authenticated and FortiOS refused THAT endpoint, and conflating them sends operators to re-issue a working token.
- `src/services/reservationPushService.ts:pushReservation`/`updatePushedReservation`/`unpushReservation` — buildTransportForIntegration() + create / update / delete + read-back verify on FortiOS. `unpushReservation` accepts pinned scopeId/entryId OR resolves them (scope-by-CIDR, entry-by-IP) when null — the discovered-row delete path.
- `src/services/reservationService.ts:createReservation` push branch — Pre-flight: when the firewall Asset is monitored AND `monitorStatus="down"`, skip the transport attempt entirely and queue with `pushStatus="pending"`/`pushQueuedAt=now`/`pushAttempts=0`. On transport attempt: success → stamp `sourceType="dhcp_reservation"`/`pushStatus="synced"`/push pointers + clear queue cols. Transient failure → keep row, stamp `pushStatus="pending"`/`pushQueuedAt`/`pushAttempts=1`/`pushLastAttemptAt`. Permanent failure → existing rollback.
- `src/services/reservationService.ts:updateReservation` — When `pushStatus="pending"`, skip `updatePushedReservation` entirely; just rewrite the queued payload (MAC, hostname, notes, ...). Retry tick picks up the new values on its next attempt.
- `src/services/reservationService.ts:releaseReservation` — When `pushStatus="pending"`, skip `unpushReservation` AND `releaseDhcpLease`; clear queue cols + flip to `released`; emit `reservation.push.queued.released` instead of the `reservation.unpush.failed` warning the old path would have logged. For non-pending dhcp_reservation rows it unpushes (Polaris-pushed: by pinned ids, always; discovered: resolve-by-CIDR/IP, only when pushReservations=true) AND drops the IP's lease via `releaseDhcpLease` — both best-effort, logging `reservation.unpush.*` / `reservation.lease_release.*`.
- `src/services/reservationService.ts:retryPendingReservations` — 60s retry-tick entry. Eligibility re-check (subnet drift, integration deleted/disabled, pushReservations flipped off, no fortigateDevice) → `pushStatus=null` + emit `reservation.push.queued.cancelled`. Discovery-supersede check (another active row at same IP) → `pushStatus="failed_permanent"` + emit `reservation.push.queued.collided`. Readiness gates (monitored gate must be `monitorStatus="up"`; unmonitored uses exponential backoff `min(60 * 2^(attempts-1), 1800)`s) → skip without attempt increment. Otherwise increment attempts, push, classify, stamp synced / failed_permanent / leave pending. Emits `reservation.push.queued.{succeeded,retry_failed,failed_permanent}` per outcome.
- `src/services/reservationService.ts:retryReservationNow` — Operator-triggered single-row retry from the IP panel "Retry" button + Events page push-queue panel. Bypasses readiness gates; bumps `failed_permanent` rows back to `pending` first. Emits `reservation.push.queued.retry_manual`.
- `src/services/reservationService.ts:triggerRetryAfterStatusChange` — Called from `monitoringService.recordProbeResult` when a firewall asset transitions to `up`. Count-gated (zero-pending = early return) so most up-transitions cost one indexed COUNT(*).
- `src/jobs/retryQueuedReservationPushes.ts` — 60s tick wrapping `retryPendingReservations` via `runInstrumentedJob`. Independent `running` guard. First tick delayed 60s after boot.
- `src/services/monitoringService.ts` — After `propagateAfterStatusChange`, fires `triggerRetryAfterStatusChange` only when `nextStatus === "up"`.
- `src/services/subnetRefreshService.ts` — Per-subnet Refresh action: fast-path adopt pending rows whose MAC matches a discovered dhcp_reservation (uses CMDB entry id from `listReservedAddresses` in-scope); hard-collide pending rows whose MAC mismatches (flip to `failed_permanent`).
- `src/services/discovery/discoveryEngine.ts:syncDhcpSubnets` — Same fast-path adopt + hard-collide logic for full-discovery flows. Reads `entry.scopeId` / `entry.entryId` from the DiscoveredDhcpEntry shape (populated by fortimanagerService + fortigateService at extraction time from `server.id` / `entry.id`).
- `src/services/discovery/discoveryEngine.ts:syncDhcpSubnets` Phase 5b — Releases active `dhcp_reservation` rows (including ex-Polaris-pushed-manual rows that flipped to `dhcp_reservation` on first sight) whose CMDB query succeeded this cycle but whose `(subnetId, ip)` isn't in `result.dhcpEntries`. Clears `pushedToId`/`pushedScopeId`/`pushedEntryId`/`pushStatus`. Gated to `subnet.discoveredBy === integrationId` so other integrations' rows are never touched. Auto-rejects pending conflicts on the released row. Writes `reservation.dhcp_reservation.released` Event.
- `src/api/routes/reservations.ts:POST /:id/retry-push` — Operator-facing route, ownership-gated (own rows for `write`, all for `fullwrite`). Wraps `retryReservationNow`. Allowed on `pushStatus IN ("pending", "failed_permanent")`.
- `src/api/routes/reservations.ts:GET /push-queue` + `GET /push-queue/count` — Read-everyone; powers the Events-page Alerts panel "Push queue" filter view and the combined sidebar badge.

**Readers** (files that consume it):
- `src/services/reservationService.ts:listReservations` — Decorator no-op'd to pass through `pushStatus`/`pushQueuedAt`/`pushAttempts`/`pushError` to every reservation row.
- `src/services/reservationService.ts:listPushQueue`/`countPushQueue` — Filters `pushStatus IN ("pending","failed_permanent") AND status="active"`; joins subnet + pushedTo for the queue view.
- `src/api/routes/reservations.ts` — Success-toast suffix uses `pushStatus`: synced → "and pushed to FortiGate"; pending → "queued for push (FortiGate unreachable; will retry automatically)"; null → "".
- `public/js/ip-panel.js` — Reservation row status pill: pending → amber "Queued for push" + tooltip (queued-ago, attempts, last error); failed_permanent → red "Push failed" + tooltip with error. Retry button rendered for both pushStatus values when caller has write-ownership.
- `public/js/events.js` — Alerts panel filter "Push queue" calls `listPushQueue` + renders cards with Retry / Free buttons. Combined Alerts-button badge count = stale alerts + push queue; after operator actions, `refreshBadge` calls `window.refreshAlertsDot()` (a back-compat alias to `refreshConflictDot`) so the single Events dot stays in sync with the panel.
- `public/js/app.js:refreshConflictDot` — The single sidebar alert dot, rendered only on the Events nav entry. Displays when `(conflicts.count + pushQueueCount + alertsCount) > 0`; shows red when `conflicts.count > 0`, otherwise yellow (`nav-conflict-dot--warning`) for stale-reservation alerts / queued pushes (red precedence). `window.refreshAlertsDot` is a back-compat alias to this function — there is no separate IPAM dot.
- `src/services/discovery/discoveryEngine.ts` — Discovery sync reads pushReservations toggle to gate DHCP reservation creation
- `src/services/discovery/discoveryEngine.ts:syncDhcpSubnets` upsert loop — Checks `existingRes.pushStatus === "pending"` BEFORE the legacy `existingRes.pushedToId` branch so a queued row isn't silently flipped to dhcp_reservation as if it were our own echo.
- `src/services/fortimanagerService.ts:DiscoveredDhcpEntry` + `localDhcpEntries.push` in CMDB read — Populates `scopeId` (from `server.id`) and `entryId` (from `entry.id`) so the integration sync's fast-path adopt has device-side pointers in hand without a second REST call.
- `src/services/fortigateService.ts` — Same `scopeId`/`entryId` population at the standalone-FortiGate dhcp reservation read site.

**Invariants:**
- DHCP reservations are MAC→IP pairs; only per-IP (not full-subnet) manual reservations are push-eligible.
- pushedScopeId + pushedEntryId are resolved AT PUSH TIME and pinned for Polaris-pushed rows; used at unpush without re-querying the FortiGate. DISCOVERED (never-pushed) dhcp_reservation rows carry no pointers — on release `unpushReservation` resolves scope-by-CIDR + entry-by-IP at release time (same pattern as `updatePushedReservation`'s discovered path).
- sourceType flip to "dhcp_reservation" is ONLY set on successful push. While `pushStatus="pending"` the row stays `sourceType="manual"` because nothing's on the device yet.
- On release of a dhcp_reservation, the device-side entry is deleted (unpush) AND any active lease for the IP is dropped (releaseDhcpLease). Polaris-pushed rows unpush regardless of the current pushReservations toggle (cleanup); DISCOVERED rows unpush+lease-release only when pushReservations=true (read-only-discovery installs leave device config alone). Both are best-effort + skipped entirely for pending rows.
- Lease release for a discovered dhcp_lease sourceType row happens ONLY where the originating integration's pushReservations=true AND the row is not pending (queued rows have no device-side state to release).
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
- Test discovered-reservation release: with pushReservations=true, release a dhcp_reservation that Polaris discovered (no pushedScopeId/pushedEntryId). Confirm unpushReservation resolves scope-by-CIDR + entry-by-IP and DELETEs the device entry, the IP's lease is dropped via releaseDhcpLease, and `reservation.unpush.succeeded` + `reservation.lease_release.succeeded` fire. With pushReservations=false, confirm the device is left untouched (local release only).

---

## cross-cutting/fortigate-snmp-location-and-coord-writeback

**What it is:** Discovery-time location → coords resolution for FMG/standalone-FortiGate-discovered firewalls. The geocode source string is resolved per device: a FMG **address metavar** (named by `fortigateMonitor.addressMetavar`, opt-in) wins when set+populated, else SNMP `sysLocation` (pulled via REST `GET /api/v2/cmdb/system.snmp/sysinfo` when `pullSnmpLocation` is on) — but the sysLocation fallback participates ONLY when `useSnmpLocationCoords` is also on, since the geocoded pair is projection tier-1 and overrides device-learned coords; the chosen string is geocoded via Nominatim → `Asset.latitude` / `Asset.longitude`. SNMP sysLocation (when pulled) is always stored raw on `Asset.snmpLocation` (General tab display + the asset edit modal's Location-field prefill when no operator location is set); the address-metavar string is projected to `Asset.learnedAddress` ("Address" on the General tab). Optional opt-in write-back closes the loop: when the geocoded coords don't match the FortiGate's current CMDB GUI fields, Polaris pushes them to FMG coordinate metavars (named by `latitudeMetavar`/`longitudeMetavar`, default `Latitude`/`Longitude`) AND CMDB (`gui-device-*`) for FMG mode, or just CMDB for standalone. Per-integration `fortigateMonitor` controls: `pullSnmpLocation` (SNMP enable), `useSnmpLocationCoords` (sysLocation → coords, requires the pull; default off — pre-2026-07 builds geocoded implicitly whenever the pull was on), `addressMetavar` (address geocode source), `pushGeocodedCoords` (write-back, enabled when sysLocation-coords is on OR an address metavar is named), `latitudeMetavar`/`longitudeMetavar` (coord metavar names). All metavar fields are FMG-only.

**Writers** (files that mutate or emit this state):
- `src/services/fortigateLocationService.ts` — fetchFortigateSysLocation() returns trimmed sysLocation string or null. REST-only, reuses callFortiOs + buildTransportForIntegration so it works in both FMG proxy and direct mode (and doesn't need network reachability to the FortiGate's mgmt IP when in proxy mode).
- `src/services/geocoderService.ts` — geocode() with positive+negative `GeocodeCache` (90-day TTL) + 1 req/sec rate limiter (module-level chained Promise). Transport failures do NOT poison the cache; only successful responses write rows. Never throws.
- `src/services/fortigateCoordPushService.ts` — pushCoordsToFortigate(integration, deviceName, lat, lng, latMetavar?, lngMetavar?) dispatches BOTH metavars + CMDB writes (FMG mode) or CMDB only (standalone). Metavar names default to `Latitude`/`Longitude`; the caller passes the integration's configured names. Best-effort: per-target failures collected in the returned `{ok, targets[], error?}` shape, never thrown.
- `src/services/fortimanagerService.ts:setFmgDeviceMetavarCoords` (`set` on `/pm/config/adom/<adom>/obj/fmg/variable/<name>/dynamic_mapping`, one request, lat+lng params) + `setFmgDeviceCmdbGuiCoords` (`update` on `/pm/config/device/<n>/global/system/global`) — native FMG helpers used by the push service. Both go through the worker's native lane (no proxy throttle). Coordinate metavars are the modern Policy & Objects **metadata variables** (per-device values are `dynamic_mapping` entries scoped by device name) — NOT the legacy `dvmdb` device "meta fields" (which returns -10/-3 on installs that moved metavars to Policy & Objects). `set` on the `dynamic_mapping` sub-path UPSERTS just the matching `_scope` entry (verified live); `oid` is FMG-assigned and omitted.
- `src/services/fortimanagerService.ts:fetchFmgMetavarCoordMap(config, latMetavar, lngMetavar, addrMetavar, signal?, integrationId?)` — PRIMARY metavar coord read: one JSON-RPC `get` over the Policy & Objects coordinate variable objects, parsed by the pure `parseFmgVariableDynamicMapping(varData)` into a `deviceName(lowercased) → {latitude?, longitude?, address?}` map (the ADOM-wide top-level `value` is deliberately NOT applied per-device). Best-effort: per-param `-3` (variable undefined on this ADOM) tolerated; any RPC failure → empty map, never throws. `discoverDhcpSubnets` fetches the fleet map once per run and `resolveMetavarCoords(rawDevice, deviceName)` prefers it, falling back to `extractMetavarCoordsFromFmgDevice` per device.
- `src/services/fortimanagerService.ts:extractMetavarCoordsFromFmgDevice(raw, latName?, lngName?, addrName?)` — LEGACY fallback: parses coordinate + address metavars from FMG `/dvmdb/adom/<adom>/device` "meta fields" (case-insensitive against the configured names) when the list query carries `option: ["get meta"]`. Names default to `Latitude`/`Longitude` with the address metavar blank-disabled. Both read paths surface as `DiscoveredDevice.metavarLatitude` / `metavarLongitude` / `metavarAddress`. `discoverDhcpSubnets` resolves the names once from `config.fortigateMonitor` and threads them into both (direct + proxy) call sites.
- `src/services/discovery/discoveryEngine.ts:syncDhcpSubnets` Phase 3 — Once per device (NOT per HA member): resolves the geocode source string (address metavar wins; SNMP sysLocation fallback when pulled), geocodes it, stashes results into the per-device closure variables (`devSnmpLocation` / `devSnmpLocationFetchedAt` / `devGeocodedLat` / `devGeocodedLng`; verbose log `discovery.location.geocoded` carries a `geoSource` of `address-metavar`|`snmp`). Each per-member `memberDevice` build carries these + `metavarAddress` forward into the observed blob via buildFortigateFirewallObservedBlob. `updateData.snmpLocation` / `snmpLocationFetchedAt` are stamped when pulled; `updateData.learnedAddress` is stamped only when an address metavar is configured this cycle (update + create). Write-back call fires AFTER the per-member loop — only when geocoding succeeded AND `coordsClose(geocoded, cmdb, 1e-5)` returns false; passes the configured `latitudeMetavar`/`longitudeMetavar`. Emits `integration.coords.pushed` or `integration.coords.push_failed` Events.
- `src/utils/assetProjection.ts:LATITUDE_RULES` / `LONGITUDE_RULES` / `SNMP_LOCATION_RULES` / `LEARNED_ADDRESS_RULES` — three-tier coord priority on the `fortigate-firewall` source: snmpGeocoded (geocoded-location result) → coordinate metavar → CMDB. Each picker validates the full (lat,lng) pair via `isValidGeoCoord` so a half-valid tier falls through. `snmpLocation` (raw SNMP string) and `learnedAddress` (`metavarAddress`) are separate projected string fields.
- `src/api/routes/assets.ts` POST `/assets` + PUT `/assets/:id` — operator-typed manual coordinates (any asset type, `assets:write`). Pair-validated via `manualCoordPatchError` (utils/geo.ts); a real value change stamps `Asset.coordSource="manual"` (clear → NULL); an edit-form save echoing the current values back is a no-op (does NOT pin). Manual coords are audit-tracked in the `asset.updated` Event changes and fire a best-effort `reconcileMapRegions()` when the asset is a firewall.
- `prisma/schema.prisma` — Asset.snmpLocation / Asset.snmpLocationFetchedAt / Asset.learnedAddress / Asset.coordSource columns; GeocodeCache model.

**Readers** (files that consume it):
- `public/js/assets.js` — Renders "Address" viewRow (from `a.learnedAddress`) and "SNMP Location" viewRow (from `a.snmpLocation`) on the asset details General tab when each is set.
- `public/js/integrations.js` — `geographicLocationFormHTML` renders the SNMP-pull / sysLocation-coords / push-back toggles plus the three metavar-name fields (FMG-only); `_readFortigateMonitorBlock` reads them back; `window._geoRecomputePush` reactively enables the sysLocation-coords checkbox when the pull is on, and the push checkbox when sysLocation-coords is on OR an address metavar is named.
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
- **Manual pin outranks discovery:** while `Asset.coordSource === "manual"`, `syncDhcpSubnets` skips the projected lat/long write on the firewall update path and `projectionDriftService` skips lat/long drift comparison (the divergence is deliberate, not drift). Discovery-side coord resolution (SNMP pull, geocode, metavar read, write-back) still runs — the observed blobs stay fresh — only the final Asset coord write is suppressed. Clearing the manual pair resets `coordSource` to NULL and discovery repopulates next cycle.

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
- `src/services/discovery/discoveryEngine.ts` (`syncDhcpSubnets`) — `activeResMap` construction EXCLUDES `sourceType="dns_resolved"` rows so discovery treats the IP as free; the five `prisma.reservation.create` callsites (fortiswitch / fortinap / vip / interface_ip / dhcp_*) each call `releaseDnsResolvedAt(subnetId, ip)` inline before creating. The Phase 5 dhcp_* callsite additionally wraps its create in a P2002-aware retry: a fire-and-forget reconcile queued from an earlier asset write can insert a fresh dns_resolved row between the inline release and the create, so on P2002 the code refetches the colliding active row and — if it's dns_resolved — `prisma.reservation.delete` the row and retries the create once. Other sourceTypes on the collider are treated as genuine concurrent-write collisions (concurrent integration, manual reservation typed during sync) and logged + skipped.
- `src/api/routes/integrations.ts` (`registerFortinetHost`) — findFirst excludes dns_resolved + same inline release before create.
- `src/services/reservationService.ts` (`createReservation`) — manual create's existing-active-reservation check excludes BOTH `dns_resolved` AND `dhcp_lease` (an observed lease is not a user-owned reservation); calls `releaseDnsResolvedAt` AND `releaseSupersededDhcpLeaseAt` inline before the `$transaction`. `releaseSupersededDhcpLeaseAt` finds the active `dhcp_lease` at the IP and **delegates to `releaseReservation`**, so the device-side lease expiry on push-enabled subnets (`releaseDhcpLease`), the released-slot dedup, and the audit Event all match the old client `release+create` flow exactly — only the route ownership gate is dropped. This is what makes the IP-panel "Reserve" take-over of a lease a plain create gated only on `reservations:write` — the client no longer issues a separate ownership-gated DELETE of the lease (desktop `_openLeaseReserveModal` + mobile reserve sheet in `subnet-detail.js`).

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

## cross-cutting/location-codes

**What it is:** Physical-location codes (`a:` area / `b:` building / `f:` floor / `r:` room / `jb:` junction box, e.g. `a:Mine b:Shop f:2 r:North Closet jb:112-305`) embedded in FortiSwitch/FortiAP admin descriptions and/or Asset notes/description, parsed server-side by `src/utils/locationCodes.ts` and shipped per topology node as `location: {area, building, floor, room, junctionBox} | null`. Drives three Device Map features: grouping hulls (nested rounded rectangles color-coded per level — area rose > building sky-blue > floor violet dashed > room green > jb amber dashed, fitted inside-out with a sibling-separation sweep so no two shapes overlap; synthetic bottom-layer Cytoscape nodes so `cy.png()` screenshots include them), full-tier (area→building→floor→room→jb) sibling row clustering in the column solver (anchors, fallback-exile roots, AND each parent's leaf block — so room/jb hulls come out as tight contiguous bands), and a two-row drill-down switcher of building views (every `b:` building, area-scoped keys `b|<a>|<b>`; the active building's floor views `f|<a>|<b>|<f>` appear in a second row) with cross-view portal stubs. Notes are operator-only — discovery never writes them on an existing asset (CLAUDE.md business rule 15).

**Writers** (files that mutate or emit this state):
- `src/services/fortimanagerService.ts` — FMG capture: switch `description` from the already-fetched `/sys/proxy/json` managed-switch CMDB rows (`descriptionBySerial`, zero extra RPCs); AP `location` (preferred — the sync surface; the only field in FMG's copy under central AP management) + `comment` fallback in the Step 3d.4 WTP CMDB roster fields, joined onto `localAps` (zero extra RPCs). `DiscoveredFortiSwitch.description` / `DiscoveredFortiAP.description`.
- `src/services/fortigateService.ts` — standalone capture: `fetchFortiswitchCmdbMeta` (renamed from `fetchFortiswitchUplinkPorts`; returns `Map<serial, {uplinkPort, description}>`) + best-effort `fetchFortiapDescriptions` (`GET /api/v2/cmdb/wireless-controller/wtp`, `location` preferred / `comment` fallback; 404/any error → empty map, never fails discovery).
- `src/services/discovery/discoveryEngine.ts` — `buildDeviceDescriptionStamp(description)` computes `{deviceDescription}` (merged into `swTopology`/`apTopology` every cycle). The former description→notes mirror (and `shouldSyncDescriptionToNotes` gate + `notesSyncedFrom` provenance) was removed 2026-07 — notes are operator-only; discovery seeds the `Auto-discovered from FortiGate …` boilerplate at creation and never writes notes again. `description` also lands in the fortiswitch/fortiap `AssetSource.observed` blobs (Sources-tab truth, not projected).
- `src/services/eventLogService.ts` — `notes` is in `MATERIAL_ASSET_FIELDS` so the device-driven notes overwrite surfaces via `logDiscoveryAssetUpdated` (only fires when notes actually change — no per-cycle Event flood).
- `public/js/map.js` — right-click (cxttap) description editor on asset-backed topology nodes: operator edit of `Asset.description` (with a:/b:/f:/r:/jb: shortcut hints in the popup) through the existing `PUT /assets/:id` route — so rule-14 description sync applies — then a silent topology refresh re-resolves codes. Gated client-side on `canManageAssets`.

**Readers** (files that consume it):
- `src/services/topologyGraphService.ts` (the map topology GET's graph builder) — selects `notes`/`description` on the FG + sibling queries, reads `fortinetTopology.deviceDescription` (`TopologyMeta`), and emits `location` (via `resolveEffectiveLocation`: the description's codes when it carries any, exclusively; else deviceDescription's) + raw `deviceDescription` per node. FortiGate: description only.
- `public/js/topology-render.js` — `locationData()` stamps `locA/locB/locF/locR/locJb` grouping keys (+ `loc*Name` display casing) onto node data; the solver clusters through the FULL tier chain via `stableBucketByTiers` (`LOC_TIERS = [locA, locB, locF, locR, locJb]`, synthetic `"\tnone"` bucket for tier-skipping codes): `regroupAnchorsByLocation` on non-spine sibling anchors AND fallback-exile roots (spine selection untouched — cross-subtree adjacency deliberately NOT guaranteed), plus pass 5b ordering each parent's leaf block so same-room/jb leaves take contiguous lanes; `computeLocationGroups`/`renderLocationGroups`/`refreshLocationGroups` draw the hulls (`LOC_GROUP_KINDS` padding/shape tiers, `z-compound-depth: bottom`); `computeFloorViews`/`partitionElementsForFloor`/`compareFloors` (underground-aware: `-2 < B1 < 1 < Mezzanine`) build the floor views + portals; `routeInterGroupEdges` fans out BOTH corridor axes in 9px steps (incl. the straight-into-target-row corridor, so parallel horizontal runs never combine into one line).
- `public/js/map.js` — Locations chip (`polaris.topology.showLocations`, default ON, rendered only when codes exist), Snap chip (`polaris.topology.snapToGrid`, default OFF), floor-view switcher chips (top-left; `topoState.activeView`, never persisted), portal tap → `_setTopologyView`, per-view position persistence (server `TopologyLayout` first via the payload's `savedLayouts[view]`, localStorage `polaris.topology.positions:<siteId>[:<viewKey>]` fallback), hull suppression (`suppressKinds: ["building","floor"]`) in floor views, `[isLocGroup]`/`[isPortal]` exclusions in `saveNodePositions` + `_openAssetForNode`.
- `public/js/mobile/topology-tab.js` — flat hulls only (always-on, rendered on layoutstop; no switcher in v1).

**Invariants:**
- The grammar lives ONLY in `src/utils/locationCodes.ts` — the client receives resolved display values and normalizes grouping keys with the trivial `locKey()` (trim/collapse/lowercase, mirroring `locationGroupKey`); never re-implement token parsing client-side.
- `fortinetTopology` is written WHOLESALE by the switch/AP sync blocks — `deviceDescription` must ride every `swTopology`/`apTopology` object or it's silently dropped on the next cycle.
- Discovery must never write `Asset.notes` on an existing asset — notes are operator-only (the description→notes sync was removed 2026-07; boilerplate at creation is the sole exception).
- Synthetic nodes (`isLocGroup`, `isPortal`) must stay out of: position persistence, the column solver input (hulls are added after layout), `computeLocationGroups` membership, asset-open tap handling, and dragfree saves. Portals are the ONLY interactive synthetic nodes.
- descriptionSyncService interplay (rule 14): with `syncDescriptions` ON, description codes are Polaris-primary — a code edited in Polaris pushes to the device; device-side code edits are overwritten unless the Polaris description is empty (adopt). Maintain codes in Polaris.

**When changing this:**
- Adding a code key (e.g. `ra:` rack)? Extend `TOKEN_RE` + `KEY_TO_FIELD` in locationCodes.ts (longest-match order!), the `LocationCodes` type, `locationData()` stamps, `LOC_GROUP_KINDS` (shape/padding tier), the legend `locations` section, and the parser tests.
- New discovery pathway for switches/APs? Capture the admin description into `Discovered*.description` and route asset writes through `buildDescriptionSyncStamp` — both FMG and standalone (parity rule).
- Touching the solver's sibling ordering? `regroupAnchorsByLocation` must stay stable and a no-op on keyless sites — the `topologyColumns.test.ts` legacy-order cases enforce this.
- FortiOS field variance: managed-switch `description` presence and wtp `location` support vary by firmware (descriptionSyncService already flags `wtp_location_unsupported`) — verify on a real device before relying on a new field.

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
- ~~`firewall:` prefix~~ — retired 2026-08 (firewallTagService deleted after its DISABLED hold; leftover `firewall:*` tags on existing installs are plain operator-managed tags now, visible and deletable in the picker).
- `src/services/tagAssignmentService.ts` — owns criteria-based auto-assigned tags. Unlike `region:`/`firewall:`, these use NO reserved prefix (they're ordinary operator-named tags), so collision is policed by the `TagAutoAssignment` provenance table instead: a tag is added/removed only on assets matching a `Tag.criteria` rule set, and removed only where the engine itself applied it (provenance row exists) — hand-applied copies survive. Managed sync (add AND remove on drift), fired inline on tag CRUD + asset writes + end-of-discovery (Phase 13.65) + a 6h job. NOT prefix-hidden in the manual picker.
- Discovery breadcrumb tags — `src/services/discovery/discoveryEngine.ts` legacy paths still write `entra-disabled`, `ad-disabled`, `prev-*` markers. Some of these (sid:, ad-guid:) are being retired by the multi-source asset model.

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
- `src/services/discovery/discoveryEngine.ts` — Phase 12 of syncDhcpSubnets calls recomputeDependencyTree(integrationId) on mode in {full, finalize}.

**Readers** (files that consume it):
- `src/services/monitoringService.ts:runMonitorPass()` — Cadence dispatch: heavy cadences gated on `monitorStatus==="up" && !dependencySuppressed`; probe interval doubles when dependencySuppressed AND responseTimePolling !== "disabled".
- `src/jobs/monitorAssets.ts:publishDueWork()` — Same gate, mirrored for the pg-boss publisher path.
- `public/js/assets.js:assetMonitorBadge()` + `_mapAsset()` — Status pill renders slate-blue "Dep. Down" whenever `dependencySuppressed` (suppression outranks the five-state label, including probe-down — the own-probe state moves to the tooltip); the `_monitor` filter array maps suppressed rows to the "Dep. Down" chip, and `monitorClause` in `src/api/routes/assets.ts` mirrors it server-side (directional chips exclude suppressed rows).
- `public/js/map.js:monitorClass()` / `clusterIcon()` / `fortigateNodeColor()` — Pin/cluster/topology-node colors render slate-blue (`monitor-dep-down`) under the same priority rule (suppressed wins). Cluster aggregation counts suppressed children as dep-down; a non-suppressed probe-down/degraded child still rolls the cluster up red/amber.
- `public/js/mobile/asset-detail.js:renderMonitorPill()` / `monitorDotCls()` — Same priority + slate-blue treatment on the mobile asset-detail surface.
- `src/api/routes/assets.ts` — Three endpoints: `GET /assets/:id/dependencies`, `PUT /:id/dependencies/override` (admin, with cycle validation), `DELETE /:id/dependencies/override` (admin).
- `src/api/routes/assets.ts:GET /` and `GET /:id` — Stamps `dependencyLayer` + `dependencySuppressed` on every asset returned so the pill renderer doesn't need a second fetch.
- `src/api/routes/map.ts:GET /sites` and `GET /sites/:id/topology` (graph built in `topologyGraphService.buildSiteTopology`) — Stamps the same fields on each pin / topology node. (The topology builder still computes edges via per-request BFS through `interfaceTopologyService` — full DAG-as-source-of-truth refactor is a follow-up; current state is "DAG drives suppression, BFS still drives graph rendering.")

**Invariants:**
- Suppression follows the **confirmed-down** edge only. propagateAfterStatusChange() is called only from the up/down guard in recordProbeResult — NOT from the monitor.status_changed Event emission (which also logs the →warning edge). Warning / recovering flapping logs an event but does NOT propagate.
- "All-down" multi-parent: an asset with N effective parents suppresses iff every parent is down or itself dependencySuppressed. Empty parent set = never suppressed.
- Override resolution: if any source="override" row exists for an asset, those are the effective parents (computed rows ignored). Empty override set = explicit "no parents" pin (asset opts out entirely).
- Unmonitored parents are transparent — the suppression walk skips them and continues to their grandparents. A monitored ancestor must say "down" before suppression can fire.
- recomputeDependencyTree only touches source="computed" rows for in-scope assets; out-of-scope rows and source="override" rows are never deleted.
- Layer assignment is **physical-first** BFS from any FortiGate (layer 1). Interface + LLDP + mesh edges form the primary adjacency; controller edges are a fallback for assets the physical pass didn't reach. Controller-fallback uses simple-path detection: a 3+ node chain of unattached switches sharing one controller, with exactly two endpoints and no branching, chains correctly off the alpha-hostname endpoint. MCLAG pairs (2-node groups) and any branching/cycled component still attach as siblings to preserve co-layer behavior. Cycles, disconnected subgraphs, or chains through unmonitored intermediates may leave dependencyLayer = null. Kept-edge `detectedVia` prefers mesh > interface > lldp > controller so the audit trail reflects physical cabling when multiple signals exist on a pair.
- **Wireless attachments override the controller signal.** A mesh-leaf AP (station-match on its root AP, from `AssetWirelessStation`, OR `fortinetTopology.meshUplink === "mesh"` — the stamped FortiOS classification works without a root-AP station scrape) gets a `mesh` edge to the root AP and its backwards controller edge is suppressed. A FortiLink switch bridged behind a FortiAP (an AP↔switch `AssetLldpNeighbor` adjacency where the switch is NOT the AP's controller parent — or where the AP is a mesh leaf, since a mesh leaf's wired LLDP adjacency is always a switch bridged behind it, even when stale pre-fix data stamped that switch as its `parentSwitch`) has its FortiLink controller edge suppressed and depends on the AP via LLDP. Both are computed in `recomputeDependencyTree` and passed to `buildDependencyEdgesFromInputs` (`meshEdges`, `bridgeLeafSwitchIds`). The same mesh-leaf rule gates discovery stamping: `parseFortiapMonitorRow` + both detected-device fallback loops never write `parentSwitch` onto a mesh leaf. The non-mesh bridged-switch discriminator (`switch ≠ AP.parentSwitch`) is a heuristic — verify against real fleet data.
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

2. **Discovery `onProgress` consumer** ([src/services/discovery/discoveryEngine.ts](src/services/discovery/discoveryEngine.ts) `onProgress` closure inside `runDiscovery`) — reads `integration.config.verboseLogging` once at discovery start. When true, every callback emits `logger.info({ verbose: true, integrationId, integrationName, step, level, device }, message)` in addition to the existing `logEvent()`.

3. **Sync phase markers** ([src/services/discovery/discoveryEngine.ts](src/services/discovery/discoveryEngine.ts) `syncDhcpSubnets` — `phaseMark(name)` helper) — when verbose is on, each `phaseMark()` call logs the elapsed time of the previous phase + starts the new phase's timer. A final `phaseMark("__end__")` closes the last phase right before the function returns.

4. **Worker handlers** ([src/services/queueService.ts](src/services/queueService.ts) `runDedicatedWorker` and `dispatchFloatingJob`) — read `job.data.verboseDebug` (stamped by the publisher in `monitorAssets.publishDueWork` when `discoveredByIntegration.config.verboseLogging === true`). When true, emit `monitor.worker.pickup` on entry + `monitor.worker.finish` on exit, with slot id, jobId, cadence, assetId, outcome, elapsedMs.

**Worker slot id scheme:** [src/utils/workerSlotPool.ts](src/utils/workerSlotPool.ts) hands out `<prefix>-W01..NN` for dedicated cadence pools (probe / fast / telemetry / sysinfo) and `floating-F01..NN` for the floating pool. Slot acquired on handler entry, released on exit so the same slot is reused across jobs — operators can trace one slot's lifecycle through journalctl. Slot bookkeeping runs every tick regardless of verbose mode; only the *logging* of slot ids is gated on the flag.

**Structured log payload contract:** every verbose line emits these fields — `verbose: true`, `integrationId` + `integrationName` (when scoped to an integration), `step` or `phase` (for discovery/sync), `workerSlot` + `jobId` + `cadence` (for workers), `assetId`, `elapsedMs` (when measured), `outcome` (for worker.finish: `"success" | "failure"`). The contract is what makes `journalctl -o json | jq 'select(.verbose==true)'` filtering work reliably; do not strip these fields when adding a new verbose log call.

**When changing this:**
- Adding a new integration type → add `verboseLogging` to its config schema, its frontend form helper, its `getXxxFormConfig` reader, and a Debug section to its General tab. See the 5 existing pairs for the template.
- Adding a new discovery step → it inherits verbose logging for free via the existing `onProgress` route. No code change required if the step uses the standard callback.
- Adding a new pg-boss queue → add a slot pool entry in `startPgbossWorkers` and use `runDedicatedWorker` (or pattern-match `dispatchFloatingJob`) so pickup/finish lines land for free.
- Adding a new sync phase → insert one `phaseMark("X")` call right under the `// Phase X — ...` comment. The previous phase's elapsed time is logged at the next phaseMark call; the final phase is closed by the `phaseMark("__end__")` at the bottom of `syncDhcpSubnets`. **Also decide the phase's `"finalize-scoped"` behavior** (single-FortiGate re-discovery): a sweep/apply phase in the `mode !== "skip-deprecation"` block must be added to the `sweepPhaseEnabled` matrix (and its unit test `tests/unit/syncSweepPhaseGate.test.ts`) — default it to OFF for scoped runs unless it is provably per-controller-safe like Phase 2b; a roster-based sweep run scoped would see a one-device fleet and mass-deprecate/decommission.

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
- `src/services/monitoringService.ts` — pass timer, work-item timer + outcome, probe duration + outcome, monitored-asset gauge, cursor-mode queue depth gauge, sample-write timer per table (asset_monitor_samples / asset_telemetry_samples / asset_hardware_sensor_samples / asset_interface_samples / asset_storage_samples / asset_ipsec_tunnel_samples / asset_perf_sla_samples / asset_sdwan_rules / asset_associated_ips / asset_lldp_neighbors / asset_mac_addresses).
- `src/services/queueService.ts:refreshPgbossMetrics()` — every 15s in pg-boss mode; emits `polaris_pgboss_queue_jobs{queue,state}` (counts) AND `polaris_pgboss_oldest_job_age_seconds{queue,state}` (oldest waiting job's age, MIN(created_on) per queue×state). Also emits `polaris_monitor_queue_mode` once at boot in `initializeQueue()` and `polaris_monitor_workers` from `startPgbossWorkers()`.
- `src/services/fmgWorker.ts` — per-integration queue depth + inflight gauges (one set per integrationId).
- `src/jobs/monitorAssets.ts` — `polaris_monitor_workers` cursor-mode seed at module load; mirrors `setMonitoredAssets` from the pg-boss publisher path so both modes drive the same gauges.
- `src/jobs/capacityWatch.ts` — every 10 min from `getCapacitySnapshot()`: emits `polaris_db_pool_*` (in_use / peak_observed / polaris_capacity / max), `polaris_capacity_severity`, `polaris_disk_free_ratio{volume,roles}`, `polaris_db_dead_tuple_ratio{table}`, `polaris_db_size_bytes`, `polaris_db_steady_state_size_bytes`. Volume + table gauges are `.reset()` before re-stamping each tick so dropped volumes / removed tables don't leave orphan series.
- `src/services/discovery/discoveryEngine.ts` — discovery duration histogram + outcome counter at all three integration outcomes (success / abort / failure) alongside the existing `recordSample()` call.
- `src/app.ts` — HTTP request timer + in-flight gauge middleware (mounted right after CSRF; skips `/metrics` and `/health`; `/api/v1/auth/login` rate-limited 429s still observed).
- `src/jobs/_metrics.ts:runInstrumentedJob(name, fn)` — every job in `src/jobs/` wraps its tick body with this helper; emits `polaris_job_duration_seconds{job}` + `polaris_job_total{job, outcome}` without changing the job's existing error semantics. `monitorAssets.probe` and `monitorAssets.heavy` are the two label values from the only multi-tick job.
- `src/utils/crashHandlers.ts` — `polaris_process_crash_total{role, kind}`, incremented from the `unhandledRejection` / `uncaughtException` handlers immediately BEFORE `process.exit`. The counter dies with the process, so a single scrape reads 0 or 1; the signal is the restart, i.e. `increase(...[1h])` summed across a role's instances. The increment is wrapped in its own try/catch — a metrics failure must never mask the crash it is reporting.
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

**What it is:** Two-axis storage policy for the eight monitor sample tables. **A third, FLAT dimension rides the same Setting row** for tables that are current-state-with-age rather than tiered time-series, where detail/hourly/daily would be meaningless: `FLAT_RETENTION_ENTITIES` (today just `appMapConnections` → `asset_process_connections`) carries a single `{days}` window with the same `−1`/`0`/`N` encoding. `SampleRetention` is the INTERSECTION of the tiered and flat records, so `retention[entity][tier]` is untouched; `parseSampleRetention`/`mergeRetention` loop both lists, which is why adding a flat entity needs NO migration (a pre-feature blob just lacks the key and inherits the default on read). Adding one means touching `sampleRetentionService` (type + list + default + parse/merge), its prune call site, the `SAMPLE_RETENTION_FLAT_ENTITIES` list in `public/js/server-settings.js`, and — if the window also bounds a reading surface — that reader, so the two can't disagree. `migrateSampleRetentionToEntities` spreads flat defaults from `FLAT_RETENTION_ENTITIES` rather than naming them, so a future one can't be forgotten there. **Tier axis**: detail (raw samples) → hourly aggregates → daily aggregates. **Retention axis**: each tier has its own days-to-keep, per device class (default / switch / accessPoint), per stream (sample / telemetry / systemInfo). Chart history requests at long ranges read from the rollup tiers (cheap), short ranges read from detail (raw). Phase rollout 0–6 retired the per-tier monitor-settings retention fields in favor of a single global `Setting("sampleRetention")` edited from Server Settings → Maintenance.

**Schema:**
- Seven source tables (`asset_*_samples`) — unchanged shape, partitioned by `timestamp`.
- Fourteen rollup tables (`asset_*_samples_hourly` + `asset_*_samples_daily`) — partitioned by `bucketStart`. Gauge tables carry avg/min/max; counter tables carry first/last endpoints + `lastBucketSampleAt` so rate = `(last - first) / (lastBucketSampleAt - bucketStart in seconds)`, dropping negative deltas as counter resets.
- All 22 tables can be Timescale hypertables (`timescaleService.ALL_HYPERTABLE_CANDIDATES` = the 21 tiered + the standalone `asset_custom_widget_samples`); plain Postgres works just as well, just without chunk-drop pruning. (`tests/unit/timescaleTables.test.ts` drift-guards the inventory: rollup-writer / prune-layer / schema table references must stay ⊆ the managed lists.) SD-WAN rules are a PLAIN current-state table (`asset_sdwan_rules`) and are NOT in any of these lists.

**Writers:**
- `src/services/sampleWriteBuffer.ts:enqueue*` — seven detail tables via batched createMany every 2 s. Append-only, no upsert. (The SD-WAN SLA-metrics stream `asset_perf_sla_samples` is fed via `enqueuePerfSlaSamples` from `recordSystemInfoResult` when `collectSdwanFortinet` ran, gated by `Integration.config.pullSdwan`. The SD-WAN **rules** stream is NOT buffered — it became a current-state table `asset_sdwan_rules`, written via `persistSdwanRules` delete-replace.)
- **SD-WAN stream change-checklist.** The two SD-WAN streams now diverge:
  - **perfSla (SLA-metrics, time-series — mirror the IPsec stream end-to-end):** `prisma/schema.prisma` (detail + `*Hourly`/`*Daily`) → migration → `monitoringService` (`PerfSlaSample` interface, `collectSdwanFortinet` + pure parsers `parsePerfSlaHealthCheck`/`parseSdwanSlaThresholds`, `includeSdwan` gate in `collectSystemInfoFortinet`, persist in `recordSystemInfoResult`, prune in `pruneSystemInfoSamples`) → `sampleWriteBuffer` (row type + buffer key + `TABLE_LABEL` + `flushing` + enqueue + `writeBatch` case) → `sampleRollupService` (`DEFS` + `SourceTable` + `buildSql` + SQL helpers) → `sampleRetentionService` (`RetentionEntity` + `RETENTION_ENTITIES` + default) → `timescaleService` (`SAMPLE_TABLES` + `ROLLUP_TABLES`) → `capacityService` (local `SAMPLE_TABLES` + rows/bytes maps) → `sampleHistoryService` (`readPerfSlaHistory`) → `assets.ts` routes → `public/js/{api,assets,integrations,server-settings}.js`.
  - **sdwanRule (CURRENT-STATE — mirror LLDP/wireless, NOT a sample stream):** `prisma/schema.prisma` (plain `AssetSdwanRule` table, `@@unique([assetId, ruleName])`, NO hypertable/rollup) → migration → `monitoringService` (`SdwanRuleSample` parse interface kept AS-IS for the collector output; `parseSdwanRules` pure parser; persist via `persistSdwanRules` delete-replace in `recordSystemInfoResult`; NOT in `pruneSystemInfoSamples`, NOT in `sampleWriteBuffer`/`sampleRollupService`/`sampleRetentionService`/`timescaleService`/`capacityService`) → `assets.ts` `GET /:id/sdwan-rules` (reads `prisma.assetSdwanRule`, order by `seq`) → `public/js/{api,assets,mobile/asset-detail}.js`. No `*-history` endpoint and no Retention card row.
  - The integration toggle `pullSdwan` is on BOTH `FortiManagerConfigSchema` + `FortiGateConfigSchema` (parity).
- `src/services/sampleRollupService.ts:rollupHourly() / rollupDaily()` — INSERT...ON CONFLICT DO UPDATE per (table, tier). Driven by `src/jobs/runSampleRollup.ts` (hourly tick every 30 min, daily tick at 02:30 UTC). Sources for daily reads from `*_hourly`, not detail, so the daily tick stays bounded on big fleets.
- `src/services/monitoringService.ts:runRetentionPrune` — the single entry point fired from `src/jobs/monitorAssets.ts` heavy-loop. It is **fleet-coordinated single-flight**: a persisted `Setting("lastRetentionPruneAt")` gates whether a prune is due (default 24h cadence, `RETENTION_PRUNE_INTERVAL_MS`), and a Postgres **session-level advisory lock** (`pg_try_advisory_lock(0x504c5253, 1)` on a dedicated `getDirectDatabaseUrl()` connection — NOT a transaction, which would re-pin xmin) ensures only ONE monitor replica prunes at a time; others return `{skipped, reason: "lock-held" | "not-due"}`. Inside the lock it runs `pruneMonitorSamples / pruneTelemetrySamples / pruneSystemInfoSamples` (each helper one prune per table × tier with retention from `getSampleRetention()`), then bumps the persisted timestamp. **Replaces the old in-memory `lastPruneAt = 0` trigger that fired the prune on every process boot — under a monitor restart loop that re-issued the prune every ~30s and fanned into the 2026-06-17 DELETE pile-up** (overlapping `asset_interface_samples_hourly` deletes serializing on tuple locks, pinning the xmin horizon, pegging every core). The persisted timestamp also means a frequently-cycled host prunes 24h after the last SUCCESSFUL prune, never on boot.
  - **NO tier prune — detail OR rollup — may row-DELETE inside a compressed chunk.** Two helpers enforce this:
    - `pruneSelectionAwareDetail` (interfaces/storage/ipsec detail) lower-bounds its unselected/slow deleteMany at the frontier via `unselectedSlowPruneWindow(now, getEffectiveCompressAfterDays(table))`.
    - `pruneTierByDays` (every hourly/daily rollup tier + the monitor/cpuMem/hardware/perfSla detail tiers) routes through `tieredPruneWindow(now, retentionDays, compressAfterDays)`, which **skips the row-DELETE entirely when the whole delete set is past the compression frontier** (`skipRowDelete` — the common rollup case: 30d/365d retention ≫ 7d compress-after), leaving `drop_chunks` to reclaim it; when the cutoff is newer than the frontier it bounds the DELETE to the uncompressed `[frontier, cutoff)` window. Before this fix `pruneTierByDays` did a blanket `lt: cutoff` deleteMany that decompressed straddling chunks (2026-06-17). `drop_chunks(cutoff)` still runs unconditionally so whole aged chunks drop in O(1).
    - A DELETE matching rows in a compressed TimescaleDB chunk decompresses the whole chunk into its rowstore heap → un-truncatable low-density bloat (prod incidents 2026-06-08, 2026-06-17). If you change the compress-after window source or the chunk interval, re-check both bounds. Both window functions are pure + unit-tested (`tests/unit/unselectedSlowPruneWindow.test.ts`).
- `src/jobs/reclaimBloatedChunks.ts` — every-6h safety net that `VACUUM (FULL)`s already-compressed chunks of **any** sample hypertable (scan list = `ALL_HYPERTABLE_CANDIDATES` — detail + hourly/daily rollups, not just the selection-aware detail tables) whose on-disk heap dwarfs their compressed bytes (the residue of any decompress-on-DELETE, plus pre-fix bloat). Widened from detail-only after the 2026-06-17 incident decompressed a `asset_interface_samples_hourly` chunk (10 GB on disk / 323 MB real) that the old detail-only list left stranded. Read-only detection via `chunk_compression_stats()`; only chunks > 256 MB AND > 3× their compressed bytes are rewritten; bounded (12 chunks/run) + `lock_timeout`-guarded with retry on a dedicated `getDirectDatabaseUrl()` connection. Registered under `cfg.runsSchedulers` in `src/app.ts`.

**Readers:**
- `src/services/sampleHistoryService.ts:read*History` — six tier-aware readers, one per source. Detail tier returns raw rows; rollup tiers translate aggregate columns back to source field names so existing chart renderers consume both shapes with no per-tier branching except for counter-rate pre-computation.
- `src/api/routes/assets.ts` — six `/assets/:id/*-history` endpoints dispatch to the right reader via `pickSampleTierForAsset(assetId, stream, since)` from `sampleQueryRouter`.
- `src/services/capacityService.ts:projectSteadyStateSize` — steady-state footprint projection. **DETAIL tiers** that never compress (retention ≤ compress-after — interface/storage/ipsec + monitor/cpuMem/hardware/perfSla detail at the 7d/7d default) are projected from a **MEASURED uncompressed daily byte-rate** (`measureDetailDailyBytes` → median size of recent settled, uncompressed chunks ÷ span) × retention, via the pure helper `projectDetailBytes`. This captures real index/page overhead + the true pinned-interface/cadence/asset mix the workload model can't see — the hardcoded `count × rows/asset/day × DEFAULT_BYTES_PER_ROW` model underprojected interface detail ~33× (2026-06: assumed 20 ifaces/24h-cap/395 B-row vs. 9,418 pinned interfaces/7d/~1.1 kB-on-disk-row). **Rollup tiers** (hourly/daily, mostly compressed at steady state) keep the workload model, as does the **fallback** when a detail table has no settled chunk yet (fresh install) or its retention reaches past the compress frontier (part compressed → measured-uncompressed would over-project). It still NEVER uses the live-measured `avgBytesPerRow` (relpages ÷ pg_stat tuples) — that produced phantom 14–218 TB projections (2026-06); the chunk measurement reads only dense, settled, uncompressed chunks (median-robust to a bloated outlier). Exported + unit-tested (`tests/unit/capacitySteadyState.test.ts`).

**Settings store:**
- `Setting("sampleRetention")` — flat `{stream: {tier: {class: days}}}` shape, 27 numbers total. Defaults 7/30/365. Backed by `src/services/sampleRetentionService.ts` with a 5 s in-process cache (chart endpoints read on every request).
- Edited from `public/js/server-settings.js:renderSampleRetentionCard()` (Server Settings → Maintenance tab) via `GET / PUT /server-settings/sample-retention`.

**Lifecycle / migrations:**
- `src/jobs/renameMonitorClassKeys.ts` (phase 0) — renames legacy `fortiswitch` / `fortiap` keys to `switch` / `accessPoint`.
- `src/jobs/migrateSampleRetentionToEntities.ts` — converts the legacy class-shaped `Setting("sampleRetention")` to the per-entity shape (`assets`/`cpuMem`/`hardware`/`interfaces`/`storage`/`ipsec`/`perfSla`), flipping legacy `0`=forever to `FOREVER`(-1). Replaced the older `migrateRetentionTiers` / `consolidateSampleRetention` class-shaped seeders. (`sdwanRule` was removed when SD-WAN rules became current-state.)
- Each migration is idempotent via its own marker Setting; safe to re-run by deleting the marker and restarting.

**Invariants:**
- **Same tier shape everywhere.** Detail / hourly / daily aggregates must produce the same field names per source so the chart renderers can hold a single shape per source. Adding a new aggregate column to a rollup table requires a matching update in both `sampleRollupService` (SQL) and `sampleHistoryService` (reader translation).
- **Counter rate convention.** First/last + lastBucketSampleAt is the contract. Negative deltas drop as resets — matches detail-tier client-side diff in `_derivePerIntervalSeries` / `_deriveIpsecThroughput`.
- **Retention is global.** Cadence / polling method / credentials / MIB hints / timeouts stay in the per-tier monitor-settings hierarchy (`MonitorClassOverride`, `Integration.config.monitorSettings`, `Setting("manualMonitorSettings")`); only retention is global. Don't re-introduce per-integration retention.
- **Rollup writes are upsert.** Don't try to push rollup writes through `sampleWriteBuffer` — the buffer's append-only contract intentionally has no upsert path.
- **Sample/rollup tables have NO foreign key to Asset (migration `20260615000000`). Never re-add `@relation`/`onDelete: Cascade`, and never row-DELETE/UPDATE sample rows inside a compressed chunk.** Any per-row DML matching a compressed TimescaleDB chunk decompresses the whole chunk → un-truncatable heap bloat (prod incident 2026-06-08; root cause was the asset-delete cascade hitting compressed sample chunks). Deleting an Asset now leaves its sample rows orphaned (`assetId` → gone Asset, queried only by assetId so never surfaced) and they age out via `drop_chunks` on the retention schedule — the only compression-safe deletion. Consequence: a deleted asset's sample storage is freed at retention time, not instantly. Retention stays compression-safe via the bounded slow-prune (`unselectedSlowPruneWindow`) + `drop_chunks`; `reclaimBloatedChunks` (every 6h) is the residual-bloat net. Applies to every `Asset*Sample` + `*Hourly`/`*Daily` + `AssetCustomWidgetSample`. (`AssetCustomWidgetSample` is a STANDALONE detail-only hypertable — `timescaleService.STANDALONE_SAMPLE_TABLES`, no rollups — pruned on the system-info umbrella window like LLDP; migration `20260621000000` gave it the composite `(id, timestamp)` PK hypertabling requires.)

**Observability:**
- `polaris_sample_rollup_duration_seconds{tier,table}` (histogram) — per-INSERT wall-clock from sampleRollupService.
- `polaris_job_duration_seconds{job}` + `polaris_job_total{job, outcome}` — `sampleRollup.hourly` and `sampleRollup.daily` job-level wrappers via `runInstrumentedJob`.
- `Setting("sampleRollup.<tier>.lastSuccess")` — stamped on every successful tick. `capacityService` reads both into `database.rollupLastSuccess` and fires the `sample_rollup_lagging` watch reason when hourly is >6 h stale or daily is >36 h stale AND any sample table has rows.

**When changing this:**
- New rollup column → schema update + sampleRollupService SQL builder for both hourly and daily tiers + sampleHistoryService reader translation. Run `npx prisma migrate diff --from-schema /tmp/old.prisma --to-schema prisma/schema.prisma --script` and commit the resulting `migration.sql`.
- New retention entity → add to `RetentionEntity` + `RETENTION_ENTITIES` in `sampleRetentionService.ts`, add the entity to `defaultSampleRetention()`, extend the Retention card's entity rows, add/extend the per-entity prune helper in `monitoringService`, and (if selection-aware) add it to `SELECTION_AWARE_ENTITIES` + stamp `cadence` in its writers.
- Retention default change → update `DEFAULT_DETAIL_DAYS` / `DEFAULT_HOURLY_DAYS` / `DEFAULT_DAILY_DAYS` in `sampleRetentionService.ts`.

---

## cross-cutting/server-side-list-tables

**What it is:** The Events and Assets list pages run `TableSF` in **server-side mode** — filter/sort/pagination happen in the API, only one page reaches the browser. The filter/sort *contract* is split across three files per page and they must stay in sync. (See TEMPLATES.md → "Sortable + filterable data table" for the full pattern; the other list pages — subnets/blocks/reservations — are still client-side `sf.apply()` and are NOT covered here.)

**The three-file contract (per page):**
- **`public/<page>.html`** — `<th data-sf-key=… data-sf-type=… data-sf-options=…>` defines which columns are filterable/sortable + the static multi-select option sets. The `data-sf-key` is the wire name.
- **`public/js/<page>.js`** — the `_build*Query()` translator maps live `sf._filters` / `sf._sortKey` / `sf._sortDir` + pagination onto API params (`events.js:_buildEventsQuery`, `assets.js:_buildAssetsQuery`). `onChange` resets offset and re-fetches; **never** `sf.apply()`.
- **`src/api/routes/<page>.ts`** — the list handler parses those params into a Prisma `where`/`orderBy` with a **sort whitelist** (400 on anything off it) and the operator-aware text-filter helpers. `events.ts` (`buildTextFilter`) and `assets.ts` (`buildAssetTextFilter` / `buildServerFilter` / `monitorClause` / `buildAssetListWhere` / `buildAssetOrderBy`) are the references.

**Assets-specific wrinkles:**
- `favoriteIds` (CSV from the `polaris-favs-assets-<user>` localStorage set) → a two-bucket query in `assets.ts` floats starred rows to the top of the *whole* result set. The two `count`s + split-window `findMany`s only run when the set is non-empty.
- `_monitor` is a synthetic column: `monitorClause()` maps each chip (Monitored/Unmonitored/Up/Warning/Down/Recovering/Pending) onto `monitored` + `monitorStatus`; `_server` spans `location`+`learnedLocation`.
- The Type column is the one **dynamic** multi-select on the page: the `data-sf-options` in `assets.html` is only a pre-fetch seed of the built-in registry rows, replaced at init by `_loadAssetTypeOptions()` → `sf.setColumnOptions("assetType", …)` from `GET /asset-types`, so operator-added custom types are filterable. It's awaited before `_restoreAssetsPrefs()` / `_applyAssetsHashFilters()` — `setColumnOptions` drops saved filter values that have no matching option, and the `#type=` hash guard tests `ASSET_TYPE_LABELS`.
- Cross-page bulk selection: `_assetsSelected` (id Set) + `_assetsSelectedMeta` (id→{status,assetType}) survive paging because page-nav calls `fetchAssetsPage()` (no clear); only `loadAssets()` (Refresh / post-mutation) clears them.
- Export: `_fetchAssetsForExport` re-pages from the server for filtered/all; "page" uses the in-memory page.

**When changing this:**
- Add a filterable/sortable column → add the `<th data-sf-key>` in HTML, the param mapping in `_build*Query`, the `where`/whitelist handling in the route, **and** an index if it becomes a common sort.
- Adding a sort key → it MUST be in the route's sort whitelist or the request 400s.
- The list payload `select` omits heavy fields (notes, etc.); anything the table/export renders must be in it.
- `assets.js` per-row in-memory lookups (`_setAssetType`, `_flipAssetMonitor`, `viewAssetLease`) only see the current page — that's fine because they're triggered from visible rows. Don't assume `_assetsData` holds the whole fleet.

---

## cross-cutting/csp-inline-script-policy

**What it is:** Helmet's Content-Security-Policy in `src/app.ts` sets `scriptSrc: ["'self'"]` — every `<script>...</script>` block with inline content is BLOCKED by the browser. Only external `<script src="...">` tags and inline `on*=` handler attributes (allowed via `scriptSrcAttr: ["'unsafe-inline'"]`) are permitted. This is the most dangerous XSS vector closed by the strict CSP, and it must stay closed.

**Writers** (anywhere a Polaris route or stub HTML emits inline scripts — must be EMPTY of inline scripts):
- `src/app.ts` — `legacyIpamRedirect()` stub HTML. Loads `/js/legacy-ipam-redirect.js` (external file at `public/js/legacy-ipam-redirect.js`) which reads `location.pathname` to decide the target tab and `location.hash` to preserve the legacy fragment, then `location.replace()`s to `/ipam.html#tab=<tab>&<legacyHash>`. Was a `blank page` regression for two weeks (2026-04 to 2026-05) when this used an inline `<script>` block — CSP silently blocked the redirect, leaving a blank body. Symptom for the operator: clicking "View Lease → Open in Networks" on the assets page navigated to `/subnets.html#ip=<sid>@<ip>` and stayed blank.
- Any future server-rendered stub or framework view should use an external file (or pass data via `data-*` attributes that the external script reads via `document.currentScript.dataset`).

**Readers** (the CSP itself):
- `src/app.ts` — Helmet `contentSecurityPolicy.directives.scriptSrc: ["'self'"]` blocks inline; `scriptSrcAttr: ["'unsafe-inline'"]` keeps `onclick="..."` working because most pages still build HTML via `innerHTML`.
- `connectSrc` is `'self'` plus specific whitelisted hosts, each with a documented consumer: `https://fonts.googleapis.com` + `https://fonts.gstatic.com` — fetch()ed by the asset-details Screenshot buttons (desktop `_screenshotAssetDetails` in `public/js/assets.js` and mobile `screenshotSheet` in `public/js/mobile/asset-detail.js`; the vendored html-to-image inlines the page's webfonts into its DOM snapshot so the captured PNG renders in Inter/Roboto Mono; degrades to fallback system fonts when unreachable). `https://api.rainviewer.com` + `https://api.open-meteo.com` — fetch()ed by the Status Map dashboard widget (`public/js/widgets/siteMap.js`, type `siteMap`) for the radar frame index + current-temperature labels; sends only approximate site lat/long, degrades silently offline. `imgSrc` likewise adds `https://*.rainviewer.com` for the radar tiles (loaded as `<img>`, alongside the existing OSM/CARTO basemap tile hosts). Don't widen connectSrc/imgSrc beyond specific origins with a documented consumer.

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
- `src/services/azureAuthService.ts` — `findOrProvisionSamlUser` extracts the SAML claims (incl. the Azure groups claim — string or array of group object-ID GUIDs) and delegates to `provisionExternalUser` with provider `"azure"` (2026-08 fold): SAML logins now resolve `provider="saml"` group mappings like every other SSO path, and the historical SAML username derivation (`-azure` collision suffix, `azure-<oid>` fallbacks) is reproduced by the shared derivation with that provider name.
- `src/services/ssoProvisioning.ts` — `provisionExternalUser` (OIDC + LDAP): resolves IdP groups → role+tags, assigns the group-resolved role (highest-priv) or keeps an existing user's role on no-match, records `ssoGroups`.
- `src/services/groupMappingService.ts` — `GroupMapping` CRUD + `resolveGroupsToAccess`; the writer of `groupMapping.*` Events (warning when a mapping targets an admin-equivalent role).
- `src/api/middleware/permissions.ts` — `loadRoleSnapshot` rewrites `req.session.roleSnapshot` + persists via `req.session.save()` when the cached `updatedAt` is newer than the snapshot. `rankRole` / `pickHighestPrivilegeRoleId` rank roles for highest-privilege-wins group resolution.

**Readers** (consult the matrix or the session snapshot to gate behavior):
- `src/api/middleware/permissions.ts` — `requirePermission` / `hasPermission` / `requireOwnership` / `ensureRoleSnapshot`. All route guards funnel through here, for sessions and role-bound bearer tokens alike.
- Every route module under `src/api/routes/` — declares its per-route gate via `requirePermission(functionKey, level)`. Ownership-dimensioned routes (`subnets.ts`, `reservations.ts`) additionally branch on `req.permissionLevel === "fullwrite"`.
- `src/api/routes/conflicts.ts` — `visibleEntityTypes(req)` and `canResolve(req)` consult `hasPermission(req, "discoveryConflicts", ...)` only: read = list both entity types, write = resolve both. The historical networkadmin↔reservation / assetsadmin↔asset role-NAME split was dropped 2026-08 (it broke silently on role rename and never applied to bearer callers).
- `src/app.ts` — Static-page redirect: `/users.html` / `/integrations.html` / `/notifications.html` / `/automations.html` / `/server-settings.html` resolve the caller's level via `permissionOf(perms, key)` (alias-aware) against the matching `pageRequiredPermission` entry; out-of-scope users bounce to `/`.
- `public/js/app.js` — `permAtLeast(functionKey, level)` consumes `currentRolePermissions` populated from `auth.me.role.permissions`. The `isAdmin()` / `canManageNetworks()` / `canManageAssets()` / `isUserOrAbove()` / `canReviewConflicts()` / `canEditSubnet(subnet)` / `canEditReservation(reservation)` shims were rewritten to call `permAtLeast` and are the back-compat surface for the existing call sites across assets.js, subnets.js, reservations.js, integrations.js, events.js.
- `public/js/users.js` — `loadRoles` consumes `GET /roles` + `GET /roles/functions`; `openRoleSlideover` renders the matrix + the badge color picker (random default for new roles, live preview); `openUserRegionsModal` writes `User.regionTags`. Role badges (users table + Manage Roles list) and `public/js/app.js`'s sidebar user-badge color via `roleBadgeStyleFromColor(role.color)`, falling back to the legacy `.badge-*` classes when `color` is null.
- `public/js/mobile/app.js` — Mobile bootstrap reads `data.role.name` and `data.role.permissions` from /auth/me, storing them on `user.role` (string) + `user.permissions` (object) for the rest of the mobile bundle. Capability gates (reservations-tab.js `canCreate`/`canModify`, subnet-detail.js `canWrite`) consume `user.permissions` via a local `permAtLeast(user, key, level)` — mirroring desktop app.js — so custom/renamed roles that grant `reservations=write` pass. (Gating on the role NAME against a hardcoded seeded-role list was a bug: it falsely showed "read-only" to custom roles on mobile while the backend `requireOwnership("reservations")` accepted the write — fixed 2026-06.) more-tab.js still reads `user.role` for the role-name display badge only.

**Cache invalidation:**
- `roleVersionMap` in `permissions.ts` — Map<roleId, ISO updatedAt>. Lazily populated on first request per role; `bumpRoleVersion` writes the new stamp after every Role write; `loadRoleSnapshot` reads it on each request and triggers ONE Prisma fetch + `req.session.save()` when the cached version is newer than the snapshot. Sub-millisecond when in sync.
- Changing a USER's roleId takes effect on next login (the snapshot is regenerated). Changing a ROLE's permissions takes effect on next request for every session that holds the role.

**Invariants:**
- `Role.isProtected=true` (admin + readonly only) blocks all edit/delete/rename operations at the service layer regardless of frontend hidden state.
- `Role.isBuiltIn=true` blocks delete (the three editable built-ins networkadmin/assetsadmin/user can be renamed/edited but not deleted).
- `lastAdminEquivalent` (userService): every mutation that would leave Polaris with zero users holding `users=fullwrite` AND `roles=fullwrite` returns 409.
- Custom role names cannot collide with `admin` / `readonly` (case-insensitive reserved-name guard).
- Permissions JSON is normalized on every write: unknown function keys dropped, missing keys defaulted to `"none"`. The route layer never trusts the raw body shape.
- **Legacy key aliases (Automations rename, 2026-07):** `notifications`→`alerts` and `notificationManagement`→`automationManagement` were renamed (migration `20260721000000_automations_rbac_rename`, which also seeds `automationScripts` — fullwrite only for admin-equivalent matrices). Read path: `permissionOf(perms, key)` falls back through `LEGACY_KEY_ALIASES` so pre-deploy session snapshots (and Role rows restored from pre-upgrade backups) keep resolving without re-login — `requirePermission`, `hasPermission`, and the app.ts page gate all read through it; never revert them to direct `permissions[key]` lookups. Write path: `normalizePermissions` folds legacy keys onto modern names (modern wins on conflict) before the unknown-key drop.
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

## services/automationScriptService.ts

**What it owns:** The AutomationScript registry (operator-authored scripts referenced by Automation `script` actions) + the AutomationScriptRun lifecycle entry points. **RCE-equivalent surface:** every route sits behind the `automationScripts` key; server scripts run as the polaris service user, agent scripts as root/LocalSystem on the triggering asset.

**Public API:** `listScripts`/`getScript`/`createScript`/`updateScript`/`deleteScript`, `requestScriptRun` (validates exists + enabled + runTarget-compatible; agent runs additionally preflight the TRIGGERING asset's ManagedAgent — installed + active + agentVersion ≥ MIN_AGENT_SCRIPT_VERSION (0.13.0) — BEFORE creating the run, then enqueue the run_script AgentCommand with the sha256-carrying payload and link agentCommandId), `listRuns`, `pruneOldRuns` (90d), `sha256Hex`, `versionAtLeast`/`MIN_AGENT_SCRIPT_VERSION`, `SCRIPT_RUN_TARGET_VALUES`/`MAX_SCRIPT_BODY_BYTES`/`MAX_SCRIPT_TIMEOUT_SEC`.

**Cross-service deps:** `prisma` (AutomationScript/AutomationScriptRun/NotificationRule), `eventLogService.logEvent`, `notificationTypes` (SCRIPT_INTERPRETERS + normalizeRuleToV2 for the delete-referenced scan).

**Used by:** `src/api/routes/automationScripts.ts` (CRUD + test-run), `automationActionService` (script arm → requestScriptRun), `automationScriptRunner` (pruneOldRuns).

**Invariants:**
- sha256 recomputed on EVERY save — it's what agents verify before executing; never accept a client-supplied hash.
- Creation is a warning Event; a body change is a warning Event carrying old+new sha256 — script tampering must be visible in the audit trail/syslog.
- Delete refuses (friendly 409) while any automation's actions or escalation tiers reference the script (scan goes through `normalizeRuleToV2`, so legacy-shaped rows count too).
- Run rows snapshot scriptName + sha256 so history survives script deletion; `notificationId` carries NO FK (alert lifecycle is independent).

**When changing this:** New interpreter → `SCRIPT_INTERPRETERS` in notificationTypes + `interpreterArgv`/extension in automationScriptRunner + the Go agent's scriptexec mirror. Never widen who can call these paths without revisiting the RBAC posture in permissions.ts.

---

## services/automationScriptRunner.ts

**What it owns:** Server-side execution of pending AutomationScriptRun rows (runOn="server"), driven by the `runAutomationScripts` job (5s tick, web/all role). Claim pending→running (bounded, restart-safe), execFile with timeout + output caps, record results + `automation.script.run` Events, stuck-running sweep, idle-tick retention prune.

**Public API:** `runPendingServerScripts()` (the job tick), `executeServerScript(run)` (exported for tests).

**Cross-service deps:** `prisma`, `eventLogService.logEvent`, `automationScriptService.pruneOldRuns`, `src/utils/paths.ts` (STATE_DIR → data/automation-scripts-tmp).

**Used by:** `src/jobs/runAutomationScripts.ts`.

**Invariants:**
- Script execution NEVER happens inline in the engine or the delivery drain — always through this queue (a wedged script must not stall alert evaluation or deliveries).
- The rendered args string travels as a SINGLE argv entry to execFile — never concatenated into a shell string. Alert context rides env vars (POLARIS_ALERT_ID/POLARIS_RULE/POLARIS_ASSET).
- Body goes to a 0600 temp file under the state dir and is ALWAYS unlinked (finally); stdout/stderr capped at 64 KB (a maxBuffer kill classifies as failure, not timeout); SIGKILL on timeout.
- Claim via updateMany with a status re-check so concurrent processes can't double-run; the stuck sweep only flips rows past timeout+60s grace.

**When changing this:** Anything touching the execution model (interpreters, env, caps, temp-file handling) is security-sensitive — human review required before production; keep the Go agent's scriptexec semantics in lockstep (same caps, same hash-verify posture).

---

## services/automationActionService.ts

**What it owns:** The single fan-out point between a fired alert (Notification row) and its automation's `actions[]`. `executeActions(notificationId, actions, ctx, exec)` dispatches per action type: notify → the existing recipient/delivery pipeline (`expandDeliveries`, passing `scopeRegionTags` + `assetRegionTags` for the two region-recipient flavors) with the ACTION's `emailComposition` falling back to the rule-level one; api_call → one `NotificationDelivery` row (`transport: "api_call"`, `channelId: NULL` by design, request spec + fire-time-rendered body in meta); script → an AutomationScriptRun via `requestScriptRun`.

**Public API:** `executeActions`, `ActionExecContext` ({scopeRegionTags?, assetRegionTags? (the triggering asset's stripped region snapshot — recipientDeviceRegion routing), assetId?, ruleId?, ruleName?, ruleEmailComposition?, escalation? {tier, attempt}, actor?}).

**Cross-service deps:** `prisma` (NotificationDelivery), `eventLogService.logEvent`, `notificationRecipientService` (expandDeliveries + buildComposedEmail), `notificationTypes` (actionsToTargets + action types), `src/utils/notificationTemplate.ts` (api_call body rendering).

**Used by:** `notificationEngine` (fire + event-tail, via its `executeActionsSafe` wrapper); the escalation sweep joins in the escalation-v2 phase.

**Invariants:**
- Best-effort PER ACTION: one failing action never blocks the others; every failure writes an `automation.action_error` warning Event with actionIndex/actionType/ruleId details.
- api_call bodies render at FIRE time from the live context — the drain never needs the rule. The api_call row's NULL channelId is legitimate (the drain's permanent-fail rule is transport-conditional); headers are operator-typed and stored unmasked (no-secrets warning lives in the catalog/docs).
- notify composition precedence: action-level `emailComposition` ?? `exec.ruleEmailComposition` ?? none (legacy per-address fan-out) — byte-identical to the pre-actions path for converted rules.

**When changing this:** New action type → new arm here + `actionSchema` + `assertActionRefs` (notificationRuleService) + a dispatch/execution path (drain arm or dedicated runner) + `actionTypes` catalog entry. Never execute long-running work inline here — enqueue (delivery row / script run) and let the owning job drain it.

---

## services/notificationTypes.ts

**What it owns:** The Automations vocabulary — the discriminated `trigger` Zod union (asset_metric | asset_state | host_metric | event | change | **composite** — a nested AND/OR tree of metric/state leaves, `kind` asset|host, ≤3 deep / 2–10 leaves, and/or only, caps in `validateCompositeTrigger`; a 1-leaf composite collapses to the legacy single trigger via `collapseCompositeTrigger` in the input transforms), the asset `scope` schema, the **rule-shape-v2 layer** (`resetSchema` with hysteresis `clearThreshold` + clear-sustain `sustainSec` + condition-mode reset trees; the `actionSchema` union notify | api_call | script — notify carries `recipientDeviceRegion` alongside `recipientScopeRegion`; escalation v2 tiers-of-actions; **`escalatableActionSchema`** = the three action schemas + an optional per-action `escalation` chain, used ONLY at `ruleInputBaseSchema.actions` + `severityBandSchema.actions` so chains can't nest inside tiers/resolvedActions), `ruleInputSchema` (accepts v2 AND legacy bodies via transform + superRefine cross-validation) / `previewInputSchema` (partial drafts), the pure legacy↔v2 converters (`normalizeRuleToV2`, `normalizeReset`, `targetsToNotifyActions`/`actionsToTargets`, `legacyMirrorOfV2`, `normalizeEscalationToV2`), the **canonical action walk + chain selection** (`allRuleActionRefs` — every gate/detail consumer collects through it; `ruleHasAnyEscalation`; `escalationChainsForSeverity` + `escalationTierStateKey` — the level chain keeps bare numeric state keys, per-action chains key `a<i>:t<j>`), the metric/field/comparator/aggregation/change-type catalogs, and `buildSchemaCatalog()`.

**Public API:** `triggerSchema`, `scopeSchema`, `ruleInputSchema`, `previewInputSchema`, `resetSchema`, `actionSchema` (+ `notifyActionSchema`/`apiCallActionSchema`/`scriptActionSchema`), `escalatableActionSchema` (+ per-type escalatable variants, `EscalatableAction`), `allRuleActionRefs`/`ruleHasAnyEscalation`/`escalationChainsForSeverity`/`escalationTierStateKey` (+ `EscalationChain`, `RuleActionCarrier`), `escalationV2Schema`/`escalationTierV2Schema`, `emailCompositionSchema`, legacy `escalationSchema`/`escalationTierSchema`, the converters above, `buildSchemaCatalog`, `Trigger`/`RuleScope`/`RuleInput`/`PreviewRuleInput`/`ResetConfig`/`AutomationAction`/`EscalationV2Config`/… types, `CHANGE_TYPE_ACTIONS`, `ASSET_SCOPED_TRIGGER_TYPES` + `isAssetScopedTrigger` (composite is scoped iff kind="asset"), the composite helpers (`triggerConditionGroupSchema`, `compositeLeafSchema`, `isTriggerLeaf`, `collectTriggerLeaves`, `triggerConditionStats`, `collapseCompositeTrigger`, `validateCompositeTrigger`, `TRIGGER_GROUP_OPS`), the `*_METRICS`/`*_FIELDS`/`CHANGE_TYPES`/`RESET_MODES`/`API_CALL_METHODS`/`SCRIPT_RUN_TARGETS` constants.

**Used by:** `notificationRules.ts` (validation + schema endpoint), `notificationEngine.ts`, `notificationRuleService.ts`, `notificationEscalationService.ts`, `notificationRecipientService.ts`, `jobs/migrateAutomationRuleShape.ts`, the builder UI (via `/automations/schema`).

**Invariants:**
- Single source of truth — engine, routes, and frontend must read the vocabulary here, never hardcode it.
- `CHANGE_TYPE_ACTIONS` maps each change type to the exact audit Event action the persist* detectors emit AND the event-tail matches; both ends must agree.
- `buildSchemaCatalog().templateVariables` mirrors `TEMPLATE_VARIABLES` from `src/utils/notificationTemplate.ts` — the builder's insert-variable palette renders from it, never a hardcoded list.
- `buildSchemaCatalog().sensorClassUnits` mirrors `SENSOR_CLASS_UNITS` from `src/utils/hardwareSensors.ts` — hwSensorValue's metricMeta unit is the `"(sensor unit)"` placeholder, and the wizard resolves the real unit (°C/RPM/V) from the leaf's `sensorClass` dimension filter via this map (`leafUnit` in automations-wizard.js), the same map the sample classifier stamps into `AssetHardwareSensorSample.unit`.
- **Every reader of stored rules goes through `normalizeRuleToV2`** — never read `clearBehavior`/`targets` directly; they're the derived mirror, not the source of truth. Every writer persists v2 AND the mirror (`legacyMirrorOfV2`).
- `ruleInputSchema` output is canonical v2 (`RuleInput`): v2 fields win over conflicting legacy fields; a legacy-only body converts losslessly.
- api_call `url` is STATIC (no {token}s — SSRF-checkable at save); only `bodyTemplate`/`argsTemplate` interpolate. api_call headers are stored unmasked — the no-secrets warning lives in `apiCallMeta.help` + docs.
- Escalation INPUT stays the legacy email-tier shape until the escalation-v2 phase; `normalizeEscalationToV2` already converts both shapes for readers that want the v2 view.
- **Composite invariant:** 1 condition ⇒ legacy single trigger (per-dimension alerting + hysteresis-capable); ≥2 conditions ⇒ composite (per-asset alerting, ANY-dimension leaves, no clearThreshold). `collapseCompositeTrigger` in the input transforms enforces this for every author — never let a caller store a 1-leaf composite. Reset mode `condition` requires a composite trigger of the same kind (v1 restriction in `validateRuleV2`).

**When changing this:** Adding a metric/field → also wire its resolver in `notificationEngine` (else it parses but never reads data). Adding a change type → also emit the matching Event from the relevant persist* function. Adding a template token → add it to `TEMPLATE_VARIABLES` + `buildTemplateContext` in the util (and, if asset-sourced, the engine's `ASSET_DETAIL_SELECT`). Adding an action type → extend `actionSchema` + `assertActionRefs` (notificationRuleService) + the execution fan-out + `actionTypes` in the catalog. **Adding a scope dimension → THREE matchers must move in lockstep:** the engine's SQL `scopeWhere` (+ `loadScopeAssets` post-filter for non-SQL-expressible dims like subnetCidrs and `condition` trees, + SCOPE_SELECT if a new column is read — condition evaluation reads manufacturer/model/os/hostname/ipAddress/status), the in-memory `scopeMatchesAsset` twin in notificationRuleService (asset-details tab), and the wizard's Step-2 builder. The condition tree itself evaluates through ONE shared pure function (`evaluateScopeCondition` in notificationTypes) so the tree semantics can't drift; adding a condition FIELD means: SCOPE_FIELD_OPS + matchScopeRule + the catalog's scopeCondition.fields + (if a new asset column) both selects. `scopeRegionTagsOf` (recipient service) also mines positive region: tag rules from trees — keep it in mind when changing tag-rule semantics.

---

## services/notificationService.ts

**What it owns:** Triggered-notification read + lifecycle (View tab + asset tab): region-scoped listing, batch acknowledge/clear, the per-asset bundle, region-prefix stripping.

**Public API:** `listNotifications`, `acknowledgeNotifications`, `clearNotifications`, `getAssetNotifications`, `stripRegionPrefix`, `REGION_TAG_PREFIX`.

**Cross-service deps:** `prisma`, `eventLogService.logEvent`, `notificationRuleService.findRulesMatchingAsset`.

**Used by:** `src/api/routes/notifications.ts` (list/ack/clear), `src/api/routes/assets.ts` (`getAssetNotifications` at `/assets/:id/notifications`).

**Invariants:**
- Region scope: empty viewer tags = unrestricted; else show rows whose snapshotted `regionTags` intersect the viewer's tags PLUS unscoped (empty regionTags) rows.
- Acknowledge/clear are batch (`updateMany`, no per-row await) and always write an audit Event.

**When changing this:** Keep the region-scope rule in sync with `regionScopeService` (the viewer side) and the engine's `regionSnapshot` (the write side).

---

## services/maintenanceScheduleService.ts

**What it owns:** Maintenance schedules end-to-end — schedule CRUD, target resolution (criteria ∪ explicit assetIds, ∩ monitored), the reconcile tick that enters/exits assets (status flip to/from `"maintenance"` with `Asset.maintenanceReturnStatus` parking), operator release, per-asset reads for chart bands + edit-modal info, and window-row history/pruning.

**Public API:** `listSchedules`/`getSchedule`/`createSchedule`/`updateSchedule`/`deleteSchedule`, `previewTargets`, `listOccurrences` (calendar-tab expansion over a day range), `getAssetMaintenanceInfo`, `listAssetWindows`, `operatorReleaseAsset`, `releaseAssetsForDecommission`, `reconcileMaintenance` (serialized + coalesced — safe to call from anywhere), `MaintenanceScheduleInput`.

**Cross-service deps:** `prisma`, `eventLogService` (`logEvent` + `logEventsBatch`), `tagAssignmentService` (`normalizeCriteria` + `resolveMatchingAssetIds` — the shared criteria engine), `src/utils/maintenanceRecurrence.ts` (`validateScheduleShape`/`isInWindow`/`currentWindow`/`nextWindow`/`expandOccurrences`/`parseLocalDay`/`formatLocalIsoMinute`).

**Used by:** `src/jobs/maintenanceScheduler.ts` (30s tick), `src/api/routes/maintenanceSchedules.ts` (CRUD + preview), `src/api/routes/assets.ts` (maintenance-windows + maintenance-info reads; `operatorReleaseAsset` from the PUT handler when an operator moves status off `"maintenance"`), `src/services/discovery/discoveryEngine.ts` (`releaseAssetsForDecommission` from the Phase 2a firewall sweep + its controller cascade onto managed FortiSwitches/FortiAPs, and the Phase 2b FortiSwitch/FortiAP decommission sweep).

**Readers of the state it writes:** `MONITOR_CANDIDATE_WHERE` in `monitoringService` + `jobs/monitorAssets` (status="maintenance" excluded from ALL server-driven polling), `dependencyTreeService.evaluateSuppression` (maintenance parent counts as down → children suppress — unless the schedule's `suppressChildren` is false, OR-ed across the asset's open windows by `reconcileDependencySuppression`'s open-window query), `notificationEngine.isSuppressedForNotifications` + `notificationEscalationService.runEscalationSweep` (silenced), `presenceVerificationService` + `jobs/decommissionStaleAssets` (skip maintenance assets), the assets-list pill (`badge-maintenance`), the chart band overlay (`_maintenanceBandLayer` via `/assets/:id/maintenance-windows`), and the NOC dashboard surfaces (`nocDashboardService`'s `NOT_IN_MAINTENANCE` excludes maintenance assets from every down/warning/stale feed + buckets them as `statusCounts.maintenance`; `routes/dashboard.ts` `/summary` monitorAlerts mirrors it; the Status Map widget paints `status="maintenance"` sites purple instead of down).

**Invariants:**
- Open `AssetMaintenanceWindow` rows are the SOLE source of truth for "in maintenance": enter on the first open row, exit on the last close — restart-safe by construction; never flip status without the matching row write.
- `maintenanceReturnStatus` parks the pre-window status; a manually-set `"maintenance"` parks verbatim so exit restores the operator's manual state (no loop). Exit restores ONLY when status is still `"maintenance"` — anything else means an operator/guarded writer moved it and wins.
- Operator release (`endReason="operator"`) suppresses scheduler re-entry for the CURRENT occurrence (`currentWindow().start` comparison); the next occurrence re-enters normally.
- Targets are always ∩ `monitored: true`, and criteria may never contain a `status` rule (membership would oscillate as the feature flips status).
- **Ad-hoc lifecycle:** the ad-hoc shape (one-shot + no criteria + exactly one explicit assetId — `isAdhocShape`) self-deletes once spent: `operatorReleaseAsset` deletes it after closing windows (a released one-shot can never re-fire), and the reconcile's spent sweep deletes it when its window closes with reason "schedule" and `nextWindow` is null. Reasons "disabled" (operator intent) never auto-delete. Closed windows keep `scheduleName`; the FK goes SetNull.
- **Never trust a client-stamped "now":** ad-hoc creates send `schedule.startNow: true` and `resolveStartNow` (maintenanceRecurrence) stamps startAt from the SERVER clock pre-validation — a browser-stamped startAt broke immediate entry whenever the operator's clock ran ahead of the server.
- **Any new writer of `Asset.status` must skip assets with `status === "maintenance"`** (see the guards in discoveryEngine.ts Entra/AD/FortiSwitch/lease paths + decommissionStaleAssets); the reconcile self-heal absorbs missed writers but audits them as re-flips.
- **Deletion-at-source is the ONE carve-out from that guard.** The Phase 2a/2b discovery decommission sweeps DO judge maintenance assets and call `releaseAssetsForDecommission` (window closed `endReason="decommissioned"`, parked status cleared, `status="decommissioned"` — all in one transaction so the reconcile can't observe a half-state and re-enter or self-heal-reflip). Roster/inventory absence is CONFIG truth, not reachability (an offline device stays in the FMG roster; a powered-off switch/AP stays `cmdbProtected`), so it outranks the window — otherwise a device deleted from FortiManager mid-window came back as `"active"` at window end. `decommissionStaleAssets` keeps its guard: that one ages on `lastSeen`, which maintenance freezes by design. Re-entry is prevented by the `monitored=false` clamp (business rule 10) the status write triggers, not by an `endReason` check.
- **Occurrence times leave this service as server-local wall-clock STRINGS, never Dates.** `listOccurrences` formats through `formatLocalIsoMinute` because the recurrence engine evaluates against the Polaris server's clock: serialize a Date and every browser east or west of the server re-renders the window on a different day than the one it will actually run on. The calendar tab's day bucketing is string arithmetic for the same reason.
- All bulk writes are grouped `updateMany`/`createMany` — no per-asset await loops (2000-asset scale rule); per-row awaits only for transition Events.

**When changing this:** Any change to the enter/exit semantics must keep `reconcileMaintenance()` idempotent (running twice in a row must be a no-op) and update CLAUDE.md business rule 16. If you add a schedule field, thread it through the Zod outer shape in `routes/maintenanceSchedules.ts`, `normalizeInput`, the modal editor in `public/js/assets-maintenance.js` (collect + fill + summary — INCLUDING the Schedules-tab enable-toggle passthrough, which PUTs the full body: a field it omits snaps back to its `normalizeInput` default, exactly the trap `suppressChildren` documents), and the recurrence tests. A field that should show on the calendar also needs threading into `listOccurrences`' row shape + the chip render in `_maintRenderCalendar`. **Both ad-hoc "enter maintenance until…" entry points (status-pill popover, asset edit modal → Maintenance tab) must validate through `maintValidateAdhocEnd`** — a datetime-local with an untouched time half reads as `""`, and the edit modal used to drop that request silently after a successful asset save, reporting "Asset updated" with no window anywhere. The edit modal additionally verifies the outcome with `/assets/:id/maintenance-info` afterwards, because a schedule can be created for an UNMONITORED asset that then never enters maintenance (targets are ∩ monitored).

---

## services/notificationDimensionService.ts

**What it owns** — nothing persistent. Read-only lookup answering "what do THESE devices actually report for this metric dimension?" for the automation builder's dimensionFilter pickers.

**Public API** — `listDimensionValues(metric, dimension, scope, narrow?)`, `dimensionPickerMeta()` (merged into `GET /automations/schema` as `dimensionPickers`), `foldValuePairs` (pure, unit-tested).

**Readers / callers** — `api/routes/notificationRules.ts` only (`POST /automations/dimension-values` + the `/schema` merge). Client consumer: `public/js/automations-wizard.js` (`dimControlHtml` / `refreshDimOptions`, pure helpers on `window.PolarisAutomationDimensions`).

**Depends on** — `notificationEngine.loadScopeAssetIds` (the SAME `loadScopeAssets` the evaluation tick uses — deliberate, so the picker can never offer a value from a device the automation wouldn't evaluate) and `notificationTypes.METRIC_DIMENSIONS` (which dimensions a metric takes; a mismatch is a 400, never a silent empty list that reads as "no sensors").

**Invariants**

- **`DIMENSION_SOURCES` keys and the `dimensionFilterSchema` fields are a LOCKSTEP PAIR.** Adding a dimensionFilter field means: the Zod field, `METRIC_DIMENSIONS`, `dimensionPhrases` (server) + `DIM_PHRASE`/`DIM_PLACEHOLDER` (client), the engine's reading resolver (the filter is only real if something applies it), and a `DIMENSION_SOURCES` entry — otherwise the input silently stays free text.
- **`strict` must mirror the Zod shape.** `strict: true` renders a select; making a dimension a closed enum server-side without flipping this leaves the UI offering a text box the server now rejects, and vice-versa a select over a substring field would forbid legitimate partials.
- **Bounded queries only.** This is interactive and runs against hypertables: keep the window + asset cap, and keep the aggregation Postgres-side (GROUP BY, never fetch-then-count-in-JS). `sampledAssets < scopedAssets` MUST be reported so the UI can disclose a partial list.
- **An empty result is a load-bearing answer**, not an error — it renders as "these devices report no <noun>, this condition would never match". Which is why the widened retry exists, and why `narrowLabel` ships with it: "no hardware sensors" must not be shown when the truth is "none of the class you picked".

**When changing this**

1. Adding a dimension → walk the lockstep list above, then add a `DIMENSION_SOURCES` entry + a case to `tests/unit/automationDimensionValues.test.ts`.
2. Changing the window/caps → re-reason at 100 AND 2000 assets (default scope is every asset) and update the numbers quoted in ARCHITECTURE.md.
3. New sibling narrowing → extend `DimensionNarrow`, the route's `narrow` schema, AND the client's `awDimNarrow`, or the client will keep asking for the unnarrowed list.
## services/contactService.ts

**What it owns:** The address book — `Contact` CRUD, the unified recipient search that backs both the address-book picker and the wizard's typeahead, and the fire-time "who is responsible for this device?" lookup.

**Public API:** `listContacts`/`getContact`/`createContact`/`updateContact`/`deleteContact`, `normalizeContactEmail`, `previewContactAssets`, `searchAddressBook`, `resolveContactsForAsset`/`resolveContactEmailsForAsset`, `bumpContactCache`.

**Cross-service deps:** `prisma`, `eventLogService` (`logEvent`), `tagAssignmentService` (`normalizeCriteria`, `resolveMatchingAssetIds`, `assetMatchesCriteria`, `collectCidrs`, `cidrsContainingIp`, `SINGLE_ASSET_CANDIDATE_SELECT`), `notificationRecipientService` (`listRecipientUsers`), `utils/ttlCache`.

**Used by:** `src/api/routes/contacts.ts` (CRUD + search + preview), `src/api/routes/assets.ts` (`GET /assets/:id/contacts`), `src/services/automationActionService.ts` (`resolveContactEmailsForAsset` on the fire path, for `recipientAssetContacts`), `public/js/automations-address-book.js` (both surfaces), `public/js/automations-wizard.js` (the recipient typeahead + the save-to-book affordance).

**Readers of the state it writes:** the Automations → Address Book tab, the automation wizard's recipient fields, the asset slide-over's General-tab Contacts rows, and every alert whose notify action sets `recipientAssetContacts`.

**Import-cycle note:** `contactService` imports `notificationRecipientService` for `listRecipientUsers`, so the delivery expander must NOT import `contactService` back. `expandDeliveries` therefore takes the resolved `assetContactEmails` as an option and `automationActionService` does the lookup — the same shape as the region tags it already receives. Keep it that way.

**Two tag namespaces in the recipient index (`notificationRecipientService`).** `IndexedUser` carries BOTH `matchSet` (region ∪ other tags, flattened) and `regionSet` (region tags only). They are not interchangeable:
- `resolveRecipientUsers` (legacy free-form `recipientTags`) and `recipientDeviceRegion` / `recipientScopeRegion` use **`matchSet`** — changing that would alter delivery for existing rules.
- `resolveUsersByRegions` / `resolveUsersInAnyRegion` (the push broadcast modes, where an operator picks a region BY NAME from the map-region catalogue) use **`regionSet`**. A user whose unrelated *other* tag happens to read "Atlanta" must not receive Atlanta's alerts, which is exactly what the flattened set would do.
Also note the two storage conventions: user/role/group `regionTags` are stored **bare** ("Atlanta"), asset tags carry the **`region:` prefix**. `normalizeNeedle` strips the prefix, so either form may be passed in — but store bare names in `recipientRegions`.

**Invariants:**
- **`email` is stored trimmed + lower-cased.** The unique index is what enforces one row per address, and lower-casing at the boundary is what makes it case-insensitive. It also has to match `resolveEmailRecipients`' normalized set, or a contact address would dedupe inconsistently against a user's.
- **`resolveContactsForAsset` must never scan the fleet.** It is on the alert path. A pin match is a plain id comparison with NO asset load; criteria are evaluated against the ONE triggering asset with `assetMatchesCriteria`; CIDR containment is a single round-trip across all contacts' CIDRs combined, and skipped entirely when nobody filters by subnet. If you add a criteria field that needs another relation, extend `SINGLE_ASSET_CANDIDATE_SELECT` in `tagAssignmentService` — do not add a query per contact.
- Targets are the UNION of criteria matches and explicit pins, and — unlike `MaintenanceSchedule` — are deliberately **not** intersected with `monitored: true`. An unmonitored device still has an owner, and event/change automations fire on it.
- `searchAddressBook` dedupes with the **user winning over the contact** on the same address: a `User.id` survives the person changing address, a stored contact string does not.
- Every write calls `bumpContactCache()`. The 30s TTL is what keeps the fire-time path off the table; a write that skips the bump leaves alerts routing on stale ownership for up to 30s.
- Ownership is enforced at the ROUTE (`requireOwnership` + `assertOwnership`), not here — this service is level-agnostic apart from stamping `createdBy` on create.

**When changing this:** Adding a field means threading it through the Zod shape in `routes/contacts.ts`, `ContactInput`, the editor in `public/js/automations-address-book.js` (collect + fill), and the tests. If you change the criteria vocabulary, it is `tagAssignmentService`'s — shared with maintenance schedules and the app-map discovery rules, so change it there and check all three.

---

## services/notificationRuleService.ts

**What it owns:** Notification RULE logic — scope matching, the "rules matching this asset" lookup, rule CRUD, and the change-type subscription cache that gates the persist* change-detectors.

**Public API:** `scopeMatchesAsset`, `findRulesMatchingAsset`, `getMetricSeverityTiers`, `listRules`/`getRule`/`createRule`/`updateRule`/`deleteRule`, `isChangeActionSubscribed`/`getSubscribedChangeActions`/`bumpChangeSubscriptions`, `ScopeAsset`, `MetricSeverityTier`.

**Cross-service deps:** `prisma`, `eventLogService.logEvent`, `notificationTypes` (incl. `resolveTierLadder` + `hwSensorFilterMatches`, shared with the engine).

**Used by:** `notificationService` (asset tab), `notificationEngine` (preview scope), `notificationChangeEvents` (subscription gate), `src/api/routes/notificationRules.ts` (CRUD), `src/api/routes/assets.ts` (`GET /:id/metric-thresholds` → the asset charts' severity shading).

**Invariants:**
- `scopeMatchesAsset`: AND across provided dimensions, OR within each list; `allAssets` short-circuits true; no dimensions + not allAssets ⇒ matches nothing.
- Every rule write calls `bumpChangeSubscriptions()` so the persist* detectors pick up new/removed change subscriptions.
- **No path may strand an active alert under a rule the engine no longer evaluates.** `updateRule` clears active alerts + deletes state rows on trigger-identity change (`system:rule-edited`) AND on enabled→disabled (`system:rule-disabled`); `deleteRule` clears active alerts (`system:rule-deleted`) BEFORE the delete (the cascade drops the state rows and `ruleId` goes NULL, after which nothing can auto-clear). Soft-clear only — history survives.

- `getMetricSeverityTiers` must derive thresholds through the SAME primitives the engine evaluates — `resolveTierLadder` for the band ladder, `hwSensorFilterMatches` for dimension selection. It feeds a CHART that claims to show what an automation would do, so a private re-derivation here would draw a line that disagrees with the alerts. It deliberately skips the rule-18 carve-out: precedence decides which automation notifies, while the reading crosses the same value either way.

**When changing this:** The subscription cache has a 60s TTL fallback; a write must bump it so change emission turns on/off promptly. Any new way to take a rule out of evaluation (new enabled-like flag, archive state) needs the same active-alert cleanup. A new numeric asset metric worth shading on a chart needs nothing here (the ladder is metric-agnostic) — but a new DIMENSION filter does: add its predicate beside `hwSensorFilterMatches` in notificationTypes, use it in BOTH the engine's resolver and `getMetricSeverityTiers`, and thread the identifying fields through the `/metric-thresholds` query.

---

## services/notificationEngine.ts

**What it owns:** The rule evaluator. Threshold/state path (per-metric sample resolvers + the NotificationRuleState machine with forDuration/cooldown + v2 `reset` semantics: auto with hysteresis `clearThreshold` + clear-sustain `sustainSec` via `NotificationRuleState.recoveredSince`, timed via `afterSec` sweep, manual re-arm), the event-tail path (cursor over Event rows matching event/change rules), all fire-time template rendering (in-app message + composed email via `src/utils/notificationTemplate.ts`), and `previewRule` (dry-run; scope-only mode + hysteresis `wouldClear`/`inDeadBand` per match). Also owns **precedence carve-out** (a more-specific same-`triggerSignature` rule shadows the assets it covers out of lower-`scopeRank` rules — drop reading, clear active alert `notification.superseded`, reset pending) and **severity bands** (value-driven severity escalation — `tierLadderFor` + the pure `updateTierMetSince`/`sustainedSeverity` resolve the tier under PER-TIER sustained durations against `NotificationRuleState.bandMetSince`, `applyBandTransition` re-notifies per `bandNotify` policy on increase/decrease + eases a dead-banded alert to base severity, `fireResolved` on drop below tier 0, `firingSeverity` tracks the live band), plus the **vanished-state sweep** (`clearVanishedStates` — clears firing/pending rows for assets/dimensions the rule can no longer see; both evaluators).

**Public API:** `evaluateAllNotificationRules` (job entry), `previewRule`, `buildComposedEmail(comp, ctx)` (also used by the escalation sweep), `assetDetail`/`clearAssetDetailCache` (per-tick asset-detail cache), and the unit-tested pure helpers `compareNum`/`compareValue`/`globToRegExp`/`readingMeets`/`recoveredMeets`/`buildShadowIndex`/`isAssetShadowed`/`carveOutAggregate`/`tierForSeverity`/`bandNotifyOf`.

**Cross-service deps:** `prisma` (assets + every sample table + notifications + state + Event + Setting), `eventLogService.logEvent`, `notificationService.REGION_TAG_PREFIX`, `notificationTypes`, `notificationRecipientService` (expandDeliveries + ComposedEmail), `src/utils/notificationTemplate.ts`.

**Used by:** `src/jobs/evaluateNotificationRules.ts`, `src/api/routes/notificationRules.ts` (`previewRule`), `notificationEscalationService` (`buildComposedEmail`).

**Invariants:**
- Fire only on the clear→firing transition; state writes happen only on transition (hot path scales with *changes*, not fleet size).
- Recovery is acted on only from an explicit not-meeting reading (missing data leaves a firing state alone — including a half-elapsed `recoveredSince` sustain timer, which freezes under maintenance/dependency suppression); `timed` clears purely on its timer. The one carve-out is the **vanished-state sweep** (`clearVanishedStates`, both evaluators): a firing/pending row whose ASSET left the resolved scope (scope edit, tag drift, asset deleted) or whose DIMENSION stopped being covered while the asset still produced other readings (interface unpinned/admin-downed, mount/tunnel gone, dimensionFilter edit) is cleared (`system:out-of-scope`, Event `notification.out_of_scope`) — those keys would otherwise sit firing forever since the loop only re-evaluates keys that produce readings. Suppressed assets stay frozen (re-checked via asset fetch for out-of-scope candidates so a `status` scope condition can't defeat rule 16), and an in-scope asset with NO readings at all stays frozen (collection gap ≠ recovery). Zero extra queries on the steady-state tick.
- Hysteresis dead band (auto + clearThreshold, value between clear and fire thresholds): the firing state holds, and any running sustain timer cancels. For a BANDED rule the held alert additionally EASES to the base severity (`applyBandTransition` to `rule.severity`; notify per `bandNotify.onDecrease`) — a value that crashes from the critical band straight into the dead band in one tick must not park at critical. `recoveredSince` writes are transition-only (met↔recovered edges), never per-tick; it is a firing-state-only field, distinct from the pending-side `conditionMetSince` (nulled on fire). Every state-clearing write (recover / timed sweep / manual re-arm / re-fire) must null `recoveredSince`.
- **ifOperStatus/ifAdminStatus readings are pinned-interface only** (`Asset.monitoredInterfaces`, added to `SCOPE_SELECT` — the Down Interfaces widget's join): the interfaces stream samples every port a device reports, and unpinned ports are usually just unplugged. `ifOperStatus` additionally requires the sample's `adminStatus === "up"` (an admin-downed port is deliberately down). An interface leaving the pin set stops producing readings and its alert clears via the vanished-state sweep.
- Notification `regionTags` are snapshotted from the asset's `region:` tags at fire time; `templateCtx` is snapshotted only when the rule has emailComposition/escalation (escalation renders from it later, surviving asset deletion).
- `SCOPE_SELECT` stays tight (hot 60s×2000-asset path); the wider `ASSET_DETAIL_SELECT` fetch runs only on FIRE and only when composition/escalation/{asset.*} tokens need it, through the per-tick cache.
- All interpolation goes through `renderNotificationTemplate` (single-brace {token}, single pass, unknown tokens literal) — never hand-rolled replaceAll chains.
- Scale: batch findMany per sample table (no per-row awaits) — re-check at 2000 assets when adding a metric.
- **Composite path is separate by design** (`evaluateCompositeRule` + collectLeafRefs/resolveLeafTruths/evalTriggerTreeForAsset/compositeOutcomeForAsset/applySustainedRecovery): per-ASSET state at dimensionKey "" (ANY-dimension leaves, one alert per device), leaves resolved through the UNCHANGED single-trigger resolvers with identical leaves deduped to one query. Never generalize the legacy per-reading loop to cover composites — the two share only fire/recover/upsertState. Missing leaf ⇒ false; asset with zero readings across all leaves ⇒ skipped (state frozen). Orphan sweep: any state row with dimensionKey ≠ "" under a composite rule is cleared + deleted (`system:rule-edited`). Condition-mode reset resolves its tree ONLY against firing assets and is the sole recovery authority while firing (`recover()` treats "condition" like "auto"); auto for composites = !tree, no hysteresis dead band.
- `notificationRuleService.updateRule` clears the rule's active alerts (by ruleId) + deletes its state rows whenever the trigger IDENTITY changes (`triggerIdentityOf`: type/kind/metric/field/changeType, `system:rule-edited`) OR the rule is DISABLED (`system:rule-disabled` — the engine only evaluates enabled rules, so a disabled rule's alerts would strand uncleared forever); threshold/operator/tree edits keep state. `deleteRule` clears active alerts first (`system:rule-deleted`) — the cascade drops the state rows, after which nothing could ever auto-clear them (Notification.ruleId goes NULL via SetNull). Migration `20260730000000_stranded_alerts_cleanup` healed pre-fix strays and backfilled `firingSeverity` from the live notification's severity (NULL rows read as "at base severity", blocking de-escalation into the base band).
- **Carve-out is same-signature only** (`triggerSignature`): a specific temp automation never silences an unrelated DOWN one. The shadow index is built once per tick over the enabled rule set; the per-asset test reuses the pure `scopeMatchesAsset` (kept in lockstep with `scopeWhere`/`evaluateScopeCondition`). Superseding CLEARS the general alert (handoff is permanent) — distinct from maintenance suppression, which FREEZES firing rows. Same-rank ties both fire.
- **Severity bands stay backward-compatible**: no `severityBands` ⇒ `severityForValue` returns base-or-null, identical to the pre-band fire/clear. Bands are numeric (asset_metric/host_metric) only. On a band change the alert updates severity + message IN PLACE (one row per asset) and stamps `escalationState.bandSince` so the per-band time-escalation restarts; the sweep selects the active severity's chains via `escalationChainsForSeverity` (notificationTypes — band level chain + band/base actions' per-action chains). Value-bands and time-escalation are independent axes.
- **"Sustained for" is per TIER** (business rule 19): the banded path does NOT read `trigger.forDurationSec`/`conditionMetSince` — it resolves `tierLadderFor(rule)` once per rule per tick, rolls `NotificationRuleState.bandMetSince` (`{[severity]: epochMs}`) forward with `updateTierMetSince`, and fires/transitions on `sustainedSeverity` (most-severe tier whose own run outlasted its own duration). The non-banded path is byte-for-byte unchanged. Three properties the write path depends on: the map is persisted only when `tierMetSinceChanged` (transition-only writes at 2000 assets), an empty map stores as SQL NULL (`metSinceJson`), and EVERY state-clearing write nulls it — a stale run would let a re-entering tier fire instantly. Band ESCALATION is gated by the target tier's duration; de-escalation and the dead-band ease-to-base are immediate by design (the lower tier's run is already old, and parking at a band the value no longer satisfies is the bug the dead-band ease exists to prevent).

**When changing this:** New metric → add a resolver branch AND the catalog entry in `notificationTypes` (composite leaves get it for free via the shared resolvers). New clear behavior → handle it in `recover()`, the timed-sweep pass, AND the composite transition block. New template token → `TEMPLATE_VARIABLES` + `buildTemplateContext` in the util (+ `ASSET_DETAIL_SELECT` here if asset-sourced). New scope dimension → add it to the `scopeRank` ladder in `notificationTypes` (else it can't participate in precedence). Changing the band state machine → keep `notificationEscalationService`'s `bandSince` handling + `escalationChainsForSeverity` (notificationTypes) in lockstep. New place actions can live → add it to `allRuleActionRefs` (the script gate, `assertActionRefs`, and `ruleWantsAssetDetail` all collect through it).

---

## services/notificationChangeEvents.ts

**What it owns:** The bridge from current-state persist* functions (LLDP/processes/SD-WAN/MCLAG) to the engine's event path — emits one audit Event per diffed change, gated on an active change subscription.

**Public API:** `maybeEmitChangeEvents(action, assetId, assetName, items)`, `ChangeItem`.

**Cross-service deps:** `eventLogService.logEventsBatch`, `notificationRuleService.isChangeActionSubscribed`.

**Used by:** `monitoringService` persist* functions (`persistLldpNeighbors`, `persistAssetProcesses`, `persistSdwanRules`, `persistMclagPeers`).

**Invariants:**
- Zero cost when unsubscribed — the subscription check gates BOTH the Event writes here and (in monitoringService) the prior-state load used to compute the diff.
- `resourceType="asset"` + `resourceId=assetId` so the engine resolves the notification's asset + region scope. Best-effort; never throws into a scrape.

**When changing this:** A new change type needs (1) a `CHANGE_TYPE_ACTIONS` entry, (2) a subscription-gated diff + `maybeEmitChangeEvents` call in the relevant persist function, (3) the change type in `notificationTypes`.

---

## services/probeLossQuery.ts

**What it owns:** The single windowed failed-probe-ratio SQL over `asset_monitor_samples` (UTC-wall-clock-anchored `now() AT TIME ZONE 'UTC'` window, grouped per asset).

**Public API:** `queryProbeLossRatios({ sinceMinutes, assetIds?, onlyLossy?, limit? })`, `ProbeLossRow`.

**Used by:**
- `src/services/notificationEngine.ts` — the `probeLossPct` trigger (engine mode: every asset with ≥1 successful probe, INCLUDING 0%-loss rows so hysteresis/auto-clear rules recover).
- `src/services/nocDashboardService.ts` — `getPacketLoss` (widget mode `onlyLossy: true`: additionally requires ≥1 failure, orders lossiest-first, caps at `limit`; `limit` null = uncapped via Postgres `LIMIT NULL`).

**Invariants:**
- Fully-down assets (0 successes in the window) are excluded in BOTH modes — asset-down alerting/widgets own them.
- The engine/widget HAVING difference is a real semantic (0%-loss rows feed hysteresis recovery; the widget hides clean assets) — it is the `onlyLossy` parameter, never re-fork the query.
- All SQL fragments are compile-time literals; user data rides positional parameters only.

**When changing this:** both consumers' post-processing assumes `{ assetId, total, failed }` bigint rows; the window must stay UTC-wall-clock-anchored (the hypertable's timestamps are naive UTC).

---

## services/regionScopeService.ts

**What it owns:** The shared effective-tag resolver — `union(role, user, group)` for region + other tags.

**Public API:** `resolveTagScopesForUser(u)`, `getEffectiveRegionTags(userId)`, `TagScope`/`UserTagScopes`.

**Cross-service deps:** `prisma` (user + role), `groupMappingService.resolveGroupsToAccess`, `tagNormalize.unionTags`.

**Used by:** `src/api/routes/auth.ts` (`GET /auth/me`), `src/api/routes/notifications.ts` (region-scoped list via `getEffectiveRegionTags`).

**Invariants:**
- Group-derived tags are re-resolved live from `ssoGroups` each call — never persisted onto the user's own columns.
- Empty effective tags means "unrestricted" downstream.

**When changing this:** `/auth/me` and the notifications list must stay on this helper so the operator-visible scope and the enforced scope can't drift.

---

## services/notificationRecipientService.ts

**What it owns:** Routing a fired notification to concrete delivery recipients, and expanding a rule's `targets[]` into `NotificationDelivery` rows.

**Public API:** `resolveRecipientUsers(recipientTags)`, `resolveRecipientUsersByIds(ids)`, `resolveEmailRecipients({recipientUserIds?, addresses?})`, `dedupeEmailRecipients(to, cc, bcc)` (pure), `listRecipientUsers()` (builder picker), `scopeRegionTagsOf(scope)`, `expandDeliveries(notificationId, targets, opts {scopeRegionTags?, assetRegionTags?, composedEmail?, escalation?})`, `ExpandDeliveriesOptions` + `ComposedEmail` types, `bumpRecipientIndex()`.

**Cross-service deps:** `regionScopeService.resolveTagScopesForUser` (effective tags per user), `notificationService.stripRegionPrefix`, `notificationTypes.CHANNEL_TRANSPORT` (channel type → transport), `prisma` (notificationChannel lookup + users + pushSubscriptions + notificationDelivery).

**Used by:** `src/services/automationActionService.ts` (the notify arm — sole `expandDeliveries` caller; the engine + escalation sweep reach it through `executeActions`), `src/api/routes/notificationRules.ts` (`GET /recipient-users`).

**Invariants:**
- A target's recipients (email/web_push channels) = union of explicit `recipientUserIds` + (when `recipientDeviceRegion`) users matching the TRIGGERING asset's `region:` tag(s) (`assetRegionTags` — engine passes `regionSnapshot(reading.tags)`, the sweep passes `Notification.regionTags`) + (when `recipientScopeRegion`) users matching the rule's scope `region:` tag(s) + legacy `recipientTags`, plus explicit `addresses` (email). Deduped by user id.
- Recipient matching strips the `region:` prefix and lower-cases both sides, so a scope tag `region:Atlanta` matches a user whose regionTags include `Atlanta`; region + other tags are matched as one union.
- `recipientScopeRegion` resolves against the RULE'S SCOPE region tags (passed in by the engine); `recipientDeviceRegion` resolves against the TRIGGERING ASSET's region tags — the builder now offers only device-region (scope-region renders on old actions that already carry it).
- slack/teams/pushbullet ignore recipients entirely (one fixed-destination row).
- Recipients are snapshotted at fire time (delivery rows reflect targets when the rule fired, not when the drain runs).
- With a `composedEmail` (rule has emailComposition), each email target gets ONE row (`target` = joined To list, `meta` = {composed, to, cc, bcc, subject, text, html?}); empty To skips the target. Cc/Bcc dedupe: To wins over Cc, Bcc drops anything visible in To/Cc. Without it, the legacy one-row-per-address fan-out is byte-identical.
- `meta` carries rendered content + recipient addresses only — never channel secrets.
- In-app delivery is never a `NotificationDelivery` row — it's the `Notification` itself.

**When changing this:** keep the tag-match semantics aligned with `scopeMatchesAsset` and `regionScopeService` so rule scope and recipient routing read tags the same way. Bump the user-tag index cache (`bumpRecipientIndex`) if a user/role/group-mapping write must take effect immediately.

---

## services/notificationDeliveryService.ts

**What it owns:** Draining pending `NotificationDelivery` rows and dispatching each to its channel.

**Public API:** `drainPendingDeliveries()`.

**Cross-service deps:** the channel senders (`notificationChannels/emailChannel.{sendSmtpEmail,sendM365Email}`, `webhookChannel.sendWebhook`, `pushbulletChannel.sendPushbullet`, `webPushChannel.sendWebPush`), `prisma` (delivery rows + notificationChannel config + pushSubscription prune), `eventLogService.logEvent`.

**Used by:** `src/jobs/deliverNotifications.ts` (15s tick).

**Invariants:**
- Each delivery's destination secrets (SMTP password, webhook URL, VAPID key, …) are read from its `NotificationChannel` at send time, NOT stored on the delivery row.
- A missing/deleted channel (NULL channelId) is a PERMANENT fail (not retried); otherwise ≤3 attempts before flipping to `failed`.
- Email rows branch on `meta.composed`: composed rows send ONE to/cc/bcc message from the meta snapshot (to/cc/bcc coerced through a string-array guard — meta is untyped Json); rows without it (incl. pre-upgrade pending rows) take the legacy `titleFor + message + View link` per-address path, byte-identical.
- A web_push 410/404 prunes the dead `PushSubscription` (by endpoint).
- Bounded concurrency on sends; one summary audit Event per non-empty drain (no per-delivery Event spam).

**When changing this:** scale-check at 2000 assets — the batch (`BATCH_SIZE`) + concurrency cap keep a delivery spike from stampeding SMTP/webhook endpoints. Never row-scan the full table; always filter `status=pending, attempts<MAX`.

---

## services/notificationEscalationService.ts

**What it owns:** The escalation sweep — running each rule's escalation TIERS OF ACTIONS (v2: notify / api_call / script, via `automationActionService.executeActions` with `exec.escalation` set) while a notification stays unhandled, and the per-notification `escalationState` bookkeeping. Legacy email tiers normalize to single-notify-action tiers (`normalizeEscalationToV2`) and produce byte-identical emails (parity-tested in notificationEscalationV2.test.ts). **Per-action + value-band aware:** the alert's current severity selects the active CHAINS via `escalationChainsForSeverity` (notificationTypes) — the rule/band LEVEL chain (state keys stay the bare numeric tier indexes pre-feature rows carry) plus one chain per effective action (state keys `a<i>:t<j>` via `escalationTierStateKey`), with per-chain `stopOn` (an acknowledged alert stops "acknowledge" chains while "clear" chains keep escalating); a rule whose only chain is per-action or band-level is still swept (`allEscalationsOf`); tier delays measure from `escalationState.bandSince ?? triggeredAt` so a freshly-entered band restarts its timers.

**Public API:** `runEscalationSweep(now?)` (job entry), `tierIsDue(tier, triggeredAt, tierState, now)` (pure, structural tier type — legacy and v2 tiers both fit; unit-tested).

**Cross-service deps:** `prisma` (rules + notifications + assets), `automationActionService.executeActions` (the entire send path — this service no longer builds delivery rows itself), `notificationTypes.normalizeRuleToV2`, `notificationRecipientService.scopeRegionTagsOf`, `notificationEngine.isSuppressedForNotifications`, `src/utils/notificationTemplate.ts` (buildTemplateContext/formatElapsed/notificationsPageUrl), `eventLogService.logEvent`.

**Used by:** `src/jobs/escalateNotifications.ts` (60s tick).

**Invariants:**
- "Unhandled" per the rule's `stopOn`: `acknowledge` stops on ack OR clear; `clear` ignores ack. Cleared always stops (the query excludes cleared rows).
- Renders from the fire-time `Notification.templateCtx` snapshot (+ live `{escalation.tier}`/`{escalation.elapsed}`); pre-feature notifications fall back to a minimal context from the row.
- **Escalation notify composition is a PER-FIELD merge** (tier subject ?? rule subject, tier body ?? rule body — implemented in automationActionService.composeForNotify), always composed, `[ESCALATION n]` prefix only when neither level set a subject. cc/bcc come from the tier action only. Don't "simplify" to whole-object precedence — that breaks subject-only tier overrides.
- A tier counts as SENT (state bump) only when `executeActions` reports ≥1 executed action — dead channels / empty recipients retry next sweep.
- Repeats: only when `repeatEveryMin` is set, gated by `maxRepeats` (default 5) — a run-once tier never re-fires.
- Scales with the active-unhandled notification count, not fleet size; per-tier recipient resolution rides the recipient service's 30s user-index TTL (the old per-sweep cache was dropped with the executeActions cutover — escalation volume is small).

**When changing this:** state keys in `escalationState.tiers` are tier INDEXES — reordering a rule's tiers re-keys them (an already-sent tier position can re-fire); keep that acceptable or key by content hash. Tier-action reference validation lives in `notificationRuleService.assertActionRefs` (unified with top-level actions).

---

## services/macAddressService.ts

**What it owns:** The two AssetMacAddress side-table WRITERS (moved from utils/macAddresses 2026-08 — utils stay pure): `reconcileMacAddresses(assetId, macs)` (discovery's in-memory-list sync — bulk INSERT…ON CONFLICT, mac-sorted for deterministic lock order, deadlock-retried) and `reconcileInterfaceMacs(assetId, macs, now?)` (the interface-scrape fold into `[mac, macEnd]` range rows, source-scoped full-replace with the occupied-key slide).

**Public API:** `reconcileMacAddresses`, `reconcileInterfaceMacs`.

**Cross-service deps:** `prisma` (asset_mac_addresses), `utils/dbRetry.retryOnDeadlock`, and the pure surface in `utils/macAddresses` (INTERFACE_MAC_SOURCE, foldMacsToRanges, macToInt/intToMac, MacJsonEntry/MacRangeEntry).

**Used by:** `discovery/discoveryEngine` (every asset-write site that rebuilt a mac list), `api/routes/agents.ts` (interfaces push + sample-merge), `monitoringService` (system-info interface scrape).

**Invariants:**
- Ownership split: rows with `source="monitor-interface"` (the only rows that may carry `macEnd`) belong to `reconcileInterfaceMacs`; `reconcileMacAddresses` filters them from its input AND scopes its deletes away from them. Neither writer may churn the other's rows.
- When another source holds a would-be range's start key, the range starts one past it (the occupied row keeps its richer discovery metadata).
- All writes ride `retryOnDeadlock`; the discovery reconcile sorts by mac asc so ~50 parallel reconciles acquire index-page locks in deterministic order.

**When changing this:** search behavior depends on canonical colon-uppercase storage (string order == numeric order for range containment — see searchService); anything changing the stored MAC shape breaks range lookup.

---

## services/pushSubscriptionService.ts

**What it owns:** The write path for the `PushSubscription` table — per-user Web Push subscriptions stored by the `/push-subscriptions` routes.

**Public API:** `savePushSubscription({userId, endpoint, p256dh, auth, userAgent, surface?, oldEndpoint?})` (upsert by endpoint; re-subscribe re-owns an endpoint that moved to a different user on a shared machine and refreshes the keys), `deletePushSubscription(userId, endpoint)` (owner-scoped deleteMany).

**Cross-service deps:** `prisma` only.

**Used by:** `src/api/routes/pushSubscriptions.ts` (POST/DELETE). Readers of the table live elsewhere: `notificationRecipientService` fans deliveries out to a user's endpoints (and snapshots `surface` into the delivery `meta`), and the web_push sender prunes rows when an endpoint answers 410/404.

**Invariants:**
- Delete is scoped to the owning user — one user can never unsubscribe another's endpoint.
- **`oldEndpoint` lookup AND delete are both scoped to the caller's `userId`.** It's caller-supplied (from the service worker's `pushsubscriptionchange`), so an unscoped query would let a guessed endpoint read another user's `surface` or delete their subscription. Covered by an explicit integration test in `tests/integration/pwaAndPushSurface.test.ts`.
- Upsert re-owns on endpoint collision by design (shared-machine re-subscribe); don't "fix" it into a 409.
- `surface` defaults to `"desktop"` only on a genuine create with nothing to inherit. A rotation mints a NEW endpoint, so there is no row to inherit from — that's exactly why `oldEndpoint` exists, and why dropping it would silently demote mobile subscriptions to desktop deep links.
- The upsert must stay idempotent: `push.js`'s `reconcileSubscription` re-posts the current subscription on EVERY page load as the primary repair for rotated endpoints.

**When changing this:** the endpoint is the business key (`@unique`); anything that changes the stored key fields must stay compatible with what the web_push sender reads at delivery time. `surface` is consumed by `notificationDeliveryService` via `pushDeepLinkUrl` — adding a surface value means adding a path to `PUSH_DEEP_LINK_PATHS` in `src/utils/notificationTemplate.ts` and a route that serves it.

---

## services/notificationChannelService.ts

**What it owns:** CRUD + secret handling for the `NotificationChannel` registry (Notifications → Delivery tab) — the operator-managed list of outbound delivery integrations.

**Public API:** `listChannels`/`listChannelsForBuilder`/`getChannel`/`getChannelRaw` (secrets, for senders)/`createChannel`/`updateChannel`/`deleteChannel`/`generateWebPushKeys`/`getWebPushChannel`, `MASK`.

**Cross-service deps:** `prisma` (notification_channels), `notificationTypes.CHANNEL_TYPE_META` (per-type field defs incl. which are secret) + `CHANNEL_TRANSPORT`, `notificationChannels/webPushChannel.generateVapidKeys`.

**Used by:** `src/api/routes/notificationChannels.ts` (CRUD + test + generate), `src/api/routes/pushSubscriptions.ts` (`/key` via `getWebPushChannel`), the rule builder (channel picker via `listChannels`), `notificationDeliveryService` (reads channel config at send time via a direct prisma lookup).

**Invariants:**
- Secrets (per the type's `secret:true` field defs — SMTP password, M365 client secret, Pushbullet token, Slack/Teams webhook URL, VAPID private key) are masked on read and preserved on write when the client echoes the mask / sends blank.
- The API never returns an unmasked secret; the web_push private key is never returned at all (only `privateKeySet`).
- `type` is immutable after create; `web_push` is a singleton (create rejects a second one).
- Destination secrets live ONLY on the channel — delivery rows reference the channel by id, never copy its secrets.

**When changing this:** add a new channel type by extending `CHANNEL_TYPES` + `CHANNEL_TYPE_META` (+ `CHANNEL_TRANSPORT`) in `notificationTypes`, a sender under `notificationChannels/`, and a dispatch arm in `notificationDeliveryService`. Mark secret fields `secret:true` so masking covers them.

---

## services/vcenterService.ts

**What it owns:** VMware vCenter discovery + telemetry client — vSphere Automation REST session client (inventory: clusters, hosts, per-host VM lists, per-VM detail + VMware Tools guest identity/networking/filesystems) plus two narrow SOAP property-collector calls against `/sdk` (batched VM quickStats; datastore summary/host-mounts/backing), the NAA-prefix array-vendor map (`vendorFromNaa`), and the pure vMotion-safe dependency-edge builder.

**Public API:** testConnection, proxyQuery (REST surface only — rejects non-`/api/` paths), discoverInventory, fetchVcenterQuickStats, pickVmExternalId, hostExternalId, buildClusterHostMap, buildVcenterDependencyEdges, matchesVmWildcard, filterVms, vendorFromNaa, backingLabelFor, extractObjectBlocks / parseObjRef / parsePropValue / parseQuickStatsBlock / parseDatastoreBlock (SOAP parsers), parseVmDetail, VcenterConfig + Discovered* types.

**Cross-service deps:** dnsService.getConfiguredResolver (host FQDN → resolvedIp; REST exposes no host mgmt IP).

**Used by:** src/api/routes/integrations.ts — test connection (create-form), Query API proxy branch. src/services/discovery/discoveryEngine.ts — preflight test + discovery dispatch (`discoverInventory` → `syncVcenterDevices`). src/services/monitoringService.ts — `fetchVcenterQuickStats` behind the per-integration warm cache (`fetchVcenterQuickStatsCached`, 30s TTL + promise-singleton) that backs the "vcenter" cpuMemory polling method.

**Invariants:**
- VM externalId = `instanceUuid` (survives vMotion), fallback `${integrationId}:${moref}`; host externalId = `${integrationId}:${hostMoref}` ALWAYS (morefs repeat across vCenters). Sync + conflict resolution + telemetry cache all key on these — change them in lockstep or existing AssetSource rows orphan.
- VM lists are fetched PER HOST (`?hosts=<moref>`) — that's what pins VM→host placement AND sidesteps the 4000-item global list cap. Don't "optimize" to one global list.
- Every SOAP surface degrades to nulls independently; datastores fall back to the REST list (no mounts/backing/provisioned) when `/sdk` is unreachable. Guest calls are per-call try/caught (Tools-off returns 503).
- `buildVcenterDependencyEdges`: clustered VM → one edge per cluster-member host (all-down suppression = whole-cluster-dark → vMotion-safe); standalone → single edge; skips hosts with no asset; dedupes; never self-parents. Edges land with `source="vcenter"` / `detectedVia="hypervisor"` — never `"computed"` (the Fortinet recompute deletes that scope).
- REST session: one automatic re-auth on a mid-run 401, logout in `finally`. SOAP session likewise logged out best-effort.
- quickStats cache entries are keyed by BOTH externalId forms so the per-asset lookup matches whatever the sync stored.

**When changing this:**
- Field shapes are verify-on-real-vCenter (7.x/8.x): REST VM detail (`identity`, `nics`, `disks.backing.vmdk_file` bracket format), Tools guest endpoints, SOAP quickStats/datastore-info property paths. The SOAP parsers are regex-based over shapes we request — update tests/unit/vcenterService.test.ts fixtures with real captures.
- Adding a projected field → also add the `vcenter-vm`/`vcenter-host` rule in `src/utils/assetProjection.ts` (directly below polaris-agent) and mirror the observed-blob key in `buildVcenterVmObservedBlob` / `buildVcenterHostObservedBlob` (discoveryEngine.ts).
- Changing quickStats fields → update `collectTelemetryVcenter` (monitoringService) + the cpuPct/memBytes mapping tests.
- New datastore fields → `VcenterDatastore` model + migration + the `/assets/:id/virtualization` serializer + assets.js `_assetVirtualizationHTML`.
- New per-class monitor knobs → `VcenterConfigSchema` (`vmMonitor`/`hostMonitor`) + `monitorOverrideService` block-key maps + `pickClassStreamsBlock` + the integrations.js `vms`/`hosts` subtabs and save readers.
- VMs are typed `server` (the `virtual_machine` built-in was retired by migration 20260722000000). The auto-monitor/deploy **klass** name stays `virtual_machine` (queries pair it with `discoveredByIntegrationId`), but nothing writes that asset type anymore. `server` → block-key resolution is integration-type-dependent everywhere it happens (`monitorOverrideService.getAddAsMonitoredFromConfig` / `classBlockKeyForAssetType(assetType, integrationType)` / both raw-SQL sweeps, `monitoringService.pickClassStreamsBlock`): vcenter → `vmMonitor`, directory → `serverMonitor`. VM-class behaviors (dependencyLayer=2, vmMonitor sweep) gate on `discoveredByIntegrationId` ownership, not on the type.
- Both the VM pass and the host pass raise a `bothAssetsExist` sibling Conflict when the device has its own asset AND a hostname-twin non-vCenter asset exists (so operators merge from the Conflicts queue). If you change the collision proposedAssetFields shape, keep `conflictResolutionService.ts` `conflictSourceFor` + `rejectAssetConflict`'s `alreadyOwned` short-circuit + the events.js `bothAssetsExist` card branch in lockstep.

---

## services/activeDirectoryService.ts

**What it owns:** On-prem Active Directory device discovery via LDAP/LDAPS client (computer objects, OU filtering, SID/GUID identity, disabled-account handling).

**Public API:** testConnection, proxyQuery, discoverDevices, ActiveDirectoryConfig, DiscoveredAdDevice, AdDiscoveryResult, AdDiscoveryProgressCallback.

**Cross-service deps:** None (pure LDAP client; no service-to-service calls).

**Used by:** src/api/routes/integrations.ts — discovery trigger, test connection, manual LDAP proxy query. src/services/discovery/discoveryEngine.ts — sync path syncActiveDirectoryDevices.

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
- syncActiveDirectoryDevices in discoveryEngine.ts runs a forward-DNS pre-pass (via dnsService.getConfiguredResolver) to fill Asset.ipAddress for new + IP-less existing assets. Gate is `!existing.ipAddress` — never overwrites a non-empty IP from FortiGate/Entra/operator. ipSource stamped "activedirectory-dns".

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

**What it owns:** Operator-drawn map regions (polygons on the Device Map). CRUD on Setting JSON blob keyed `mapRegions`. Tag-mutation primitives that add `region:<name>` to in-polygon firewalls + cascaded FortiSwitches/FortiAPs + **subnet-propagated assets** (any asset whose primary IPv4 falls in a `Subnet` whose `fortigateDevice` is an enclosed firewall's hostname — gives coordinate-less servers/workstations a region) and strip it on rename/delete. Tag-registry mirroring (upserts a `Tag` row at `region:<name>` under category "Map Regions" so the asset edit modal's tag picker shows it).

**Public API:** MapRegion, SaveRegionInput, ReconcileSummary, listRegions, getRegion, createRegion, updateRegion, deleteRegion, applyRename, applyDelete, applyOneRegion, reconcileMapRegions.

**Cross-service deps:** `src/utils/geo.ts:pointInPolygon`, `src/utils/cidr.ts:cidrContains` (subnet propagation), `prisma.tag` (registry mirror), `prisma.subnet` (`fortigateDevice` → CIDR list for subnet propagation), `prisma.asset` (membership compute + tag mutations).

**Used by:**
- `src/api/routes/mapRegions.ts` — all CRUD endpoints (`GET / POST / PUT / DELETE /map/regions`); each call awaits the appropriate apply* helper before responding.
- `src/services/discovery/discoveryEngine.ts` Phase 13 — end-of-syncDhcpSubnets (`mode in {"full", "finalize"}`) calls `reconcileMapRegions()` so newly-discovered firewalls' coords land in the right regions.
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

## services/serviceInventoryService.ts

**What it owns:** The `AssetService` current-state table (one row per `(asset, unit)` systemd unit / Windows service) — the unit-centric sibling of the process inventory. Full-replace per agent scrape.

**Public API:** AssetServiceInput, isServiceControllable, persistAssetServices.

**Cross-service deps:** `prisma.assetService`, `retryOnDeadlock` (utils/dbRetry).

**Used by:**
- `src/api/routes/agents.ts` — the `serviceInventory` sample-stream arm maps `ServiceSampleSchema` rows → `persistAssetServices`. Also ships `streams.services` + `monitoredServices`/`mappedServices` on `GET /agents/config` (folded into both the payload ETag and the heartbeat `computeConfigEtag`).
- `src/api/routes/assets.ts` — `GET /assets/:id/services` reads the rows + pins (read-only; start/stop/restart control was removed in the Satellite-posture change). `monitoredServices`/`mappedServices` ride the general `PUT /assets/:id` pin path (UpdateAssetSchema).
- `agent/internal/collectors/services*.go` — the sole producer (`ServiceInventoryOnce`; systemd `systemctl list-units/list-unit-files/show`, Windows `Win32_Service`). The Linux path parses the **plain columnar** output of `list-units`/`list-unit-files` (`--plain --no-legend`), NOT `-o json`: systemctl only emits JSON for those list verbs from an interactive session — under the agent's systemd service context it silently falls back to the table format, so JSON parsing yields nothing (this caused Linux services to never populate; fixed 2026-07). The untagged pure parsers `parseListUnits` / `parseListUnitFiles` / `parseShowUnits` live in `services.go` (unit-tested). On a command error OR an empty parse `listUnits` returns nil + logs, so a parse regression skips the push rather than wiping the delete-replaced inventory.
- `public/js/assets.js` — the Services tab (`_wireAssetServicesTab`) + `openServiceDetailPanel`.

**Invariants:**
- Delete-then-insert in ONE `$transaction` under `retryOnDeadlock`; empty rows = valid delete-only scrape. Keyed `@@unique([assetId, unit])`. Plain table, NO FK to Asset (matches AssetProcess/AssetSdwanRule).
- `controllable` is DERIVED here, never trusted from the wire: systemd `loadState==="loaded"`, or any Windows service. Control routes re-check it.
- Agent-only. Agentless SSH/WinRM does not resolve units (`agentlessProcessService` hardcodes serviceUnit null) — no agentless producer exists.
- `mainProcess` is a display cross-link to the process rows (Services tab, *Include processes* view), not a key.

**When changing this:**
- Adding a field: extend the Prisma model + migration, `ServiceSample` (Go transport) + collectors, `ServiceSampleSchema` + the ingest arm (agents.ts), the `AssetServiceInput` map, and the `GET /assets/:id/services` projection — in lockstep. Bump `agent/VERSION`.
- The `serviceLog` stream (per-unit journalctl → `AssetServiceLogSample`; agent `servicelog.go` + `readJournaldUnit`, ingested in agents.ts via `enqueueServiceLogSamples`, read at `GET /assets/:id/service-logs`) and connection-unit-attribution (Phase 3) hang off the same pins (`monitoredServices`/`mappedServices`) shipped by the config endpoint. Adding a service-log field touches the Prisma model + migration, `ServiceLogSample` (Go transport) + `servicelog.go`, `ServiceLogSampleSchema` + the ingest arm, `ServiceLogRow`/`enqueueServiceLogSamples` (sampleWriteBuffer), and the `pruneSystemInfoSamples` line.

---

## services/tableTabsService.ts

**What it owns:** Per-user list-page tabs — the `UserTableTabs` table (one row per `(user, scope)`, holding the whole strip: `{version, tabs[], activeId}`). The operator's private workspace of open views on a table; the shareable artifact is a `SavedTableFilter`.

**Public API:** MAX_TABS, MAX_TAB_NAME_LEN, MAX_TAB_ID_LEN, TableTab, TableTabsLayout, EMPTY_LAYOUT, sanitizeTabs, getTabsForUser, saveTabsForUser.

**Cross-service deps:** `prisma.userTableTabs`, `savedFilterService.sanitizeFilterState` (per-tab state validation).

**Used by:**
- `src/api/routes/tableTabs.ts` — `GET|PUT /me/table-tabs?scope=…`, gated `read` on the scope's key via `middleware/scopeAccess.ts`.
- `public/js/assets-tabs.js` — the only frontend consumer, via `api.tableTabs.*`.

**Invariants:**
- Whole-blob replace per (user, scope): the client owns tab order + which tab is active. No merge, no partial update.
- Per-tab `state` MUST go through `savedFilterService.sanitizeFilterState` — a tab must never be a way to store a filter shape a preset couldn't.
- A stale `activeId` is REPAIRED to the first tab, never rejected: the operator may have closed that tab in another window, and 400-ing would throw away the whole layout over a race.
- Cascades with the user (nothing here is shared) — the opposite of `SavedTableFilter.ownerId`'s SetNull, and deliberately so.
- `savedFilterId` on a tab is a REFERENCE, not a foreign key: it may dangle (preset deleted, or it was someone else's private one) and is never resolved server-side, because it only labels the tab.
- Read-level gate on both verbs. Tabs are a view of data the caller can already see, so a readonly operator gets them.

**When changing this:**
- Adding a per-tab field: extend `TableTab` + `sanitizeTabs` + the route's Zod envelope + the client's serialize/restore in `assets-tabs.js` — all four, or the field silently vanishes on the next save.
- Adding tabs to another list page: the scope must already exist in `SAVED_FILTER_SCOPES` (see [services/savedFilterService.ts](#servicessavedfilterservicets)); the strip itself is page-level code.
- Tests: `tests/unit/tableTabsService.test.ts` (envelope validation), `tests/integration/tableTabs.test.ts` (per-user isolation + readonly access + cascade), `tests/unit/assetsTabsDom.test.ts` (the strip).

---

## services/savedFilterService.ts

**What it owns:** Saved table-filter presets — the `SavedTableFilter` table (one row per named preset: `scope` + `name` + owner + `visibility` + the `state` blob). The server-side half of "save the filters I use on this table"; unlike the per-browser `polaris-prefs-assets-<user>` localStorage blob (which holds the LIVE filter state), a preset is named, durable, and optionally shared with everyone.

**Public API:** SAVED_FILTER_SCOPES, MAX_NAME_LEN, MAX_FILTER_KEYS, MAX_FILTER_VALUES, MAX_VALUE_LEN, MAX_PRESETS_PER_USER, SavedFilterVisibility, SavedFilterState, SavedFilterDto, isValidScope, functionKeyForScope, normalizeName, sanitizeFilterState, listSavedFilters, createSavedFilter, updateSavedFilter, deleteSavedFilter, getSavedFilter.

**Cross-service deps:** `prisma.savedTableFilter`, `eventLogService.logEvent`.

**Used by:**
- `src/api/routes/savedFilters.ts` — the whole `/api/v1/saved-filters` surface. The route resolves the gate PER REQUEST (`functionKeyForScope(scope)` + `ensureRoleSnapshot` + `hasPermission`) because the key depends on the payload, then enforces ownership on PUT/DELETE.
- `src/api/routes/users.ts` — `DELETE /users/:id` deletes the doomed user's PRIVATE presets before the user row (their public ones survive with `ownerId` NULL).
- `public/js/assets-filters.js` — the only frontend consumer today (Assets header → Filters ▾), via `api.savedFilters.*` in `public/js/api.js`.
- `public/js/table-sf.js` — `TableSF.prototype.getPrefs` produces the stored `state`; `applyState` consumes it (wholesale replace, unlike `setPrefs`'s merge).

**Invariants:**
- **The stored `state` is untrusted input replayed into other operators' browsers.** Every write goes through `sanitizeFilterState`, which accepts only the shapes `table-sf.js` emits and bounds size (60 columns × 200 values × 300 chars). Widening what the table can filter by means widening this in lockstep, or presets silently 400.
- `scope` must be in `SAVED_FILTER_SCOPES`; each maps to an EXISTING function key. This is the whole authorization model — there is no `savedFilters` RBAC key, so a new scope inherits its page's gate for free.
- Level split: read = list + own/private writes; `write` = publish or keep public; `fullwrite` = delete someone else's. A readonly operator can keep private presets — that's the point of storing them server-side.
- Session callers only (`sessionUser` 401s bearer tokens): a preset has an owner, and a token has no user identity.
- Same `(scope, owner, name)` POST **updates** — the UI's overwrite flow depends on that, and the DB unique index makes a duplicate impossible anyway.
- `ownerId` is `SET NULL`, never cascade: deleting a user must not yank shared presets out of everyone else's menu. `ownerName` is a display snapshot for exactly that case.
- Presets store the query only. Column widths / hidden columns stay in `applyTableLayout`'s localStorage — don't fold them in without deciding what a shared preset should do to another operator's screen layout.

**When changing this:**
- Adding saved filters to another list page: add the scope→key pair in `SAVED_FILTER_SCOPES`, then wire that page's module the way `assets-filters.js` does (`getPrefs` to save, `applyState` + the page's re-fetch entry point to load). No migration, no new function key.
- Changing the `state` shape means changing `sanitizeFilterState`, `TableSF.getPrefs`/`applyState`, and `_sflDescribeState` in `assets-filters.js` together — the last one is what the operator reads before saving, so a shape it can't describe reads as a blank preview.
- Tests: `tests/unit/savedFilterService.test.ts` (validators), `tests/integration/savedFilters.test.ts` (RBAC + visibility + ownership + the user-deletion carve-out), `tests/unit/assetsFiltersDom.test.ts` (the menu + save modal).

---

## services/topologyLayoutService.ts

**What it owns:** Shared Device Map topology layouts — the `TopologyLayout` table (one row per `(siteId, view)`, siteId = the FortiGate Asset the graph is rooted on, `positions` = `{nodeId: {x,y}}` pixel model coords). The server-side half of topology drag persistence; the browser's localStorage layout remains a per-browser fallback.

**Public API:** TopologyNodePosition, TopologyPositions, TopologyLayoutDto, MAX_LAYOUT_NODES, MAX_VIEW_KEY_LEN, MAX_NODE_ID_LEN, MAX_COORD, isValidViewKey, sanitizePositions, getLayoutsForSite, saveLayout, deleteLayout.

**Cross-service deps:** `prisma.topologyLayout`, `prisma.asset` (firewall existence check on save).

**Used by:**
- `src/api/routes/map.ts` — `GET /map/sites/:id/topology` embeds `getLayoutsForSite` as `savedLayouts` (via `topologyGraphService.buildSiteTopology`); `PUT|DELETE /map/sites/:id/topology/layout` (both `deviceMap=write`) call `saveLayout` / `deleteLayout` and write `map.topology.layout_saved` / `map.topology.layout_reset` Events.
- `public/js/map.js` — `loadNodePositions` prefers `savedLayouts[view]` over localStorage; `saveNodePositions` → `_queueServerLayoutSave` (debounced ~1s, writer-gated via `permAtLeast("deviceMap","write")`, dirty-flagged so open/close/refresh alone never PUTs); `resetTopologyLayout` deletes the active view's row; `_snapAllPositions` (Snap chip enable) re-snaps and re-queues other views' blobs.

**Invariants:**
- Full-replace per (site, view); last-write-wins between concurrent editors (`updatedBy`/`updatedAt` stored for a future conditional write).
- `view` is `"flat"` or a `computeFloorViews` key (`b|<area>|<bldg>` / `f|<area>|<bldg>|<floor>`) — the grammar is shared with `public/js/topology-render.js:computeFloorViews`; changing the slug derivation there orphans saved layout rows (harmless: they cascade with the site, but operators lose that view's hand layout).
- Saves 404 unless the site Asset exists AND `assetType === "firewall"`; rows cascade-delete with the Asset (plain table — the no-FK rule only covers Timescale hypertables).
- Stale nodeIds inside a blob are never pruned server-side — ignored at render, dropped on the client's next full-replace save (mirrors the old localStorage semantics).
- Reads are NOT permission-gated beyond auth (they ride the open topology GET) — readonly viewers see the shared layout; only writes need `deviceMap=write`.
- Mobile (`public/js/mobile/topology-tab.js`) deliberately ignores `savedLayouts` — desktop coords are LR-oriented, mobile renders transposed.

**When changing this:**
- New view-key shapes (beyond b|/f|) need `isValidViewKey`, the route Zod, AND map.js `_activeViewKey` updated together.
- If node ids in the topology payload ever stop being Asset UUIDs (or synthetics become persistable), revisit `MAX_NODE_ID_LEN` and the stale-entry story.
- Keep the localStorage key scheme (`polaris.topology.positions:<siteId>[:<view>]`, bare key = flat) in sync — it's the seed/fallback the server store was modeled on.

---

## services/appMapDiscoveryService.ts

**What it owns:** The service & process **DISCOVERY RULES** (formerly the Application Map's "Discovery" surface; the list now renders inline on **Integrations → Polaris Agent**) — named rules in `Setting("appMapAutoMap")` (`{version:2, rules:[…]}`), the scope-driven process/service aggregate behind the wizard's item step, the additive apply that pins them, and the AUTO-RULE machinery that mirrors per-asset Services-tab pin toggles into consolidatable rules. Structurally a sibling of `autoMonitorStorageService` (aggregate → preview → additive apply → re-apply later), with the periodic-reconciler entry point of `tagAssignmentService`.

**Public API:** normalizeRule, normalizeConfig, getConfig, saveConfig, emptyConfig, isRuleEmpty, resolveBlockPins (PURE — the unit-tested core), applyPinChangesToConfig (PURE — the unit-tested auto-rule mint/consolidate/trim/prune), recordOperatorPinChanges (the assets-PUT hook, serialized + never-throws), resolveRuleAssetLabels, getInventoryAggregate, previewScope(scope, assetIds), previewRule, applyRules, unmapEverywhere, reconcileAutoMap, SETTING_KEY, plus the AppMapRule / AppMapRuleMode / AppMapRuleSource / AppMapAutoMapConfig / AutoMap* / AggregateRow / OperatorPinChange / PinChangeOutcome types.

**Cross-service deps:** `prisma.setting` / `prisma.asset` / `prisma.assetProcess` / `prisma.assetService` / `prisma.assetProcessConnection`; `autoMonitorInterfacesService.compilePattern` (wildcard-vs-regex compilation, shared not duplicated); `tagAssignmentService.normalizeCriteria` + `resolveMatchingAssetIds` (each rule's scope reuses that vocabulary rather than inventing a second one).

**Used by:**
- `src/api/routes/applicationMap.ts` — `GET /discovery` (+ `assetLabels` for auto-rule Devices cells) + `POST /discovery/{scope-preview,inventory,preview}` (applicationMap=read), `PUT /discovery` + `POST /discovery/unmap` (applicationMap=write **AND** assets=write, chained).
- `src/api/routes/assets.ts` — the `PUT /assets/:id` pin-diff hook: flips of the four pin arrays become `recordOperatorPinChanges` calls (fire-and-forget after the asset write; audited `application_map.autorule.synced`).
- `src/jobs/reconcileAppMapAutoMap.ts` — 30-min tick calling `reconcileAutoMap()`.
- `public/js/appmap-discovery.js` (the inline rules card on integrations.html, `window.PolarisDiscoveryRules.init`) + `public/js/appmap-rules-wizard.js` (the builder modal). Both load on integrations.html, NOT appmap.html anymore.

**Invariants:**
- **MANY rules, not one selection.** A single fleet-wide selection could only express "every asset reporting this program", which over-pins. Each rule has its own scope; when several match one asset their pins UNION, which is why `computePending` can't just loop rules independently.
- **Rules carry a MODE.** `mode:"map"` pins the map surfaces AND the monitor surfaces; `mode:"monitor"` pins ONLY `monitoredProcesses`/`monitoredServices` and never touches a map pin. `computePending` keeps two want-sets per surface: map wants from map-mode rules only, monitor wants from every rule. Pre-mode rules normalize to `"map"` (that's what they were).
- **Rules carry a SOURCE, and only `"auto"` rules are machine-managed.** Auto rules are minted by `recordOperatorPinChanges` (one per (item, kind, mode), single-item, `scope:null` + explicit `assetIds`); pinning the same item on another asset CONSOLIDATES into the existing auto rule's assetIds; un-ticking a checkbox removes the asset from matching auto rules. MANUAL rules are never consolidated into or trimmed — un-ticking a box on a host inside a manual rule's scope keeps today's behavior (the reconcile re-pins it, because the rule says so). The wizard flips an auto rule to manual on save, so a hand-shaped rule stops absorbing pins.
- **`assetIds` union with scope; null scope + assetIds ≠ all assets.** `ruleTargetIds` = union(scope matches, explicit assetIds), and a null scope contributes NOTHING once assetIds is non-empty (MaintenanceSchedule targets precedent). Consequence: an auto rule that loses its LAST assetId is DELETED (in the hook and in unmapEverywhere's prune) — it must never survive as `{scope:null, assetIds:[]}`, which would read as "every monitored asset".
- **The pin hook never fails the operator's save.** `recordOperatorPinChanges` runs after the asset row is written, catches everything, and serializes through an in-process promise chain (`pinChangeChain`) because the Setting read-modify-write isn't atomic — browser PUTs all land on the web role, so an in-process lock suffices. At the rule cap (200) or per-rule assetIds cap (1000) it SKIPS bookkeeping; the direct pin on the asset still stands.
- **Mapping implies monitoring, one-way.** Everything a rule maps is also pinned into `monitoredProcesses` / `monitoredServices` — caring enough to put a service on the map means wanting its telemetry. The reverse is NOT true: monitoring something is not a request to publish its connections, so nothing here writes a map pin from a monitor pin. The monitor diff is computed against the FULL want-set, not just the newly-mapped items, so an item mapped before this existed (or monitor-unpinned by hand) catches up on the next reconcile. Consequence worth stating: mapping a unit starts journalctl tailing on it, so this raises log volume — both the wizard and the rules list say so rather than leaving it a hidden side effect. This also means a per-asset MAP checkbox now grows a monitor pin within moments (the hook's inline `applyRules` on the minted auto rule).
- **Apply is STRICTLY ADDITIVE and never strips.** `Asset.mappedProcesses` / `mappedServices` are operator-owned — someone may have pinned a name by hand on one host — so removing an item from a rule, or disabling/deleting the rule, stops FUTURE auto-pinning rather than retroactively unpinning. `unmapEverywhere` is the separate strip, and it also removes the name from every MAP-mode rule (monitor-only rules keep their names — the strip takes things off the map, it doesn't stop monitoring) and prunes auto rules the removal emptied (otherwise the next reconcile puts it straight back).
- **The pre-rules shape folds forward at read time.** `normalizeConfig` turns a legacy `{version:1, processes, services, scope}` blob into one "Imported selection" rule, so an install that configured the old flat modal doesn't silently lose its pins. No migration job — same trick as the flat retention default. An EMPTY legacy selection folds to zero rules, not an inert one.
- **Aggregates must stay bounded and scope-narrowed.** `getInventoryAggregate(scope)` runs GROUP BYs over `asset_processes` / `asset_services` joined to `assets` on `monitored=true`, restricted to the scope's asset ids (LIMIT 2000), plus `unnest` GROUP BYs for the pinned count. Never read per-asset rows to count them in memory — that's ~400k `AssetProcess` rows at 2000 hosts, on a wizard step. The item picker CANNOT filter client-side: aggregate rows carry no asset ids.
- **Apply resolves each scope once and loads inventory once.** `computePending` resolves every rule's scope, unions the touched asset ids, loads the inventory for that union in one pass, then evaluates all rules in memory — otherwise a 10-rule config would re-query the asset + inventory tables 10 times.
- **Rule names and ids are unique.** Names are how operators refer to these in conversation and Events (409 on a case-insensitive collision); a duplicate id would make an edit fan out across rules.
- **Names dedup case-INSENSITIVELY but keep the first spelling.** Pins are matched against inventory case-sensitively, so folding case would silently stop matching the real program name.
- **Patterns compile at save time.** `normalizeRule` runs `compilePattern` on every pattern so a bad regex is a 400 the operator sees, not a silent no-match on every reconcile tick forever.
- **An unusable scope tree means NO scope, not match-nothing.** `normalizeCriteria` returns null when there are no usable rules; treating that as "match nothing" would quietly disable a working rule. The WIZARD compensates: unchecked "All assets" with an empty builder is a validation error, never a silent widening.
- **Candidates are `monitored: true` AND `PROCESS_CAPABLE_ASSET_TYPES`.** The first matches `buildApplicationMapGraph`'s own filter (pinning a host the map won't render is wasted work); the second is because inventory only comes from the agent / agentless SSH+WinRM, so an appliance reports nothing to pin and counting them made the wizard's device count promise work that could never happen. Applied to the inventory aggregate, `previewScope` AND apply so all three agree — but NOT to `pinnedCounts`, which stays fleet-wide so a hand-applied pin on any asset still shows and Unmap-everywhere means everywhere. That constant is the single switch to widen when process collection reaches network hardware; the server publishes it on `GET /discovery` so the client's asset-type picker can't drift from it.
- **Aggregates use `COUNT(*)`, not `COUNT(DISTINCT "assetId")`.** `asset_processes` is unique on `(assetId, name)` and `asset_services` on `(assetId, unit)`, so a group holds at most one row per asset and the two are equivalent — but DISTINCT cost a sort/hash per group over the whole table, which was most of the wizard's item-step latency. Do NOT add an index on `name`/`unit` to speed the GROUP BY: both tables are delete-replaced per asset per scrape, so it would tax every one of those writes fleet-wide for one wizard step.

**When changing this:**
- Adding a rule field → update `normalizeRule` (validation + cap), the preview/apply pending computation, AND the wizard's collect/round-trip so it can't be dropped on save. The wizard only surfaces `names`, `mode`, and (as a count + "Remove them" affordance) `assetIds`; `patterns` is round-tripped untouched. Also check `applyPinChangesToConfig`'s single-item-auto-rule matcher if the field affects rule identity.
- The whole rule set is PUT on every write (the list resends everything, including for an enable-toggle) because cross-rule uniqueness can't be validated per-rule. Don't add a per-rule PATCH without moving that validation — and note the per-asset pin hook writes the config OUTSIDE the PUT (via saveConfig directly), serialized by `pinChangeChain`.
- The reconcile cadence is deliberately 30 min and deliberately NOT hooked into `persistAssetProcesses`/`persistAssetServices` — those run per asset every few minutes. Don't "improve" the latency by hooking them without a fleet-scale plan.
- If apply ever needs to strip, it needs a provenance table first (see `TagAutoAssignment` in tagAssignmentService) — otherwise it will delete hand-applied pins.

---

## services/applicationMapService.ts

**What it owns:** The Application Map — the connectivity graph built from `AssetProcessConnection` rows (accumulate+age socket facts for mapped processes AND mapped service units), the per-asset Ports & Connections DTO, and the shared `ApplicationMapLayout` drag layout (the appmap counterpart of TopologyLayout, one global `view="global"` row, no per-site FK). Two independent child dimensions per asset: `Asset.mappedProcesses` (by program name → `process` child node) and `Asset.mappedServices` (by owning `unit` → `service` child node). A connection row is attributed to a process child when its `processName` is mapped, to a service child when its `unit` is mapped, or to both. Process and service children both render even with zero connections (they come from the mapped list, not the rows).

**Public API:** buildApplicationMapGraph, buildGraphFromRows (PURE — the unit-tested core), resolveIpsToAssets, resolveIpsViaHistory + pickHistoryHolder (time-scoped AssetIpHistory fallback; the picker is pure), resolveIpsToNameHints, resolvePtrNames + isPublicIp + clearPtrCacheForTests (reverse-DNS labels for public unknowns), getAssetProcessConnections, getAppMapLayout, saveAppMapLayout, deleteAppMapLayout, assetNodeId, processNodeId, serviceNodeId, isNoiseIp, subnetKeyOf, plus the AppMap* type family.

**Cross-service deps:** `prisma.asset` / `prisma.assetAssociatedIp` / `prisma.assetIpHistory` / `prisma.reservation` / `prisma.assetProcessConnection` / `prisma.applicationMapLayout`; `node:dns/promises.reverse` (PTR lookups, injectable); `utils/cidr.isPrivateIpv4` (public-IP gate); `deviceIconService.loadIconResolutionCache/resolveIconUrl` (asset-node icons); `topologyLayoutService.sanitizePositions` (layout validation).

**Used by:**
- `src/api/routes/applicationMap.ts` — `GET /application-map` (applicationMap=read) + `PUT|DELETE /application-map/layout` (applicationMap=write, audited `application_map.layout.saved/reset`).
- `src/api/routes/assets.ts` — `GET /assets/:id/process-connections` (assets=read) → `getAssetProcessConnections`.
- `public/js/appmap.js` — the page; `public/js/assets.js` — the process detail panel's Ports & Connections section.

**Invariants:**
- Node ids are DETERMINISTIC (`asset:<id>`, `proc:<assetId>:<b64url(name)>`, `svc:<assetId>:<b64url(unit)>`, `ip:<ip>`, `ipgroup:<cidr>`) — ApplicationMapLayout blobs and the client's localStorage fallback key on them; changing the id scheme orphans every saved layout.
- **Only monitored hosts are compound parents.** `buildApplicationMapGraph` filters the asset query to `monitored: true` — a stop-monitored / decommissioned / disabled asset (all `monitored=false`) drops off the map WITHOUT clearing its map pins, and reappears if monitoring is re-enabled. Resolved-target assets (edge endpoints) are added separately via `resolveIpsToAssets` regardless, so they show only while live traffic references them.
- **IP → asset resolution is current-truth first, history second, never decommissioned.** `resolveIpsToAssets` consults Asset.ipAddress then AssetAssociatedIp; leftovers go through `resolveIpsViaHistory` — a TIME-SCOPED AssetIpHistory fallback (per IP, `pickHistoryHolder` picks the row whose seen-interval best covers the newest connection observation of that IP; covering rows beat near-misses, latest taker wins among coverers) so an IP two assets held at different times attributes to the plausible holder instead of a rotated-off former one (the reason bare history matching used to be excluded outright). Every resolution query carries `RESOLVABLE_ASSET_WHERE` (`status != "decommissioned"`) — retired hardware holding a since-reused IP must never soak up live traffic (the compound-parent query already drops it via `monitored=false`; this closes the edge-TARGET path). Anything STILL unresolved falls back to name hints: `resolveIpsToNameHints` (an ACTIVE `Reservation`'s hostname) first, then `resolvePtrNames` for PUBLIC IPs only (reverse DNS, in-process cache 6h positive / 30m negative, ≤25 uncached lookups per build each bounded to 1.5s — a dead resolver must not stall the graph; `isPublicIp` excludes RFC1918/CGN/ULA/noise). Both hints are **label-only**: they set `ipHostname`/`ipNameSource` (`"reservation"` | `"dns"`) on the grey node so the endpoint reads as what it is, but the node stays `unknown-ip` because no asset record exists to open, and the info rail states the name's source so a named grey node doesn't read as a discovery bug.
- Edge dedup: outbound observations win over inbound observations of the same logical connection (`src|dstNode|proto|port` key); one rendered edge per (source, target) with a ≤16-port breakdown. Each port carries `ips` (≤6 distinct observed addresses — outbound: the dialed remote IP; inbound: the local address it landed on, wildcard binds skipped): the edge rail renders them as a "Via IP" column and same-asset sibling edges put `via <ip>` on the edge label — the disambiguator for multi-IP hosts and intra-asset service→service traffic. Loopback never appears there because the AGENT drops loopback peers at collection (processconnections.go) — a drawn edge is real-IP-stack by definition.
- **Intra-asset sibling edges get layout room.** `appmap.js:computeLayout` detects child↔child edges within one parent: that parent stacks its children on the wider `INTRA_EDGE_ROW_GAP` (140px vs the default 58) so the vertical edge + its two-line label are readable, and orders connected siblings adjacent (DFS over the sibling adjacency) so the edge doesn't lance through unrelated children. Operator-saved layouts still win over the computed one — Reset layout picks up the new spacing.
- Graph reads are bounded by the **flat `appMapConnections` retention window** (`getAppMapConnectionRetentionDays`), and the window is reported to the client as `retentionDays` so it builds its "Seen within" options from it. This used to be a hardcoded 7-day `GRAPH_WINDOW_MS` against a 30-day retention, so "All retained" was a lie and ~3 weeks of kept rows were unreachable. There is now ONE number driving prune, read, and UI range — keep it that way rather than reintroducing a second constant.
- `buildGraphFromRows` stays pure (no prisma) — that's what makes the resolution/dedup/grouping rules testable.
- **No dangling references reach cytoscape.** `appmap.js:filterGraph` drops any child node (process or service, via `isChildNode`) whose parent asset isn't in the node set and any edge whose source/target has no node, and `computeLayout` skips collapsed edges to phantom nodes. A dangling ref makes cytoscape-dagre throw `Cannot set properties of null (setting 'hidden')` and fails the WHOLE render — which can happen when connection rows outlive the process/asset that owned them (e.g. a mapped process that stopped running). Keep both guards.
- **Stale pins are recoverable.** A program pinned for Monitor/Map that no longer appears in the live inventory would otherwise have no Services-tab row (hence no checkbox) to un-pin it, and would linger on the map until its connection rows age out (the flat `appMapConnections` retention window, default 30 days). The Services tab's *Include processes* view surfaces such names as muted "not running" rows with their pin checkboxes so the operator can clear them (unmap → connection rows deleted immediately). **Agent removal** (uninstall / force-remove) also clears `mappedProcesses`/`mappedServices` + deletes the asset's connection rows, so a host drops off the map when its agent goes away (see agentInstallService). Pins orphaned by a removal that predates this cleanup still age out or can be cleared via the Services tab.
- **Filtering is a PILL box with OR-within-kind / AND-across-kind semantics.** `appmap.js` holds `filterPills` (`{kind, value}`, kind ∈ proto|port|asset|type|process|service|external|text — `type` is the asset's device type, expanded to its children like a host pill and deliberately kept OUT of free-text matching so a bare "server" can't match most of the fleet) and the pure `applyGraphFilter` — exposed on `window.PolarisAppMap` and unit-tested in `tests/unit/appmapFilter.test.ts` — implements it: proto/port pills filter an edge's port list, each node-scope kind becomes a Set of matching node ids (asset pills EXPANDED to that asset's children, since its traffic flows through them), and an edge survives only if EVERY group has a matching endpoint. A node is visible if a surviving edge references it OR it satisfies every group itself (counting parent and children as proxies) — that second clause is what keeps a pinned-but-edgeless process/service on screen when it's exactly what was filtered to. The suggestion catalog is rebuilt from the FULL payload every render, otherwise adding one pill would hide the suggestions needed to add the next. The old single-node `searchFocusId` + `<datalist>` are gone; `#focus=asset:<id>` deep links now ADD an asset pill so the narrowing is visible and clearable like any other filter. Applied pills live in a row BELOW the input, not inside it — `.appmap-filter` stays a single-row box so a long filter set can't squeeze the typing area, which also means the click-to-focus target check must NOT include the pills (they're outside that box now). **Saved filters** are named pill sets in their own per-user key (`polaris-prefs-appmap-filters-<username>`, separate from the last-state toolbar blob — deliberate named recalls vs. last-state): they store pills ONLY (the range and hide-external are separate controls, and silently moving the time window on recall would surprise), a same-name save overwrites instead of accumulating near-duplicates, and applying one REPLACES the current pills rather than merging (merging would quietly AND it with whatever was there). **Hide workstations** (`#appmap-hide-workstations`, default off, persisted in the toolbar prefs blob) is the inverse of a `type` pill — it EXCLUDES workstation asset boxes, their children, and every edge touching them, and composes with pills/hide-external. Staleness is a RENDER option, not a filter — the `#appmap-fade-stale` toggle (default on) only decides whether the `stale` data flag is stamped, so an unfaded edge is still the same edge. The **screenshot** composites two sources on purpose: `cy.png()` for the cytoscape canvas (DOM-serializing a canvas via html-to-image is unreliable) plus `htmlToImage.toCanvas` for the info rail, drawn side by side so the listening-port list lands in the image; a rail that won't serialize degrades to a graph-only shot rather than failing. `consolidatePorts` is pure + unit-tested: runs of ≥3 consecutive ports in one protocol collapse to a range, pairs stay listed, protocols never merge.
- **Asset click-through is EXPLICIT and depends on assets.js being loaded.** Tapping any node — asset boxes included — only fills the info rail; the asset-details slide-in opens from ONE place, the rail's "Open asset details" button, which calls `openViewModal` from `public/js/assets.js`. Tapping a box used to pop the slide-in too, which meant ordinary navigation (select a box to read its services and ports) threw a panel over the graph you were reading — which is why `appmap.html` loads assets.js + its UI deps (table-sf / favorites / integrations), same stack as map.html. Dropping those script tags silently degrades the map to rail-only. Child process/service + external nodes are deliberately rail-only (the rail carries their per-node connection table).
- **Hover opacity is a class, not a selector.** Cytoscape has no `:hover`, so `mouseover`/`mouseout` toggle `.appmap-hover` (opacity 1 + raised z-index) so a stale edge's port label is readable; the rule must stay LAST in `appmapStylesheet` to beat `edge[stale = 1]` (0.35) and `edge:selected`.

**When changing this:**
- New node kinds / id shapes → update appmap.js (labels, stylesheet, layout passes) + the saved-layout story in the same change.
- If collection ever adds more `kind` values to AssetProcessConnection, the graph core's listen-index + direction assumptions need revisiting.
- Unknown-IP caps (group >5/subnet, 100 nodes) are load-bearing for busy fleets — don't remove without a pagination story.

---

## services/agentlessProcessService.ts

**What it owns:** Agentless (SSH/WinRM) collection for the `processes` stream — full inventory, pinned-process CPU/RAM telemetry, and mapped-process connection discovery. The transport commands, the pure parsers, and the server-side mirror of the agent's connection direction heuristic (`buildConnectionRows`).

**Public API:** collectProcessesSsh, collectProcessesWinrm, AgentlessProcessResult/AgentlessProcessOpts, parseLinuxPs, parseLinuxSs, buildLinuxSsCommand, parseWindowsProcessJson, parseWindowsConnectionsJson, buildWindowsConnectionsScript, aggregatePsRows, telemetryFromPsRows, buildConnectionRows, isShellSafeProcessName, LINUX_PS_COMMAND, WINDOWS_PS_PROCESS_SCRIPT.

**Cross-service deps:** `utils/remoteExec.ts` (withSshClient/sshExec/winrmRunPowershell); `import type` ONLY from monitoringService (AssetProcessInput/ProcessConnectionInput — erased at runtime, so the monitoringService→agentlessProcessService import can't cycle).

**Used by:**
- `src/services/monitoringService.ts` — `runProcessesFor` (the "processes" monitor cadence) is the only caller; it resolves the credential chain (per-stream → asset default → class override → AD bind) and persists the results (persistAssetProcesses / enqueueProcessSamples / persistProcessConnections).

**Invariants:**
- Collection is scoped to the requested names ON-HOST (ss grep patterns / PS `$m -contains` filter) — never full-host collect-then-filter over the wire; that's the feature's whole point.
- Mapped/pinned names are sanitized (`isShellSafeProcessName`) before embedding in ANY remote command line; names that fail the charset are silently skipped, never interpolated.
- Linux `comm` is kernel-truncated to 15 chars — same as gopsutil `Name()` — so pin names stay consistent across agent/ssh transports. Windows names use Get-Process ProcessName (no ".exe").
- `ss` grep exit code 1 = valid empty scrape, not an error. `ss -p` socket→process attribution effectively requires root/sudo — rows without an owner token drop on-host.
- WinRM scripts must stay compact (≲2.5KB source): WinRS routes through cmd.exe (8191-char ceiling) and -EncodedCommand inflates ~2.7×.
- Linux `pcpu` is lifetime-average CPU (not the agent's 300ms instantaneous window) — documented fidelity tradeoff; don't "fix" it with a two-sample sleep over SSH without weighing the session cost.

**When changing this:**
- Keep `buildConnectionRows` semantics in lockstep with the agent's `buildConnectionSamples` (agent/internal/collectors/processconnections.go) — both implement the same listen/inbound/outbound heuristic + ephemeral-port drop.
- New parsed fields need fixtures in tests/unit/agentlessProcessService.test.ts (the parsers are the contract).
- Verify command shapes on real hosts before relying on them: `etimes` (BusyBox ps lacks it), Win32_PerfFormattedData availability, Get-NetTCPConnection on the oldest supported Server.

---

## services/tagAssignmentService.ts

**What it owns:** Criteria-based tag auto-assignment ("managed sync"). The `Tag.criteria` JSON contract (validation/normalization), the asset-matching engine (DB prefilter + inet subnet membership + in-memory predicate), and the diff-based reconcile that keeps each criteria-bearing tag synced onto matching assets via the `TagAutoAssignment` provenance table. Strictly an asset-tagging service — it never writes block/subnet tags.

**Public API:** `TagCriteria` / `CriteriaRule` types, `normalizeCriteria`, `buildPrefilterWhere`, `assetMatchesCriteria` (pure predicate, test-only convenience), `resolveMatchingAssetIds`, `reconcileTag`, `reconcileAllTags`, `reconcileTagsForAsset`, `previewTagCriteria`, `stripTagAssignments`.

**Cross-service deps:** `compileWildcard` from `autoMonitorInterfacesService.ts` (pattern compile); `isValidCidr` / `isValidIpAddress` from `utils/cidr.ts`; `isKnownAssetType` / `normalizeAssetTypeName` from `utils/assetTypes.ts`; `prisma.asset` (tags[] read-modify-write), `prisma.tag` (criteria read), `prisma.tagAutoAssignment` (provenance), one raw inet `>>=` query for subnet membership.

**Used by:**
- `src/api/routes/serverSettings.ts` Tag routes — `normalizeCriteria` (validate on POST/PUT), `reconcileTag` (inline after create/edit), `stripTagAssignments` (on delete of a criteria tag), `previewTagCriteria` (`POST /server-settings/tags/preview-criteria`).
- `src/services/discovery/discoveryEngine.ts` Phase 13.65 — `reconcileAllTags()` at end of FMG/FortiGate discovery.
- `src/api/routes/assets.ts` POST/PUT — `reconcileTagsForAsset(id)` (best-effort) on create + on update when a criteria-relevant field changed.
- `src/jobs/reconcileTagAssignments.ts` — 6h safety-net tick calls `reconcileAllTags()`.

**Invariants:**
- **The prefilter is a strict SUPERSET of the predicate.** `buildPrefilterWhere` may only ever loosen: exact→insensitive-equals, contains→insensitive-contains, pattern→`startsWith(literalPrefix)` ONLY when every value in the rule has a prefix (else the rule contributes no DB clause); subnet rules are always predicate-only. Never tighten — a candidate dropped by the prefilter is silently never matched.
- **Managed sync touches only engine-owned copies.** A tag is removed from an asset only when a `TagAutoAssignment` row exists for that (tag, asset). A hand-applied copy of the same tag name on a non-matching asset (no provenance) is preserved forever. This is the manual-vs-auto collision defense — keep the provenance check on every remove path.
- Decommissioned assets are excluded from the prefilter unless the criteria explicitly target `status`.
- Subnet membership goes through the family-aware inet query (`cidrContainmentMap`), NOT the v4-only `Netmask`/`ipInCidr` path — IPv6 CIDRs must work.
- `criteria == null` (manual tag) makes the tag invisible to the engine — it is never added or removed.
- Reconcile writes are idempotent + batched (chunks of 50 in `$transaction`); skip when the tags array doesn't change. Scale-checked: fleet passes are bounded to (#managed tags) prefilter queries; per-asset path is O(#managed tags) + one inet round-trip.

**When changing this:**
- Adding a new criteria field: extend `STRING_FIELDS`/`ENUM_FIELDS` (+ domain validation), add the column to `CANDIDATE_SELECT`, ensure `buildPrefilterWhere` stays a superset, and add it to the asset-write hook's `TAG_CRITERIA_FIELDS` list in `assets.ts` + the frontend `TAG_CRITERIA_FIELDS` in `server-settings.js`.
- Relation-backed fields (`RELATION_FIELDS` = `integration`, `fortigate` — added for the maintenance asset filter) match discovery provenance, not Asset columns: `integration` (exact-only Integration ids) = `discoveredByIntegrationId` OR any `AssetSource.integrationId`; `fortigate` (string ops) = `learnedLocation` OR any `AssetFortigateSighting.fortigateDevice`. Their relations are loaded only when referenced (`buildCandidateSelect`); their prefilter must OR across BOTH surfaces (narrowing on one would drop predicate matches from the other). They're deliberately NOT in the assets.ts write-hook field list — operator PUTs can't change provenance; the periodic reconcile covers discovery-side drift. The maintenance builder surfaces them; the Tags UI doesn't yet.
- The `Tag.criteria` JSON shape is also parsed in `public/js/server-settings.js` (`_collectTagCriteria` / `_tagRuleRowHTML`) — keep the two in sync.
- Criteria tags are normal registry tags and are deliberately NOT prefix-hidden in the manual tag picker (unlike `region:`). Don't add them to the `getTagFieldValue` protected-prefix list in `app.js`.
- See cross-cutting **Asset.tags** for the full writer list (this service is now one of them).

---

## services/agentInstallScripts.ts

**What it owns:** The curated catalog of Polaris Agent install-method VARIANTS (metadata only — id / osPlatform / label / description / isDefault) plus the OS-lock validator. One vetted variant per OS today (`linux-systemd`, `darwin-launchd`, `windows-service`). Script BODIES stay inline in `agentInstallService.ts` (version-coupled to the binary); this module owns the picker vocabulary + validation.

**Public API:** `AGENT_INSTALL_SCRIPTS`, `scriptsForOs`, `defaultScriptIdFor`, `installScriptMetaById`, `resolveInstallScriptId`, `AgentInstallScriptMeta`, `AgentOsPlatform`

**Cross-service deps:** `AppError` only (pure metadata + validation; no DB/IO).

**Used by:** `src/services/agentInstallService.ts` (`installerScript`/`uninstallerScript` switch on the resolved id; `runInstall`/`bulkInstallAgents` validate via `resolveInstallScriptId`), `src/api/routes/assets.ts` (per-asset + bulk install validation; `GET /assets/agent-install-scripts` serves the catalog), `public/js/assets.js` (deploy-modal picker).

**Invariants:**
- **OS-lock is here, server-side:** `resolveInstallScriptId(os, scriptId)` throws when a variant's `osPlatform` ≠ the target OS (or on unknown id). The UI filter is convenience only — a crafted API request still can't run a Windows script on Linux.
- Selection is a fixed enum of catalog ids validated server-side — never a free-text/operator-supplied script body. Curated ≠ operator-authored: adds NO RCE surface beyond what agent deploy already does (an operator with `assets:write` + valid creds already runs a root/LocalSystem installer).
- Exactly one `isDefault` variant per `osPlatform`. `scriptId` null/"" resolves to that default (pre-picker installs + discovery auto-deploy pass nothing).

**When changing this:**
- Adding a variant: add the catalog entry here AND a matching `case` in `agentInstallService.ts`'s `installerScript`/`uninstallerScript` (and, for Windows, the renderer template selection). A catalog id with no wired script throws at install time by design.
- New OS install scripts run as root/LocalSystem on remote hosts — treat as deployed code requiring real-host testing + human review before production.

---

## services/agentAutoDeployService.ts

**What it owns:** Discovers agent-less devices during integration sync and auto-kicks off installs per configured class settings. Bounded, paced, and idempotent — checks preconditions, infers platform/transport+credential, and fires installs.

**Public API:** `inferAgentPlatform`, `pickTransportAndCredential`, `checkAutoDeployPreconditions`, `runAutoDeployForClass`, `AgentOsPlatform`, `AgentTransport`, `AgentDeployClassConfig`, `DeployTarget`, `AutoDeployResult`

**Cross-service deps:** `credentialService.getCredential`, `agentInstallService.startInstall`, `certInfo.getServerCertFingerprint`, `logEvent`, polling-compatibility utils.

**Used by:** `src/services/discovery/discoveryEngine.ts` — discovery post-sync pass (calls `checkAutoDeployPreconditions` then `runAutoDeployForClass` per workstation/server class when the class's `agentDeploy` is enabled).

**Invariants:**
- Opt-in, default off (UI warns to test on a small OU first).
- Eligibility guarded by `ManagedAgent.assetId @unique` — an asset that already has any ManagedAgent row (pending/active/failed) is never re-kicked.
- Per-run kicks off at most `maxConcurrent` new installs (clamped low single digits) plus a hard RUN_CEILING backstop.
- Platform inferred from the asset OS string; fires fire-and-forget to `startInstall()` (no retry — failures are operator's to re-kick via manual reinstall).

**When changing this:**
- Adding transport/platform logic: validate in both `inferAgentPlatform` and `pickTransportAndCredential`.
- The idempotency guard (no existing ManagedAgent row) is non-negotiable — never re-kick an enrolled or in-flight asset.

---

## services/agentBuildService.ts

**What it owns:** In-app build pipeline that compiles the agent binaries (six platform/arch combos via `go build`) one build at a time, with a small FIFO queue, manifest.json publication, and old-version auto-prune. Stateful in-memory build map + single active-build mutex.

**Public API:** `startBuild`, `cancelBuild`, `getBuild`, `getCurrentBuild`, `getCurrentBuildAndQueue`, `goAvailable`, `getInventory`, `pruneOldAgentVersions`, `PLATFORMS`, `QUEUE_DEPTH`, `BuildPhase`, `BuildState`, `BuildStep`, `GoAvailability`, `BuildQueueFullError`, `GoUnavailableError`, `BuildAlreadyFinishedError`, `BuildNotFoundError`, `InventoryResult`, `PruneResult`

**Cross-service deps:** `agentInstallService.inferOwnServerUrl`, `version` (agent version + source dir), `certInfo.getServerCertHostnames`, `publicUrl` port helper, `prisma` (settings + auto-upgrade hook).

**Used by:** `src/api/routes/serverSettings.ts` (build/inventory/upgrade-all/prune endpoints), `src/jobs/autoBuildAgents.ts`.

**Invariants:**
- Single active build; concurrent requests queue FIFO up to `QUEUE_DEPTH` (then a `BuildQueueFullError` → 409).
- One build runs all six platform/arch combos serially (parallel `go build` thrashes the module cache); operator Cancel checks fire between platforms.
- Manifest version stamped from live source at start-of-run; auto-prune keeps last N versions (skips in-use + manifest-current) and fails closed if manifest reads fail.
- Optional post-build auto-upgrade is fire-and-forget, gated on a Setting.

**When changing this:**
- Go env (HOME/GOCACHE/GOMODCACHE) must stay in sync between module-resolve and build steps.
- Queue advance happens in the finally block — guard against deleted/cancelled entries.

---

## services/agentChannelService.ts

**What it owns:** In-memory `managedAgentId → WebSocket` registry for live agents: attach/detach lifecycle, heartbeat ping/pong, server-initiated probe-now requests, config-refresh frames, command-dispatch wake frames, AND the cross-process command-wake LISTENer.

**Public API:** `attach`, `detach`, `isAttached`, `sendProbeNow`, `refreshConfig`, `wakeCommands`, `startCommandWakeListener`, `liveSessionCount`, `shutdownAllSessions`, `ProbeNowResult`

**Cross-service deps:** `prisma` (managed-agent updates), `logEvent`, `pg` (dedicated LISTEN client), `dbConnections.getDirectDatabaseUrl`, `agentCommandWake.CMD_WAKE_CHANNEL`.

**Used by:** `src/api/routes/agentsWs.ts` (attach on authenticated WS upgrade), `src/api/routes/serverSettings.ts` + `src/services/monitoringService.ts` (`sendProbeNow` / `refreshConfig`), `src/app.ts` (`startCommandWakeListener` after the WS handler attaches, web/all role), app shutdown hook (`shutdownAllSessions`).

**Invariants:**
- Attach replaces any existing session for the same agentId (idempotent).
- Heartbeat ping interval + pong-timeout force-close and detach a silent agent.
- Probe-now is request-id correlated with a timeout reject; detach clears pending probes and is a no-op when not attached.
- Frame envelope is a JSON `{ type, id, payload }` — a wire protocol shared with the Go agent. Frame types: `hello` / `refresh-config` / `probe-now-request` / `commands-pending`.
- `wakeCommands` is a no-op when the agent isn't attached to THIS process — the NOTIFY reaches whichever process holds the session; the ≤20s command poll is the floor regardless.
- The command-wake LISTENer uses the DIRECT database URL (session-pinned; PgBouncer transaction pooling breaks LISTEN) and reconnects with a fixed backoff on error.

**When changing this:**
- The frame format is the agent wire protocol — any change breaks deployed agents. A new frame type must be added to the Go agent's `wsLoop` switch in lockstep (unknown types are ignored there, so new server→agent frames are backward-safe).
- Pending-probe map must be cleaned up in teardown to avoid leaks; `shutdownAllSessions` also stops the wake LISTENer.

---

## services/agentInstallService.ts

**What it owns:** Fire-and-forget remote install / uninstall / upgrade of the Polaris Agent over SSH (Linux/macOS/Windows) or WinRM (Windows): resolves credentials, mints an enrollment token, uploads the binary + a rendered `agent.conf`, runs platform scripts, and drives the ManagedAgent lifecycle (pending → uploading → enrolling → active | failed).

**Public API:** `startInstall`, `startUninstall`, `startUpgrade`, `upgradeAllOutdated`, `renderAgentConf`, `inferOwnServerUrl`, `inferOwnServerUrlSync`, `AGENT_SERVER_URL_SETTING_KEY`, `StartInstallInput`, `StartUninstallInput`, `StartUpgradeInput`, `UpgradeAllResult`

**Cross-service deps:** `credentialService.getCredential`, `agentTokenService.mintEnrollmentToken`, `agentBuildService.getInventory`, `certInfo.getServerCertHostnames`, `publicUrl` port helper, `utils/agentUnit` (`linuxServiceBlock`/`normalizePrivilegeTier`/`AgentPrivilegeTier` — the privilege-tier → systemd unit mapping; re-exported from here), `logEvent`, `prisma`, WinRM helper.

**Used by:** `src/api/routes/assets.ts` (per-asset install / reinstall / upgrade / uninstall), `src/api/routes/serverSettings.ts` (upgrade-all), `src/services/agentAutoDeployService.ts` (`startInstall`), `src/services/agentBuildService.ts` (auto-upgrade hook).

**Invariants:**
- Fire-and-forget: kicks off an async runner, returns immediately.
- Platform/arch drives binary selection (inferred from `Asset.os`, arch defaults amd64); SSH needs username + (password OR privateKey), WinRM needs username + password.
- Uninstall (and force-remove) hard-deletes the ManagedAgent row on success, clears all polling columns (incl. `processesPolling`) so source defaults resume, AND tears the host off the Application Map — clears `mappedProcesses`/`mappedServices` + `deleteMany` its `AssetProcessConnection` rows in the same transaction (nothing collects them once the agent is gone, and pinned child nodes render from the pins regardless of connection rows). Upgrade replaces the binary only — `agent.conf` (bearer + pin) is untouched so the agent keeps its identity.
- Server-URL resolution order: Setting override → `POLARIS_PUBLIC_URL` → cert hostnames → fallback → localhost.
- **Linux privilege tier** (`ManagedAgent.privilegeTier`, Linux-only) selects the systemd `[Service]` block via `agentUnit.linuxServiceBlock`: `unprivileged` (default) or `ptrace` (+CAP_SYS_PTRACE +CAP_DAC_READ_SEARCH for Application Map attribution — the pair, not SYS_PTRACE alone; see the privilege-model entry). Full root is retired — never emitted for new installs/reinstalls; a legacy `root` row downgrades on reinstall. Reinstall conversion logic lives in the `POST /assets/:id/agent/reinstall` route (`assets.ts`), not here.

**When changing this:**
- `agent.conf` templating must stay in sync with the Go agent (pin set + enrollment-token format).
- Concurrent upgrades are pool-bounded so a fleet upgrade doesn't overwhelm hosts; `testOverrides` allow fake SSH for unit tests.
- The privilege-tier → unit mapping is pure in `utils/agentUnit.ts` (unit-tested) — edit systemd directives there, and remember `linuxServiceBlock` only ever emits unprivileged/ptrace (no root branch).

---

## services/agentTokenService.ts

**What it owns:** Mints/verifies the two managed-agent token types — enrollment (one-shot, short TTL, consumed at `/enroll`) and bearer (long-lived, revoked on uninstall) — stored as argon2id hashes + an indexed prefix, with the bearer bound to a single assetId.

**Public API:** `mintEnrollmentToken`, `consumeEnrollmentToken`, `shouldEnableMonitoringOnEnroll`, `verifyBearer`, `revokeBearer`, `ConsumedEnrollment`, `VerifiedAgent`

**Cross-service deps:** `prisma` (managedAgent), password hash/verify util.

**Used by:** `src/api/middleware/auth.ts` (`verifyBearer` for agent endpoints), `src/api/routes/agents.ts` (`consumeEnrollmentToken` at `/enroll`), `src/api/routes/agentsWs.ts` (`verifyBearer` on WS upgrade), `src/api/routes/assets.ts` (`revokeBearer` on uninstall), `src/services/agentInstallService.ts` (`mintEnrollmentToken`).

**Invariants:**
- Token format `polaris_<random>` with an indexed prefix for O(1) candidate lookup; full secret stored only as an argon2id hash.
- Enrollment has a short TTL and is idempotent to re-mint (Reinstall overwrites a stale token); `consumeEnrollmentToken` atomically clears enrollment fields, mints the bearer, flips installStatus→active, stamps polling columns, and auto-enables `monitored` (never on decommissioned/disabled assets — business rule 10; no-op on already-monitored so a Reinstall doesn't re-log).
- `verifyBearer` self-heals a stuck "enrolling" status (an agent reusing an existing bearer skips `/enroll`); `revokeBearer` is idempotent.
- Bearer is bound to `assetId @unique` as cross-asset-reuse defense; dual-pin enroll validates against the canonical fingerprint while additional pins stage in `additionalServerCertFingerprints`.

**When changing this:**
- Enrollment expiry is load-bearing for install-retry safety (operator re-mints via Reinstall) — don't make it permanent.

---

## services/apiTokenService.ts

**What it owns:** Long-lived bearer-token CRUD for external API access; argon2id hash + tokenPrefix-based lookup; role binding (each token carries a roleId whose matrix requirePermission resolves like a session snapshot); integrationIds enforcement when the bound role grants assetsQuarantine >= write; api_token.admin_equivalent warning Event on admin-equivalent bindings.

**Public API:** ApiTokenSummary, AuthenticatedToken, CreateTokenInput, CreateTokenResult, createToken, listTokens, revokeToken, deleteToken, verifyToken.

**Cross-service deps:** permissions.ts (normalizePermissions, isAdminEquivalentPermissions), eventLogService (logEvent via routes/events re-export).

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
- A bound role granting assetsQuarantine ≥ write requires integrationIds (≥1 FortiManager/FortiGate id); other roles may have empty integrationIds.
- Roles bound to tokens can't be deleted (roleService counts apiTokens and 409s); role edits propagate to live tokens via the bumpRoleVersion cache on the next request.
- verifyToken() is best-effort on lastUsedAt/lastUsedIp updates; missed bumps don't fail auth.
- Expired tokens (expiresAt in past) and revoked tokens (revokedAt set) are silently excluded from lookup; no 401 distinction.

**When changing this:**
- Audit validateIntegrationIds if adding new integration types to quarantine support.
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

## services/assetGhostMergeService.ts

**What it owns:** Automated ghost merging, two flavors: (1) the endpoint-ghost merge — collapses a duplicate `fortigate-endpoint` placeholder Asset (created when a managed FortiSwitch/FortiAP's mgmt interface pulled a DHCP lease and the FortiGate's DHCP/device-inventory pathway learned its MAC as an ordinary client; hostname = the device serial) into the canonical infrastructure asset, then deletes the ghost; and (2) the duplicate-hostname policy + executor behind the mergeDuplicateHostnameAssets sweep (moved from the job 2026-08 so they're unit-testable): `decideDuplicateHostnameGroup` picks the canonical by source-kind tier (identity-tagged 1 > fortiswitch 2 > fortiap 3 > firewall 4 > endpoint 5 > manual 6 > orphan 7; lastSeen/updatedAt tiebreak; same-tier conflicting-MAC groups skip for operator review) and `mergeDuplicateHostnameGhost` runs the per-ghost transaction (side-table transfer, null-fill scalar absorption + tag union, bumpLastSeen-gated lastSeen adoption, ghost cascade-delete).

**Public API:** `isMergeableGhostSourceKinds` (pure), `isMergeableEndpointGhost`, `mergeEndpointGhostIntoAsset`, `GhostMergeResult`, `decideDuplicateHostnameGroup` (pure), `mergeDuplicateHostnameGhost`, `DuplicateHostnameAssetRow`, `DuplicateGroupDecision`

**Cross-service deps:** `prisma`, `assetMergeService.transferAssetSideTables` (shared side-table transfer), `monitorOverrideService.recomputeMonitorOverrideForAssets` (after a monitored carry-over).

**Used by:** `src/services/discovery/discoveryEngine.ts` — the `sweepEndpointGhostsInto` helper called from the FortiSwitch + FortiAP loops of `syncDhcpSubnets` (both update and create branches; candidates = base-MAC lookup + hostname==serial lookup, never bare IP); `src/jobs/mergeFortiswitchEndpointGhosts.ts` (one-shot startup sweep for the legacy NULL-MAC shape).

**Invariants:**
- Eligibility is provenance-based, never assetType-based: the ghost must carry a `fortigate-endpoint` AssetSource and NO authoritative source (`fortiswitch` / `fortiap` / `fortigate-firewall` / `ad` / `entra` / `intune` / `polaris-agent`). The empty `manual` row an operator edit stamps does NOT disqualify. Hand-created assets and real discovered devices can never be absorbed.
- Ghost AssetSource rows are DELETED, not re-bound — deliberately different from `assetMergeService.mergeAssets` (see that entry): re-binding would staple a stale fortigate-endpoint / orphaned manual source onto the infra asset. Tags are NOT unioned for the same reason.
- The ghost's MAC is adopted only when the canonical has none; `monitored=true` carries over only when the ghost was monitored and the canonical wasn't (endpoint ghosts are never auto-monitored, so that flag is operator intent), followed by a best-effort `recomputeMonitorOverrideForAssets`.
- Ghost sample hypertable rows are orphaned (no Asset FK since migration `20260615000000`) and age out via `drop_chunks` — never row-deleted (compressed-chunk bloat).

**When changing this:**
- Keep `AUTHORITATIVE_SOURCE_KINDS` in sync with the AssetSource `sourceKind` vocabulary — a new authoritative kind that isn't listed makes its assets eligible for absorption.
- The discovery-side caller updates the in-memory `AssetIndex` (`remove(ghost)` + `reindex(canonical)`) after each merge — later phases in the same sync would otherwise write to the deleted ghost.

---

## services/assetMergeService.ts

**What it owns:** Operator-driven asset merge (inverse of split) — re-binds an absorbed ("ghost") asset's multi-source discovery rows + side tables onto a survivor ("canonical") asset, applies per-field winners, then deletes the ghost.

**Public API:** `MERGEABLE_FIELDS`, `MergeableField`, `FieldWinner`, `MergeAssetsResult`, `mergeAssets`, `transferAssetSideTables`, `SideTableTransferCounts`

**Cross-service deps:** `prisma`, `AppError`, `clampAcquiredToLastSeen`, `monitorOverrideService.recomputeMonitorOverrideForAssets` (after a monitored carry-over).

**Used by:** `src/api/routes/assets.ts` — `POST /assets/:id/merge`; `assetGhostMergeService.ts` (imports `transferAssetSideTables`).

**Invariants:**
- Canonical and ghost must be distinct IDs; all transfers run in a single `$transaction`.
- Ghost `AssetSource` rows re-bind to canonical (global `(sourceKind, externalId)` uniqueness means no collision); `AssetMacAddress` / `AssetAssociatedIp` / `AssetIpHistory` / `AssetFortigateSighting` delete-on-conflict when duplicates exist.
- `ManagedAgent` transfers only if the survivor has none; `lastSeen` keeps the more recent value; tags union; `acquiredAt` clamped to stay ≤ `lastSeen`.
- **`monitored` is OR-ed, not "survivor wins"** — either side monitored ⇒ the survivor is monitored (`carriedMonitoring` in the result; same intent as `assetGhostMergeService.transferredMonitored`). ON-flip only: an unmonitored ghost never turns a monitored survivor off, and a survivor that was already monitored keeps its own config untouched. When the flip happens the ghost's monitoring CONFIG rides along — `MONITOR_CONFIG_FIELDS` (per-stream polling methods, credentials, MIB pins, interval/timeout overrides; ghost's non-null wins, survivor keeps its own where the ghost has none) and `MONITOR_PIN_FIELDS` (monitored/mapped interface / storage / tunnel / process / service arrays; UNIONed) — because enabling the flag alone would leave a monitored asset resolving streams off empty overrides. `monitorStatus` resets to null + failure/success counters to 0 (the ghost's samples are orphaned, so no history backs a carried status), then `recomputeMonitorOverrideForAssets` runs post-transaction.
- Business rule 10 outranks the carry-over: the merged status (`fieldWinners`-resolved, not just the survivor's current) landing on `decommissioned`/`disabled` skips it entirely. Resolved in-service because the `db.ts` clamp only fires when a write stages `status`, which a status-preserving merge doesn't.
- Ghost's TimescaleDB sample rows are orphaned (no FK) and age out via `drop_chunks` — never row-deleted here.

**When changing this:**
- Keep `MERGEABLE_FIELDS` in sync with the comparison UI in `public/js/assets.js`.
- The comparison UI defaults the survivor to the side with the longer polling history (`GET /assets/:id/polling-history` → `sampleHistoryService.readPollingHistorySummary`; span first, sample count as tiebreak) precisely because the ghost's samples are orphaned here — if the merge ever starts carrying sample history over, retire that auto-select + the confirm-step "deleting the longer record" warning in `public/js/assets.js`.
- A new per-asset monitoring override column (polling method / credential / cadence / pin array) belongs in `MONITOR_CONFIG_FIELDS` or `MONITOR_PIN_FIELDS`, or a merge will enable monitoring without it. `ASSET_SELECT` derives from both lists, so adding it there is enough.
- The merge modal's review step mirrors the carry-over client-side (`monitoringCarried` in `_buildMergePlan`, `public/js/assets.js`) — keep the rule 10 exclusion in sync so the preview can't promise a flip the server refuses.

---

## services/assetTypeService.ts

**What it owns:** CRUD + in-memory cache for the `AssetTypeDef` registry (replaces the retired `AssetType` enum). Built-in types (the eight historical + vCenter's `hypervisor`) are protected; custom types support transactional rename and use-checked delete. The `virtual_machine` built-in was retired by migration 20260722000000 (vCenter VMs are typed `server`) — keep it out of `BUILT_IN_SEEDS` / `BUILT_IN_ASSET_TYPES` or the boot self-heal resurrects it.

**Public API:** `AssetTypeRow`, `listAssetTypes`, `getAssetType`, `createAssetType`, `updateAssetType`, `deleteAssetType`, `refreshCache`, `seedBuiltInAssetTypes`

**Cross-service deps:** `prisma`, `AppError`, `setAssetTypeRegistry` + asset-type validate/normalize helpers + `BUILT_IN_ASSET_TYPES` (utils/assetTypes).

**Used by:** `src/api/routes/assetTypes.ts` (registry CRUD), `src/jobs/seedAssetTypes.ts` (boot seed). Frontend readers of `GET /asset-types` (`api.assetTypes.list()`): `public/js/assets.js` (`_loadAssetTypeOptions` → `ASSET_TYPE_OPTIONS` + `ASSET_TYPE_LABELS`, which drive the Type column filter, the create/edit + PDF-import Type selects, and the row/bulk type menus), `automations-wizard.js`, `appmap-rules-wizard.js`, `assets-maintenance.js`, `server-settings.js` (tag criteria).

**Invariants:**
- Built-in rows (`isBuiltIn` + `isProtected`) can't be renamed, edited, or deleted; reserved built-in names are preserved across operator edits.
- Custom rename is atomic: every `Asset.assetType` rewrite happens in the same transaction as the registry row update (Asset.assetType is a String, not a relation).
- Delete refuses with 409 when any Asset references the type; cache refreshed on every write and at boot.

**When changing this:**
- Built-in type names are hardcoded in branch logic elsewhere (dependency tree, topology, polling defaults) — don't rename them.

---

## services/assetQuarantineService.ts

**What it owns:** Push/pull FortiGate MAC quarantine via persistent `user.quarantine.targets` CMDB tree; orchestrates multi-FortiGate best-effort with per-device all-or-nothing atomicity.

**Public API:** `quarantineAsset(), releaseQuarantine(), verifyAssetQuarantine(), buildTransportForIntegration(), pushQuarantineToFortigate(), unpushQuarantineFromFortigate(), normalizeMac(), quarantineTargetName()`

**Cross-service deps:** `assetSightingService.ts` (for candidate targeting).

**Used by:** `src/api/routes/assets.ts,2115,2130,2168,2189 — quarantine/release/verify endpoints (4 routes)`, `src/services/discovery/discoveryEngine.ts — auto-quarantine post-discovery on new FortiGate sighting`

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

## services/assetSourcePriorityService.ts

**What it owns:** The operator-settable priority behind the assets table's **Sources** column — which discovery source's "where was this learned?" answer wins when an asset is known to several at once. One Setting row (`assetSourcePriority`, `{order[], integrationPrefix}`) over `createSettingStore` with a 30s TTL. The catalogue of who can contribute what is the pure `utils/assetSourceLocation.ts`; this service owns persistence, validation, audit, and installing the order into the projection.

**Public API:** `getSourceLocationPriority()`, `getSourcePrioritySettings()`, `saveSourceLocationPriority(input, actor)`, `refreshProjectionPriority()`, `invalidateSourcePriorityCache()`, `ASSET_SOURCE_PRIORITY_KEY`

**Cross-service deps:** `settingsStore.createSettingStore`, `eventLogService.logEvent`, `utils/assetSourceLocation` (catalogue + normalizer), `utils/assetProjection.setLearnedLocationPriority` (the install seam).

**Used by:** `src/api/routes/assets.ts — GET/PUT /assets/source-priority`, `src/services/discovery/discoveryEngine.ts — refreshProjectionPriority() at the top of runDiscovery`, `src/app.ts — refreshProjectionPriority() once per process in startBackgroundJobs`

**Invariants:**
- The order feeds `Asset.learnedLocation` through the projection, **not just rendering**. The Sources column, its text filter, its sort, "behind FortiGate X" tag/maintenance criteria and the Device Map's per-site narrowing all read `learnedLocation` — deciding the winner at render time would make the column disagree with everything that filters on it. Never "fix" this by moving the resolution into the list enrichment.
- **Propagation is pull-based, and must stay that way.** The projection runs inside the DISCOVERY process in the split-role layout, so a web-role write can't push it. `refreshProjectionPriority()` at boot (every role) + at the start of every `runDiscovery` is the whole mechanism; the per-run refresh is also the moment learnedLocation is next written, so nothing is observably stale. Adding a new projection caller in another process means adding a refresh there too.
- Reordering is **not retroactive** — existing rows re-project on their integration's next discovery run. The UI says so; don't promise otherwise.
- The READ path self-heals (`normalizeSourceLocationPriority` drops unknown kinds, collapses duplicates, appends missing kinds in default order) while the WRITE path REJECTS unknown/duplicate kinds with a 400. Asymmetric on purpose: a stored row must survive a catalogue change, a client posting a typo must hear about it.
- `refreshProjectionPriority()` never throws — a DB hiccup leaves the DEFAULT order in force (pre-feature behavior) rather than failing a discovery run.
- **A source blob may never hold the projection's own OUTPUT.** `fortigate-endpoint`'s observed blob is stamped from `Asset.learnedLocation` — which the projection wrote — so with `integrationPrefix` on, the render fed straight back into its own input and every discovery cycle prefixed it again (prod, 2026-08: a laptop reached 32 `FMG1:` segments before anyone noticed; with the toggle off the projection is idempotent, which is why it hid). Both ends now guard it: `buildFortigateEndpointObservedBlob` + `backfillFortigateEndpointSources` stamp the BARE device name, and `contributedLocation` bares any `fortinetDevice` value before prefixing (`bareFortinetDeviceName` — a FortiGate/FMG name can't contain a colon, so anything before the last one is rendering). Keep the read-side strip even though the write side is fixed: it heals rows already polluted, and it's what stops the next writer that stamps a rendered location from restarting the growth.
- The default order reproduces the pre-feature hardcoded `LEARNED_LOCATION_RULES` for the field contributors; `tests/unit/assetSourceLocation.test.ts` pins that. Changing it silently re-labels every asset in every install on the next run.

**When changing this:**
- Adding a source kind: add it to `LOCATION_CONTRIBUTORS` in `utils/assetSourceLocation.ts` (the normalizer appends it to every stored order automatically — that's why it goes at the END of the catalogue) and to the `learnedLocation` row of ARCHITECTURE.md's projection priority table. No client change needed; the settings list is server-driven.
- Adding a **field**-mode contributor: confirm the observed key is actually written by the discovery path that mints the source row. A contributor whose key never appears is a silent no-op.
- Touching the `integrationPrefix` rendering: it reads `observed.integrationName`, stamped by `buildFortigateEndpointObservedBlob` + `upsertFortinetInfraAssetSource` in `discoveryEngine.ts`. Rows written before that stamp fall back to the bare device name — keep that fallback or pre-upgrade assets render a dangling `:name`. Whatever you change, `contributedLocation` must stay IDEMPOTENT under its own output (see the feedback-loop invariant above); the test file pins that directly.
- Any change to what a source contributes is a change to `Asset.learnedLocation`: re-check the "behind FortiGate" matchers in `tagAssignmentService` / maintenance criteria (`utils/integrationFilter.ts` reads AD's `ouPath` off learnedLocation as a fallback) and `dashboard.ts`'s per-site narrowing.

---

## services/assetSightingService.ts

**What it owns:** Records DHCP-only (asset, FortiGate) sightings to drive quarantine fan-out targeting.

**Public API:** `recordSightings(), getSightingsForAsset(), getQuarantineCandidates(), getSightingSettings(), updateSightingSettings()`

**Cross-service deps:** None.

**Used by:** `src/services/discovery/discoveryEngine.ts — batch-record sightings after DHCP discovery sync`, `src/api/routes/assets.ts — fetch sighting list for Quarantine tab`, `src/services/assetQuarantineService.ts — fan-out targeting within quarantineAsset()`

**Invariants:**
- Sightings are deduped by `(assetId, fortigateDevice)` pair; `seenAt` determines entry precedence, `dhcp_reservation` trumps `dhcp_lease` on tie.
- `getQuarantineCandidates()` filters by `sightingMaxAgeDays` Setting (default 180; 0 = no filter); stored rows never auto-prune.
- Only DHCP evidence qualifies (transit via System tab interface scrape intentionally excluded per design).
- Every caller of `recordSightings()` must dedupe + normalize before passing; batch upsert handles dedup again for safety.

**When changing this:**
- Check `assetQuarantineService.ts` `quarantineAsset()` for sighting-filter logic (max-age, integration scoping).
- Verify `discoveryEngine.ts` `syncDhcpSubnets()` call site still matches expected SightingInput shape.
- Review Settings UI (assets.html) sighting age control and max-age tooltip.
- Ensure `pruneOldHistory` job (if added) respects Setting-backed retention separately from max-age filter.

---

## services/autoMonitorInterfacesService.ts

**What it owns:** Auto-monitor interface selection for FMG/FortiGate integrations. Multi-block union: `byNames`, `byPatterns` (wildcards or anchor-free regex per block flag), `byTypes`, `byLldp` (pin where a monitored neighbor of the chosen type is connected — direct LLDP advertisement OR peer-inferred edge from `Asset.fortinetTopology`). Each block independent; apply pass takes the union. Strictly additive — never strips operator-owned pins. The apply pass writes to TWO fields by interface provenance: real interfaces → `Asset.monitoredInterfaces` (IF-MIB), synthetic IPsec-tunnel rows → `Asset.monitoredIpsecTunnels` (the IPsec sampler's fast-poll list) — so a "By type: tunnel" selection actually fast-polls IPsec tunnels on REST-polled gates. `splitPinsByProvenance` does the partition.

**Public API:** `compileWildcard`, `compilePattern`, `resolvePinnedInterfaces`, `splitPinsByProvenance`, `mergeTunnelsIntoInterfaces`, `getInterfaceAggregate`, `computeAndCacheInterfaceAggregate`, `getCachedInterfaceAggregate`, `previewAutoMonitorForClass`, `applyAutoMonitorForClass`, `coerceLegacySelection`, `AutoMonitorSelection`, `AutoMonitorClass`, `ResolverInterface`, `PinsByProvenance`, `TunnelObservation`, `LldpNeighborMatch`, `LldpByIfName`, `LldpNeighborType`, `IfType`, `AggregateRow`, `CachedAggregateRow`, `InterfaceAggregateCacheEntry`, `InterfaceAggregateCache`, `PreviewResult`, `ApplyResult`, `LLDP_NEIGHBOR_TYPES`, `IF_TYPES`.

**Cross-service deps:** Reads `asset_interface_samples` (latest per (assetId, ifName) via DISTINCT ON) and `asset_lldp_neighbors` JOIN `assets` (matched-asset type + monitored flag) directly via `prisma.$queryRaw`. For the `fortigate` class ALSO reads `asset_ipsec_tunnel_samples` (latest per (assetId, tunnelName), same 72h DISTINCT ON, run in parallel) and merges each tunnel in as a synthetic `ifType:"tunnel"` `ResolverInterface` via the pure `mergeTunnelsIntoInterfaces` — covers FortiOS phase1-interface tunnels the REST monitor endpoint omits from `asset_interface_samples`. Gated on class because switches/APs have no IPsec. ALSO consults `Asset.fortinetTopology` JSON paths (class-aware raw SQL in `loadInferredLldpByAsset`) to synthesize peer-inferred neighbor matches that the persisted LLDP table can't see — same data source `peerInferredLldpService` uses for the System tab Neighbor column. Inferred matches merge into the real LLDP map via `mergeLldpMaps` before the pure resolver runs; the resolver itself is unchanged and can't tell them apart. For the `fortiap` class, a post-load step (`normalizeFortiapInferredLldp` → `src/utils/fortiapInterfaceAlias.ts:normalizeFortiapInterfaceName`) rewrites synthesized `localIfName` from FortiAP-CLI naming (`lan1`) to SNMP-canonical (`eth0`) when the AP's interface table exposes the eth* form — without this, the resolver would pin a name that doesn't match any ifIndex on the fast-cadence scrape.

**Used by:** `src/api/routes/integrations.ts` — `interface-aggregate` / preview / apply endpoints; `src/services/discovery/discoveryEngine.ts` — `syncDhcpSubnets` Phase 2c on discovery completion AND the AD/Entra post-sync `applyWorkstationServerAutoMonitor` pass. `src/jobs/migrateAutoMonitorInterfacesShape.ts` — calls `coerceLegacySelection` to rewrite stored configs at boot.

**Aggregate cache (`Integration.interfaceAggregateCache`):** `runDiscovery`'s success branch calls `computeAndCacheInterfaceAggregate(id, type)` as a best-effort final step — runs `getInterfaceAggregate` for every interface class the integration type carries (Fortinet → fortigate/fortiswitch/fortiap; AD/Entra/Windows-Server → workstation/server) and persists the UI-rendered fields + `computedAt` to the Integration row. The `GET .../interface-aggregate` route now reads this via `getCachedInterfaceAggregate` and only live-computes when the class entry is missing (pre-first-run). **Writer:** discovery success path. **Reader:** the GET route. **Invariant:** the cache holds only `ifName`/`ifType`/`deviceCount` (no `devices[]`); if a future UI needs the device list it must hit a live path, not the cache. The operator "Refresh from latest discovery" button was removed — the only refresh trigger is a discovery run.

**Live consumers `previewAutoMonitorForClass` / `applyAutoMonitorForClass` still scan `loadLatestInterfaces` (fleet-wide, multi-second-to-minutes at scale).** Two mitigations so this no longer blocks the modal: (1) the `POST .../interface-aggregate/apply` route is **fire-and-forget** — kicks the apply in the background and returns `202`; Phase 2c re-runs it every discovery so a dropped run self-heals. (2) the frontend preview no longer calls `previewAutoMonitorForClass` for `byNames`/`byPatterns`/`byTypes` — it computes from the already-loaded cache rows client-side (`computeClientPreview` in `public/js/integrations.js`, mirroring `compileWildcard`/`compilePattern` via `_amonWildcardToRegex`/`_amonRegexFromString`); only `byLldp` (topology, uncached) still hits the live preview endpoint. **Gotcha:** the client preview can't honor `onlyUp` (no per-device `operStatus` in the cache) or the dead-parent tunnel exclusion (no parent-link state in the cache) so `byPatterns`/`byTypes`/`byNames` counts are upper bounds — keep `computeClientPreview`'s `approx` flag + the server resolver in sync if `onlyUp` or exclusion semantics change.

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
- **Dead-parent exclusion (parent down + no IP):** `mergeTunnelsIntoInterfaces` consumes `TunnelObservation.parentInterface` (the phase-1 CMDB `interface` field, selected by `loadLatestInterfaces` alongside `AssetInterfaceSample.ipAddress`) and stamps `parentDownNoIp: true` on any tunnel row (synthetic or collided-real) whose parent interface row on the same asset is `operStatus === "down"` AND has no usable IP (null / `""` / `0.0.0.0`, first token before space or `/`). `resolvePinnedInterfaces` filters those rows out up front, so NO block can pin them — including byNames (whose "up/down ignored" applies to the tunnel's own state only) and byTypes+`includeDownTunnels` (which exists for flapped-but-addressed underlays, not dead ones). Missing parent row / null parentInterface / unknown parent operStatus / down-but-addressed parent → no exclusion (positive evidence only). Hand-pins on `Asset.monitoredIpsecTunnels` are untouched (apply is additive). Unit-tested ("dead-parent exclusion" describe block).
- **`byTypes.includeDownTunnels`:** tunnel-only exception to `onlyUp` in `resolvePinnedInterfaces` — when `onlyUp` would drop a non-up interface, it's still kept iff `includeDownTunnels === true` AND `ifType === "tunnel"`. No effect on other types; moot when `onlyUp` is false. Does NOT rescue dead-parent tunnels (see the exclusion above). Touch-points: `ByTypesBlock` type + resolver (`autoMonitorInterfacesService.ts`); `ByTypesSchema` is `.strict()`, so the field MUST be in the Zod schema in `integrations.ts` or PUTs 400. Frontend (`public/js/integrations.js`): rendered by `_amonTypeRowHTML` inline next to the tunnel row, wired by `wireInclDown`, state tracked in the `inclDownState` closure (survives `renderTypesList` rebuilds), read in `_readAutoMonitorInterfaces` (only when `tunnel` is selected), and folded into `_amonCanonicalize` so toggling it registers as a change that re-fires the apply pass.
- **Latest interface resolution:** `loadLatestInterfaces()` uses `DISTINCT ON (assetId, ifName)` ORDER BY timestamp DESC over a **72h window**. No separate inventory table. The time bound is load-bearing — without it the DISTINCT ON walks the entire active hypertable chunk per (assetId, ifName) pair (same disaster pattern interfaceTopologyService had to fix at 13.5 min / 90M rows / 9 GB I/O on prod). 72h tolerates the long end of the pollInterval-linked systemInfo cadence (up to 24h) plus missed scrapes. Operator-visible effect: assets that haven't reported in >72h drop from the "By name" aggregate checklist, which is the right behavior for a "currently-existing interfaces" picker.
- **Legacy shape coercion:** `coerceLegacySelection` rewrites the older `{mode: "names"|"wildcard"|"type", ...}` discriminated union to the new shape. Called by the Zod preprocess in the PUT schema, the apply route, the Phase 2c apply pass, the migration job, AND the frontend renderer (`_amonCoerceLegacy` in `public/js/integrations.js`). New-shape values pass through unchanged on every layer so re-running is safe.

## services/autoMonitorStorageService.ts

**What it owns:** Auto-monitor storage-mount selection for AD/Entra workstation/server classes (the storage analog of autoMonitorInterfacesService — net-new, no FMG/FortiGate equivalent). Multi-block union: `byNames` (exact mountPaths), `byPatterns` (wildcards or regex), `all` (every observed mount). Strictly additive to `Asset.monitoredStorage` — never strips operator pins.

**Public API:** `resolvePinnedStorage`, `getStorageAggregate`, `computeAndCacheStorageAggregate`, `getCachedStorageAggregate`, `previewAutoMonitorStorageForClass`, `applyAutoMonitorStorageForClass`, `AutoMonitorStorageSelection`, `StorageClass`, `ResolverMount`, `StorageAggregateRow`, `CachedStorageRow`, `StorageAggregateCacheEntry`, `StorageAggregateCache`, `StoragePreviewResult`, `StorageApplyResult`.

**Cross-service deps:** Reads `asset_storage_samples` (latest per `(assetId, mountPath)` via 72h-bounded `DISTINCT ON` — same time-bound rationale + the `(assetId, mountPath, timestamp)` index as the interfaces loader). Imports `compilePattern` from `autoMonitorInterfacesService.ts` (no duplication). No LLDP, no tunnel merge, no legacy coercion.

**Used by:** `src/api/routes/integrations.ts` — `storage-aggregate` / preview / apply endpoints (AD/Entra-only `workstation|server` class enum); `src/services/discovery/discoveryEngine.ts` — the AD/Entra post-sync `applyWorkstationServerAutoMonitor` pass.

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

## services/groupMappingService.ts

**What it owns:** CRUD over the `GroupMapping` table + the login-time resolver that turns IdP group claims into a role + region/other tags. Highest-privilege role wins across matched groups; tags union. Enabled-mappings are cached per provider.

**Public API:** `resolveGroupsToAccess`, `normalizeGroupKey`, `listGroupMappings`, `getGroupMapping`, `createGroupMapping`, `updateGroupMapping`, `deleteGroupMapping`, `GROUP_MAPPING_PROVIDERS`

**Cross-service deps:** permissions helpers (`normalizePermissions`, admin-equivalent check, highest-privilege picker), `logEvent`, `tagNormalize` (normalize + union).

**Used by:** `src/services/ssoProvisioning.ts` + `src/api/routes/auth.ts` (`resolveGroupsToAccess` at login), `src/api/routes/groupMappings.ts` (CRUD, gated on `users=fullwrite`), `src/services/regionScopeService.ts` (live `/auth/me` re-resolution keyed on `User.authProvider`).

**Invariants:**
- `normalizeGroupKey` is applied identically on write (stored key) and read (incoming claim) so matching never diverges; LDAP + entra-proxy keys lowercase for case-insensitive match (entra-proxy = Entra group object-ID GUIDs), OIDC/SAML trim-only.
- Enabled-mappings cache invalidates on every write; highest-privilege role chosen when matched groups disagree.
- A mapping pointing at an admin-equivalent role emits a warning Event (the audit trail for IdP→admin paths); a `roleId=null` tag-only mapping contributes tags without a role.
- `GROUP_MAPPING_PROVIDERS` (`oidc`/`ldap`/`saml`/`entra-proxy`) is the single source of truth — `groupMappings.ts`'s `ProviderSchema` and `regionScopeService`'s lookup both key off `User.authProvider`, so a login provider's stored `authProvider` string MUST equal its `GROUP_MAPPING_PROVIDERS` entry or group tags silently never resolve.

**When changing this:**
- Adding to `GROUP_MAPPING_PROVIDERS` is code-only (no `GroupMapping` schema migration — `provider` is a free-form string); ensure the new provider's login path stores a matching `authProvider`. `normalizeGroupKey` changes risk breaking already-stored keys.

---

## services/ldapClient.ts

**What it owns:** Shared `ldapts` connection helpers (TLS, bind/unbind lifecycle, AbortSignal, RFC-4515 escaping, objectGUID decode) — one code path used by both on-prem AD discovery and LDAP user auth.

**Public API:** `buildLdapUrl`, `newLdapClient`, `withBoundLdapClient`, `escapeLdapFilterValue`, `decodeObjectGuid`, `formatLdapError`

**Cross-service deps:** none (ldapts, node:crypto).

**Used by:** `src/services/ldapAuthService.ts` and `src/services/activeDirectoryService.ts` (bind + search helpers).

**Invariants:**
- Single TLS decision: `rejectUnauthorized = !!config.verifyTls`; default ports 389/636; bounded connect + general timeouts.
- No referral chasing (referrals surface as non-results, not recursive binds).
- `escapeLdapFilterValue` runs on every user-supplied filter value — order: backslash first, then `*`, `(`, `)`, null.

**When changing this:**
- Don't add referral chasing without threat-modeling attacker-influenced server binding; don't weaken the filter escape.

---

## services/ldapAuthService.ts

**What it owns:** LDAP/AD bind-as-user authentication + group lookup; provisions the Polaris user with group-derived role/tags via `ssoProvisioning`. Settings live in a Setting row with `bindPassword` masked on read.

**Public API:** `getLdapSettings`, `getLdapSettingsMasked`, `updateLdapSettings`, `isLdapEnabled`, `authenticateLdapUser`, `findOrProvisionLdapUser`, `testLdapConnection`

**Cross-service deps:** `ldapClient` (bound-client + escape + GUID decode + error format), `ssoProvisioning.provisionExternalUser`.

**Used by:** `src/api/routes/auth.ts` (LDAP login via `POST /auth/login`, LDAP test + settings endpoints).

**Invariants:**
- Empty password is rejected BEFORE any bind (unauthenticated-bind trap); username is RFC-4515-escaped before filter substitution.
- Two-phase: service-account bind locates the user, then a rebind AS the user verifies credentials; optional reverse group search catches groups missing from `memberOf`.
- Stable user id is objectGUID (hex) or entryUUID, falling back to DN; settings cache has a short TTL and preserves the bindPassword mask on write unless changed.

**When changing this:**
- Keep the empty-password check first, before any network I/O.

---

## services/oidcAuthService.ts

**What it owns:** OpenID Connect (Authorization Code + PKCE/S256) login via `openid-client` v6 — discovery, JWKS, ID-token signature/iss/aud/exp/nonce validation, config storage, redirect-URI derivation, and group-to-role provisioning.

**Public API:** `getOidcSettings`, `getOidcSettingsForUi`, `updateOidcSettings`, `isOidcEnabled`, `getRedirectUri`, `buildAuthorizationUrl`, `handleCallback`, `findOrProvisionOidcUser`, `testOidcConnection`

**Cross-service deps:** `ssoProvisioning.provisionExternalUser`.

**Used by:** `src/api/routes/auth.ts` (OIDC login kick-off, callback, settings, test endpoints).

**Invariants:**
- `state` (CSRF) / `nonce` (replay) / `codeVerifier` (PKCE) live in the PG-backed session between login and callback; the callback is a top-level GET so SameSite=Lax cookies are sent.
- Callback never honors a caller-supplied return path — always redirects to `/`; `clientSecret` masked on read, preserved-on-unchanged on write.
- Redirect URI is derived from `POLARIS_PUBLIC_URL` (missing → throws with a clear message); userinfo claims merge into ID-token claims when present.

**When changing this:**
- Never add a caller-supplied return_uri / open-redirect surface to the callback.

---

## services/ssoProvisioning.ts

**What it owns:** Shared find-or-provision for OIDC, LDAP, and Entra App Proxy users — resolves IdP groups to role + tags, matches or creates the Polaris user, applies the highest-privilege role, records normalized groups in `User.ssoGroups`, and stamps `authProvider` to the current provider on every login.

**Public API:** `provisionExternalUser`, `ExternalUserProfile`

**Cross-service deps:** `groupMappingService` (`resolveGroupsToAccess`, `normalizeGroupKey`).

**Used by:** `src/services/ldapAuthService.ts`, `src/services/oidcAuthService.ts`, and `src/services/entraProxyAuthService.ts` (find-or-provision).

**Invariants:**
- `ssoGroups` capped (anti-bloat) and normalized per provider; they do NOT write to the user's own `regionTags`/`otherTags` (those stay operator-owned and union at read time).
- Existing user: role overridden only when groups resolve a role (a manual admin assignment survives a no-match login); new user: group-resolved role else built-in `readonly`, always flagged `needsRoleReview`.
- Existing-user update stamps `authProvider = provider` — a no-op for oidc/ldap (matched by their own id column) but the mechanism that converges an `azureOid` row between `entra-proxy` and `azure` (SAML): since the 2026-08 fold the SAML path delegates here too, so the LAST login path owns `authProvider`+`ssoGroups`, and tag re-resolution translates `authProvider="azure"` to the `"saml"` mapping provider via `mappingProviderForAuthProvider`.
- Username collisions resolve via base → base-provider → provider-externalId; SSO/LDAP users get a random placeholder password hash that is never checked at login.

**When changing this:**
- Don't change the role-override rule — a no-match login must never demote an existing admin.
- `externalIdField` is a narrow union (`oidcSubject`/`ldapUid`/`azureOid`) — entra-proxy deliberately shares `azureOid` with SAML; keep the convergence behavior intentional.

---

## services/entraProxyAuthService.ts

**What it owns:** Entra Application Proxy header-based SSO — settings (Setting key `entraProxy`, no secrets), the fail-closed source-IP trust gate, identity-header extraction, and find-or-provision (via `ssoProvisioning`, keyed on `azureOid`). The identity headers are UNSIGNED; the source-IP allowlist is the entire security boundary.

**Public API:** `getEntraProxySettings`, `updateEntraProxySettings`, `clearEntraProxySettingsCache`, `isEntraProxyEnabled`, `isTrustedEntraProxySource`, `isEntraProxyLoginAvailable`, `identityHeaderNames`, `defaultIdentityHeaderNames`, `extractEntraProxyIdentity`, `findOrProvisionEntraProxyUser`, `testEntraProxyRequest`, `EntraProxySettings`

**Cross-service deps:** `ssoProvisioning.provisionExternalUser`, `utils/ipAllowlist` (`ipMatchesAllowlist`, `isValidAllowlistEntry`).

**Used by:** `src/api/routes/auth.ts` (`/auth/entra-proxy/*` config, login, settings, test), `src/api/middleware/entraProxyHeaders.ts` (strip decision), `src/app.ts` (silent auto-login availability check).

**Invariants:**
- Fail closed everywhere: empty allowlist ⇒ `isEntraProxyEnabled` false, `ipMatchesAllowlist` false; trust is checked against `req.ip` (trust-proxy resolved), NEVER the raw socket (always 127.0.0.1 behind nginx).
- Header names are lowercased + charset-validated + denylisted (never `authorization`/`cookie`/`x-forwarded-*`/`host` — so the strip middleware can't delete infra headers); object-ID is lowercased + strict-GUID-validated; array-valued identity headers are rejected; identity comes from headers only (never query/body).
- `authProvider` stored as `"entra-proxy"` must equal the `GROUP_MAPPING_PROVIDERS` entry (group-tag re-resolution) — `azureOid` is shared with `azureAuthService` (SAML) by design.
- The login route re-validates trust independently; the strip middleware is defense-in-depth, not the gate. All login failures redirect to `/login.html` (unprotected) so the app.ts auto-login can't loop.

**When changing this:**
- Never accept identity from an unauthenticated/untrusted path; keep the empty-allowlist and denylist checks. If you change header defaults, update `defaultIdentityHeaderNames` (the fail-closed strip set) in lockstep.

---

## services/blockService.ts

**What it owns:** IP block CRUD and metadata (name, tags, description), plus the `block.created` / `block.updated` / `block.deleted` audit Events (emitted in-service after each mutation resolves; create/update inputs carry `actor?`, deleteBlock takes `(id, actor?)`).

**Public API:** listBlocks, getBlock, createBlock, updateBlock, deleteBlock.

**Used by:** src/api/routes/blocks.ts (all CRUD operations), src/services/subnetService.ts (block parent lookups, overlap validation).

**Invariants:**
- Block deletion forbidden if any active reservations exist across child subnets
- CIDR must be normalized and unique
- IP version immutable after creation (v4 vs v6)
- Tags are optional arrays, filtered client-side in listBlocks
- Exactly ONE audit Event per mutation, fired `void` after the write resolves — never from the route layer (double-logging) and never before/inside the write (phantom on failure). `tests/integration/blocks.test.ts` asserts the one-per-mutation + zero-on-validation-failure contract.

**When changing this:**
- Verify deleteBlock's active-reservation cascade check (affects data integrity)
- Test CIDR normalization in createBlock (e.g., 10.1.1.5/24 → 10.1.1.0/24)
- Check block-listing performance if tag filtering is optimized

---

## services/capacityAdvisorService.ts

**What it owns:** Derives recommended worker counts, pool sizes, PostgreSQL settings, and queue mode from observable workload (monitored-asset count, per-cadence P90 work duration, integration load, observed peak connections, host RAM). Advisory by default; a Stage POST writes the env-driven levers.

**Public API:** `buildAdvisorState`, `recomputeAdvisorFromSnapshot`, `stageAdvisorState`, `summarizeAdvisorGaps`, `getCachedAdvisorState`, `percentile`, `roundUpToNearest`, `AdvisorState`, `AdvisorRecommendation`, `CadenceKey`, `AdvisorLeverKey`, `ApplyMode`

**Cross-service deps:** `prisma`, `AppError`, `setEnvVar`, monitor-work histogram reader (metrics), `queueService` (queue mode + names), `capacityService` (CapacitySnapshot), `logEvent`.

**Used by:** `src/api/routes/serverSettings.ts` (`GET /capacity-advisor`, `POST /capacity-advisor/stage`), `src/jobs/capacityWatch.ts` + `src/services/capacityService.ts` (`recomputeAdvisorFromSnapshot` in the capacity-watch loop).

**Invariants:**
- Never recommends shrinking — `changeRequired` only when recommended > current.
- Cold-start substitutes a fixed P90 when the work-duration histogram has too few samples.
- Handler-timeout-pressure fires when P90 approaches the pg-boss `expire_seconds` cap; some worker levers are blocked behind a queue-mode flip until restart.

**When changing this:**
- P90 math depends on the metric's histogram buckets — keep in sync with `src/metrics.ts`.
- PG tuning recommendations come from an external builder in `serverSettings.ts`; cadence intervals resolve through `capacityService.workload`.

---

## services/capacityDbIo.ts

**What it owns:** Pure disk-read-pressure rate math — samples `pg_stat_database.blk_read_time` and turns deltas into a normalized "backends continuously blocked in read()" rate, making the signal storage-medium-aware. Only meaningful when `track_io_timing = on`.

**Public API:** `deriveDbIoVerdict`, `DbIoReading`, `DbIoVerdict`, `MIN_IO_WINDOW_MS`, `IO_VERDICT_STALE_MS`, `DB_IO_WATCH_BACKENDS`, `DB_IO_WARNING_BACKENDS`

**Cross-service deps:** none.

**Used by:** `src/services/capacityService.ts` — reads the counter via Prisma, computes the verdict, and feeds watch-reason thresholds.

**Invariants:**
- First call or a window < `MIN_IO_WINDOW_MS` returns `measured:false` (don't alarm); a counter reset (current < prev) returns unmeasured.
- Rate = Δblk_read_time / Δelapsed; verdict goes stale after `IO_VERDICT_STALE_MS`.

**When changing this:**
- WATCH/WARNING backend thresholds are tunable module exports consumed by capacityService.

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
- Steady-state projection = base DB size – current sample table bytes + projected sample bytes (per monitored asset × rows/day/asset × retention × CALIBRATED `DEFAULT_BYTES_PER_ROW`). The per-row size is always the calibrated default, never the live-measured `avgBytesPerRow` (measured is relpages ÷ pg_stat tuples — unreliable on compressed/bloated hypertables; using it produced phantom 14–218 TB steady-states, 2026-06).
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

## services/appIconService.ts

**What it owns:** The PWA home-screen icon set, rasterized from the branding logo with `@resvg/resvg-js` (an SVG canvas of the target size embeds the source bitmap as a `data:` URI). Also owns `ICON_SPECS` — the allowlist `routes/pwa.ts` matches request paths against — and the icon-set version stamp used as the manifest's `?v=` cache-buster and the icon ETag.

**Public API:** `ICON_SPECS`, `findIconSpec`, `renderAppIcon`, `getIconSetVersion`, `resolveBrandingLogoFile`, `__resetIconCacheForTests`

**Cross-service deps:** `brandingService.getBranding` (source logo + defaults), `utils/imageMagic.detectImageMagic` (re-sniff on read), `utils/paths` (`UPLOADS_DIR`, `PUBLIC_DIR`), lazy `@resvg/resvg-js`.

**Used by:** `src/api/routes/pwa.ts` only (`GET /manifest.webmanifest` for the version, `GET /icons/:file` for the bytes).

**Invariants:**
- **Nothing here throws.** Every failure rung — unresolvable `logoUrl`, path outside `UPLOADS_DIR`, missing file, non-image bytes, WebP, resvg failure — degrades to the shipped `public/logo.png`. A branding mistake must not break the manifest or the icon a push notification renders with.
- The cache key includes the logo file's **mtime**. The upload route writes a FIXED filename (`custom-logo.png`), so `logoUrl` never changes on re-upload — mtime is the only invalidation signal and is load-bearing.
- `resolveBrandingLogoFile` takes the **basename** and then asserts the resolved path is still inside `UPLOADS_DIR`. The `branding` Setting row is operator-writable and is the only untrusted input in this service.
- The `@resvg/resvg-js` import is **lazy** (inside `renderAppIcon`) so a missing per-platform native binding degrades to the raw logo instead of failing module load and taking every route in the process with it.
- resvg cannot decode an embedded **WebP**, and the branding upload route accepts WebP — that fallback is expected behavior, not an error.

**When changing this:**
- Adding a variant/size means adding to `ICON_SPECS` (the route allowlist) AND to the manifest's `icons` array in `routes/pwa.ts`. Never let the route accept a caller-supplied size — resvg would allocate an unbounded canvas.
- The cache is process-local and assumes `POLARIS_ROLE=web` stays single-instance (`deploy/polaris-web.service` is not a templated unit). If web ever becomes multi-replica, this is still correct — just N caches instead of one.

---

## services/brandingService.ts

**What it owns:** The `branding` Setting row — `appName` / `subtitle` / `logoUrl` — plus `BRANDING_DEFAULTS`. Read-side only; the writers stay in the serverSettings routes.

**Public API:** `getBranding`, `BRANDING_DEFAULTS`, the `BrandingSettings` type

**Cross-service deps:** `prisma` (the `Setting` table), `utils/version.getAppVersion` (the `version` field on the response).

**Used by:** `src/api/routes/serverSettings.ts` (`GET|PUT /branding`, `POST|DELETE /branding/logo` — it also **re-exports `getBranding`** so the public `/branding` alias in `src/api/router.ts` keeps working via its dynamic import), `src/api/routes/pwa.ts`, `src/services/appIconService.ts`.

**Invariants:**
- Extracted from `routes/serverSettings.ts` precisely so services can read branding without importing a route module — do not reintroduce the reverse dependency.
- `getBranding` never throws on a missing row; it returns defaults.
- Writers (logo upload/delete, name/subtitle PUT) still live in the route and must keep writing the same three-key shape.

**When changing this:**
- Adding a branding field means updating the route's PUT schema too — and consider whether it belongs in the PWA manifest (`buildManifest` in `routes/pwa.ts`).
- Changing `logoUrl` semantics (e.g. non-fixed filenames) breaks `appIconService`'s mtime-based cache key — read that invariant first.

---

## services/certInfo.ts

**What it owns:** Single source of truth for the leaf cert nginx serves (`POLARIS_PROXY_CERT_PATH`). Layered cache (keyed on raw-file SHA-256) + last-known-good fallback tolerates the atomic-rename window during rotation. Exposes the SHA-256 fingerprint (agent pin), cert hostnames (URL inference), and expiry.

**Public API:** `getServerCertFingerprint`, `getServerCertHostnames`, `getServerCertExpiry`, `invalidateCache`, `__resetCertInfoCacheForTests`

**Cross-service deps:** none (node:fs, node:crypto, logger).

**Used by:** `src/api/routes/proxySettings.ts` + `src/api/routes/serverSettings.ts` (fingerprint/expiry display), `src/api/routes/assets.ts`, `src/services/agentInstallService.ts` + `src/services/agentAutoDeployService.ts` (stamp the pin into `agent.conf`), `src/services/nginxApplyService.ts` (post-rotate cache invalidation).

**Invariants:**
- All accessors are synchronous — 20+ callers rely on sync reads; never make them async.
- Read failures retry briefly and fall back to last-good so a transient read during rotation doesn't break agents mid-connection; repeat-failure warn logs are suppressed until success resumes.
- Fingerprint is `sha256:<hex>` of the cert DER, stable for agent pinning.

**When changing this:**
- If `POLARIS_PROXY_CERT_PATH` ever becomes mutable at runtime, the setter must call `invalidateCache`.
- `__resetCertInfoCacheForTests` is test-only — never call it from production code.

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

**What it owns:** Named-credential store for monitoring probes (SNMP v2c/v3, WinRM, SSH, REST API); type-specific config validation; secret masking on GET; merge-and-preserve logic for PUT to retain secrets when client resubmits mask. Also the credential-usage resolver (where is a credential wired across the monitor-settings tiers).

**Public API:** CredentialType, SnmpV2cConfig, SnmpV3Config, SnmpConfig, WinRmConfig, SshConfig, RestApiConfig, CredentialConfig, CredentialRecord, SaveCredentialInput, UpdateCredentialInput, CredentialUsage(+ CredentialUsageAsset / CredentialUsageClassGroup / CredentialUsageIntegrationGroup), stripSecrets, validateConfig, mergeConfigPreservingSecrets, listCredentials, getCredential, createCredential, updateCredential, deleteCredential, getCredentialUsageCounts, getCredentialUsage.

**Cross-service deps:** none.

**Used by:**
- src/api/routes/credentials.ts — GET /credentials, list (secrets masked)
- src/api/routes/credentials.ts — GET /credentials/usage, effective-usage asset count per credential (table column)
- src/api/routes/credentials.ts — GET /credentials/:id, fetch one
- src/api/routes/credentials.ts — GET /credentials/:id/usage, full usage breakdown grouped by tier (usage slide-in)
- src/api/routes/credentials.ts — POST /credentials, create
- src/api/routes/credentials.ts — PUT /credentials/:id, update (merge w/ secret preservation)
- src/api/routes/credentials.ts — DELETE /credentials/:id, revoke (fails 409 if effectively used or still referenced)
- src/api/routes/assets.ts — GET /assets/:id/resolve-monitor-setting, fetch credential for asset monitoring setup

**Invariants:**
- Secret fields (community, authKey, privKey, password, privateKey, passphrase, apiToken) are masked to "••••••••" on every GET; empty string and mask are treated as "preserve from stored value" on PUT. `publicKey` is deliberately NOT in that list — see services/windowsSshOnboardingService.ts.
- SNMP v2c requires community; v3 requires username + security level + auth/priv keys per level.
- SSH requires username + (password OR privateKey); WinRM requires both username + password. An SSH `passphrase` is rejected without a `privateKey` — it unlocks a key and means nothing alone, and catching it at save time beats a connect-time ssh2 parse error the operator has to decode. Both `ssh2.connect` sites attach it ONLY on the key path and only when non-empty.
- REST API requires baseUrl (http/https only, no trailing slash stored) + apiToken; verifyTls defaults false.
- Delete fails with 409 when the credential is effectively used or still referenced, via `getCredentialUsage` (NOT a hand-maintained column list). Effective usage covers all 8 per-stream Asset credential slots + the `monitorCredentialId` default, plus class-override and integration-default inheritance; a class/integration reference with no matching asset also 409s (deleting would silently SET NULL it). The FK columns themselves are ON DELETE SET NULL, so this guard is the only thing preventing silent unwiring.
- Credential-usage resolution is by FK wiring (asset stream → asset default → class-override stream → integration `config.monitorCredentialId`), NOT polling-method type-match — it answers "where is this configured." The eight stream slots (`CREDENTIAL_STREAMS`) are responseTime / cpuMemory / temperature / interfaces / lldp / customWidget / processes / eventLog; storage rides `interfaces`. The manual tier (Setting "manualMonitorSettings") carries no default credential, so manual assets resolve through asset + class tiers only.
- **Stamped-default reclassification:** discovery stamps the integration's credential onto each discovered asset's `monitorCredentialId` (buildClassMonitorStamp in discoveryEngine.ts), so by raw FK every discovered asset would read as "asset level." The usage resolver reclassifies a default whose value is a member of the asset's integration's credential set (`intCredSets` — every `*CredentialId` value in the integration config, collected by `collectCredentialIds`) as **integration level**. A per-stream slot match, or a default pointing at a credential the integration doesn't provide (or a manual asset), stays asset level. Counts are unaffected by the relabeling — only the slide-in grouping.
- validateConfig is called on CREATE and on PUT (after merge), catching type/field mismatches early.

**When changing this:**
- Test secret masking round-trip (GET → masked, PUT w/ mask → original preserved).
- Add new credential types: extend CredentialType union, add SECRET_FIELDS_BY_TYPE entry, add validateXxxConfig branch.
- Test all SNMP v3 security-level combos (noAuthNoPriv, authNoPriv, authPriv); validate protocol enums.
- Add a new per-stream credential slot: add it to `CREDENTIAL_STREAMS` so usage + the delete guard cover it (and to the schema on both Asset and MonitorClassOverride). Tests live in tests/unit/credentialUsage.test.ts.
- Verify REST API baseUrl normalization (trim, remove trailing slash, require http/https scheme).
- `SshConfig.publicKey` is NOT a secret and must stay out of `SECRET_FIELDS_BY_TYPE.ssh` — see services/windowsSshOnboardingService.ts.

---

## services/sshHostKeyService.ts

**What it owns:** Trust-on-first-use pinning for SSH SERVER host keys — the `SshHostKey` table, the verify/pin decision, the fingerprint + key-type parsers, and the operator list/delete.

**Public API:** `SshHostKeyRecord`, `HostKeyVerdict`, `fingerprintKeyBlob`, `keyTypeFromBlob`, `verifyOrPin`, `listHostKeys`, `deleteHostKey`, `_resetCaches`.

**Cross-service deps:** `db` (prisma), `eventLogService`, `utils/errors`, `utils/logger`.

**Used by:**
- src/utils/remoteExec.ts — `buildHostVerifier` (dynamic import), which feeds BOTH `ssh2.connect` sites: `withSshClient` (agent install/upgrade/uninstall, agentless process collection) and `monitoringService.probeSsh`
- src/api/routes/serverSettings.ts — `GET /agents/ssh-host-keys`, `DELETE /agents/ssh-host-keys/:id`
- public/js/agent-ssh-onboarding.js — the pinned-keys pane

**Invariants:**
- **Opt-in per credential** (`SshConfig.verifyHostKey`), default OFF. Absent the flag, `buildHostVerifier` returns null and ssh2 behaves exactly as it did pre-2026-08 (accepts any host key). This is the compatibility guarantee that lets the feature ship without breaking installs whose hosts were never pinned — do not flip the default without a fleet-wide pinning plan.
- **Fails closed.** A verification error rejects the connection. An operator who ticked the box must never get a silently-unverified connection.
- **A mismatch never overwrites the pin.** Overwriting would defeat the entire mechanism; the operator deletes the pin deliberately.
- Fingerprints are `SHA256:<base64, unpadded>` — byte-identical to `ssh-keygen -lf` so they can be compared by eye during an incident. Do not add padding or switch to hex.
- Pins are keyed `(host, port)` and live in their own table, NOT on `Credential.config`: host keys are per-host, one credential spans a fleet.
- **Hot path.** `withSshClient` runs on the per-minute agentless-processes cadence, so lookups are served from a module-level Map and `lastSeen` writes are throttled hourly. A cache hit that disagrees still re-reads the DB before rejecting — otherwise a just-deleted pin would be a permanent rejection on that process.
- `keyTypeFromBlob` is display-only and bounds the declared length before slicing; a malformed blob degrades to `"unknown"` rather than failing an otherwise-valid connection.
- Deleting a pin is audited at **warning** level — it re-opens first-use trust for that host.

**When changing this:**
- Mock-only tests cannot cover the handshake. Verify against a real `ssh2.Server`: pin → match → swap the server's host key → confirm refusal → delete the pin → confirm re-pin. (Attach an `error` handler to the SERVER-side connection in any such harness; the client drops mid-KEX when it refuses, and the resulting server-side event is otherwise unhandled and crashes the script.)
- Tests: `tests/unit/sshHostKey.test.ts` (18 cases, incl. the opt-in gate and fail-closed).
- Any new `ssh2.connect` call site MUST route through `buildHostVerifier`; there are deliberately only two.

---

## services/sshOnboardingScript.ts

**What it owns:** Pure generation of the SSH onboarding scripts an operator pushes to their fleet before Polaris can install the agent over SSH — a remediation + detection pair PER PLATFORM (Windows PowerShell, Linux bash) — plus the strict input validators that guard them. No I/O.

**Public API:** `SshOnboardingAccountMode`, `WindowsOnboardingScriptOptions`, `LinuxOnboardingScriptOptions`, `buildWindowsOnboardingScript`, `buildWindowsOnboardingDetectionScript`, `buildLinuxOnboardingScript`, `buildLinuxOnboardingDetectionScript`, `assertValidPublicKey`, `assertValidUsername`, `assertValidLinuxUsername`, `assertValidServerIp`.

**Cross-service deps:** `utils/errors` (AppError), `utils/cidr` (isValidIpv4 / isValidCidr).

**Used by:**
- src/services/windowsSshOnboardingService.ts — renders both scripts for `GET /server-settings/agents/windows-ssh/script`, and reuses the validators at config-save time so a bad value is rejected on save rather than on download.

**Invariants:**
- **Operator input is REJECTED, never escaped.** `username` / `polarisServerIp` / `publicKey` are interpolated into PowerShell an admin then runs FLEET-WIDE as SYSTEM — that is effectively RCE on every Windows endpoint, so the validators are allowlists (`/^[A-Za-z0-9._-]{1,64}$/`, optionally `DOMAIN\user`; a key-type + base64 + conservative-comment regex; an IPv4 address or CIDR). `psLiteral` doubling of `'` is belt-and-braces behind that, not the primary defense.
- The key-presence predicate (`POLARIS_KEY_PRESENT_FN`) is emitted into BOTH scripts from ONE constant. Detection must never drift from what remediation writes, or the pair oscillates.
- That predicate matches on the key BODY (algorithm + base64) and ignores the trailing comment, so a comment change does not append a duplicate line.
- The emitted script APPENDS to `administrators_authorized_keys` and never overwrites it — other keys in that file belong to someone else.
- ACLs and group lookups use well-known SIDs (`S-1-5-32-544`, `S-1-5-18`), never the localized names "Administrators"/"SYSTEM".
- `accountMode:"create"` + a `DOMAIN\user` name is a hard error: `New-LocalUser` cannot do it, and emitting a script that fails on every endpoint is worse than refusing at authoring time.
- An unsupported Windows build exits **0** (with an `unsupported:` marker) from both scripts. Non-zero would loop a detection/remediation pair forever against a device remediation cannot fix.
- Emitted PowerShell must stay idempotent — it runs on every boot under GPO and every cycle under a Remediation. The same applies to the bash: it runs on every config-management pass.
- **Linux specifics that are load-bearing, not decoration:** `~/.ssh` 700 + `authorized_keys` 600 + correct ownership (sshd silently refuses otherwise); `restorecon` for the SELinux context on RHEL-family (same silent failure); and the NOPASSWD sudoers drop-in, because the agent installer runs `sudo -n` — key auth alone cannot install an agent, so omitting it would just relocate the manual step.
- **The sudoers drop-in is validated with `visudo -cf` BEFORE `install`.** A malformed drop-in locks sudo out for EVERY user on the host, which is far worse than a failed onboarding. Never reorder those two steps.
- The Linux script deliberately does NOT install `openssh-server`: distro-specific package management, and a host you cannot already reach over SSH is not one this script was delivered to.
- Linux detection checks the account and the drop-in as well as the key (Windows detection checks only the key). Both extra facts are prerequisites the install genuinely fails without, and both are unambiguous here — no localization, no policy guessing.
- `assertValidLinuxUsername` is STRICTER than the Windows one: POSIX charset, lowercase-leading, ≤32 chars, and an explicit rejection of `DOMAIN\user` with a message saying why. Sharing one validator would either admit a value Linux cannot use or reject a valid Windows one.

**When changing this:**
- Re-run `tests/unit/sshOnboardingScript.test.ts` (39 cases; injection attempts, both account modes, firewall on/off, predicate sharing).
- Validate any change to the emitted script with the real parser, not by eye: `[System.Management.Automation.Language.Parser]::ParseFile(...)` for PowerShell, `bash -n` for the shell. TS template literals collide with BOTH — `${` is interpolation and bash uses `${VAR}` constantly, PowerShell uses `$` and backtick — so escaping mistakes are easy and silent.
- Better still, RUN the Linux script: `podman run --rm -v <dir>:/scripts:ro debian:bookworm-slim bash -c 'apt-get install -y sudo passwd && bash /scripts/polaris-ssh-onboarding.sh'`, twice, and confirm one key line, 700/600/440 modes, a locked password, and that `su - <user> -c "sudo -n id -u"` returns 0.
- Loosening a validator regex is a security change — re-check `psLiteral` still holds.
- Avoid `${` in emitted PowerShell (TS template-literal interpolation) and escape any literal backtick.

---

## services/windowsSshOnboardingService.ts

**What it owns:** The "Windows SSH Deployment" workflow on Integrations → Polaris Agent — generating/rotating the ed25519 deployment keypair, owning the Polaris-managed `ssh` Credential that stores it, and the non-secret card config in the `windowsSshOnboarding` Setting.

**Public API:** `WindowsSshOnboardingConfig`, `WindowsSshOnboardingState`, `SaveOnboardingConfigInput`, `OnboardingScriptKind`, `OnboardingScriptResult`, `MANAGED_CREDENTIAL_NAME`, `getOnboardingState`, `saveOnboardingConfig`, `generateKeypair`, `getOnboardingScript`, `sshPublicKeyFingerprint`, `_invalidateCache`.

**Cross-service deps:** `credentialService` (createCredential / getCredential / validateConfig), `sshOnboardingScript`, `settingsStore`, `eventLogService`, `db` (prisma), `ssh2` utils.

**Used by:**
- src/api/routes/serverSettings.ts — `GET|PUT /server-settings/agents/windows-ssh`, `POST /agents/windows-ssh/generate`, `GET /agents/windows-ssh/script`
- public/js/agent-ssh-onboarding.js — the card, via `api.serverSettings.agentWindowsSsh*`

**Invariants:**
- **The private key is never returned by any read path.** Only the public half + `SHA256:` fingerprint leave the service (the Web Push VAPID posture). There is deliberately NO escrow: losing `POLARIS_SECRET_KEY` means regenerate + re-run the script, which is why the generated script is idempotent.
- `SshConfig.publicKey` must stay OUT of `SECRET_FIELDS_BY_TYPE.ssh`. If it were masked, the onboarding script could not be re-rendered without rotating the key and re-touching every endpoint.
- Rotation **replaces** the credential config via `validateConfig` + a direct `prisma.credential.update`, NOT `updateCredential`. `mergeConfigPreservingSecrets` reads an empty string for a secret field as "keep the stored value" (that is what lets the edit modal round-trip a mask), so it cannot clear a stale `password` — and `remoteExec` silently prefers `privateKey`, making a leftover password dead config that still reads as a live secret in the UI.
- The key must be generated BEFORE `createCredential`: `validateSshConfig` requires a password or a private key, so an empty `ssh` credential cannot be created and keyed afterwards.
- `credential.ssh_keypair_generated` is stamped at **warning** level — rotating locks Polaris out of every endpoint until the script re-runs fleet-wide.
- A `credentialId` pointing at a row an admin deleted reads as "no keypair yet" (offer Generate), never a 500.
- Config is validated with the SAME validators the script generator uses, so bad input fails at save time rather than at download time.

**When changing this:**
- `POST /agents/windows-ssh/generate` must keep BOTH gates: `serverSettingsSystem:fullwrite` AND `credentials:write`. It mints a fleet-wide admin credential; the second gate is not redundant.
- Import ssh2's `utils` off the DEFAULT export. It is CommonJS and cjs-module-lexer surfaces `Client` but not `utils`, so a named import throws at module load under Node's ESM loader even though Vitest interops it fine.
- Tests: `tests/unit/windowsSshOnboarding.test.ts` (in-memory prisma double so credentialService's real validation/masking runs).

---

## services/dependencyTreeService.ts

**What it owns:** Fortinet dependency-DAG computation and multi-parent suppression semantics — assigns layers via BFS from FortiGate roots, prefers the most-physical edge per (child,parent) pair, and reconciles `Asset.dependencySuppressed` on the reconciler cadence.

**Public API:** `DependencyDetectedVia`, `DependencySource`, `DepAsset`, `DependencyEdge`, `LayerAssignment`, `buildDependencyEdgesFromInputs`, `assignLayers`, `evaluateSuppression`, `recomputeDependencyTree`, `reconcileDependencySuppression`, `propagateAfterStatusChange`, `SuppressionAssetState`

**Cross-service deps:** `prisma`, `interfaceTopologyService`, `logEvent`, `logger`.

**Used by:** `src/api/routes/integrations.ts` + `src/api/routes/assets.ts` (dependency test / admin endpoints), `src/services/monitoringService.ts` (suppression queries), `src/jobs/dependencyReconciler.ts` (reconciler tick), `src/jobs/backfillDependencyTree.ts` (migration).

**Invariants:**
- All-down semantics: an asset suppresses only when ALL effective parents are down/suppressed; unmonitored parents are transparent (walk continues to grandparents).
- **Unmonitored HA-standby parents are IGNORED, not transparent** (`SuppressionAssetState.isHaStandby`, populated by `reconcileDependencySuppression` from a narrow `fortinetTopology->>'haRole'='secondary'` firewall query): filtered from every parent set (top-level + the transparent-walk recursion) so a switch LLDP-cabled to both HA members suppresses on the primary's confirmed-down alone. The transparent rule's "no monitored ancestor = ok" would otherwise permanently veto suppression sitewide, since standbys are unmonitored by design (the flip-off sweep in discoveryEngine.ts). A MONITORED standby (operator opt-in) evaluates normally. Standby-only parent sets never suppress (safe post-failover transient).
- The dependency DAG has NO edge between HA members — both are layer-1 roots, so member↔member LLDP edges are same-layer and pruned. The asset-details tree panel shows the cluster's second box via the display-only `haPeer` field on `GET /assets/:id/dependencies` (resolved from `fortinetTopology.haPeerSerial`), NOT via a graph edge.
- Only a confirmed-down edge propagates — warning/recovering flapping does not.
- Operator override rows take precedence over computed rows; the admin Dependency-Test overlay (`dependencyTestUntil`) is a what-if that auto-expires + emits an Event.
- A `status="maintenance"` parent counts as down (test-overlay semantics, no grandparent walk-through) — UNLESS its schedule opted out (`MaintenanceSchedule.suppressChildren=false` → `SuppressionAssetState.maintenanceSuppressChildren=false`, OR-ed across the asset's open windows by `reconcileDependencySuppression`; a deleted-schedule window or a manual maintenance status with no windows defaults to suppressing), in which case the parent falls through to its frozen `monitorStatus`.
- `assignLayers` keeps only parent-edges (`parent.layer === child.layer - 1`); preferred edge is interface > lldp > mesh > controller.

**When changing this:**
- `propagateAfterStatusChange` is a latency optimization; `reconcileDependencySuppression` is the source of truth.

---

## services/deviceIconService.ts

**What it owns:** Operator-uploaded device icons (PNG/JPEG/WebP/SVG; 256KB cap raster, 32KB cap SVG; magic-byte check for raster, pattern-reject validation for SVG); bytes-in-DB storage. Every icon is keyed to (manufacturer, type-or-model); resolution priority is `manufacturer-model: <mfr>/<model>` → `manufacturer-type: <mfr>/<assetType>`. Manufacturer values canonicalized through `manufacturerAlias` map at both upload and resolution time.

**Public API:** `uploadIcon(), listIcons(), getIconImage(), deleteIcon(), loadIconResolutionCache(), resolveIconUrl(), validateUpload()`

**Cross-service deps:** `utils/manufacturerNormalize.normalizeManufacturer()` for alias-canonicalization of manufacturer values (both the standalone manufacturer scope and the manufacturer half of model:<mfr>/<model> keys).

**Used by:** `src/api/routes/deviceIcons.ts,56,83,105 — upload/list/delete CRUD + image serve`, `src/services/topologyGraphService.ts — icon resolution for topology switches/APs/firewalls/remote nodes (icon cache preloaded once per buildSiteTopology call)`

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
- Review topologyGraphService.ts topology rendering (resolveIconUrl call sites) if icon resolution priority changes — but priority is built once in `buildResolutionCandidates()`, so updates land in both sync and async paths together.
- Ensure upload route multer fileSize limit (256KB) stays at or above the raster MAX_ICON_BYTES constant. SVG's tighter MAX_SVG_BYTES is enforced inside validateUpload after multer accepts.
- Image-serve route: any new mimeType added to ALLOWED_MIME_TYPES that could execute (script-bearing text formats) needs the same CSP/nosniff treatment as SVG.
- Topology renderer style for `node[hasIcon=1]` in `public/js/topology-render.js` fills the node interior with white (`background-color: #ffffff`) so vendor logos pop against any basemap, and carries the status signal via a 5px `border-color: data(nodeColor)` ring instead of the fill. If you change the icon to full-bleed, drop the white fill and restore `background-color: data(nodeColor)` so the status hue isn't lost.
- Per-role `border-width` for `node[hasIcon=1]` must stay roughly 15% of the role's node `width` so the visible image lands at ~70% of the overall visual diameter. Today: fortigate 10/64, fortiswitch+remote-asset 7/44, fortiap 6/36. Change one without the other and the colored ring is either invisibly thin or so thick the logo disappears.

---

## services/descriptionSyncService.ts

**What it owns:** Description sync between Polaris and Fortinet devices (FMG + standalone FortiGate), gated per-integration by `config.syncDescriptions` (default off). **Polaris-primary:** a non-empty Polaris value always wins — pushed on save, re-asserted by every reconcile (device-side edits overwritten, audited); an empty Polaris field **adopts** the device value (`*.adopted` Event) — clearing the Polaris value is how an operator takes the device's. No conflict state (retired 2026-07 with the newest-wins merge; legacy `conflict` rows resolve by pushing the Polaris value). `Asset.descriptionSync.value` / `AssetInterfaceOverride.syncedValue` persist the last synced value (FMG-mirror bookkeeping + UI badge, not a merge base). Guard: a device-side clear never removes a Polaris value (push re-asserts). Surfaces: FortiGate `system/interface` description ↔ `AssetInterfaceOverride`; FortiSwitch per-port description (managed-switch child table via parent controller) ↔ `AssetInterfaceOverride` on the switch asset; device-level `Asset.description` ↔ FortiGate `system/global` alias / FortiSwitch managed-switch description / FortiAP wtp **`location`** (AP Manager's field — wtp `comment` is absent from FMG's copy, so installs strip it; confirmed on live FMG 7.x). FortiOS field shapes are flagged VERIFY-on-real-device in the header (alias cap, child-table PUT patch semantics — the wtp `location` cap is confirmed at 35 chars; the reconcile gates the FortiAP surface on the `location` attribute actually appearing in the wtp read).

**Public API:** `normalizeDescription`, `decideDescriptionSync(polaris, device): "none"|"push"|"adopt"`, `capDescriptionForTarget` + `DESCRIPTION_CAPS`, `pushInterfaceDescription`, `pushSwitchPortDescription`, `pushDeviceDescription` (all accept an optional pre-built `transport` + `currentDeviceValue` so the reconcile pass reuses its batched reads), `syncDescriptionsOnSave({assetId, scope: "interface"|"device", ifName?, actor?})`, `runDescriptionSyncForIntegration(integration): DescriptionSyncSummary` (summary carries `fmgMirrored`/`fmgMirrorFailed`).

**Cross-service deps:** reservationPushService (imports `buildTransportForIntegration` / `callFortiOs` / `classifyPushError` / `Transport` — never inline a new transport builder), fortimanagerService (`proxyQuery` — the FMG-DB mirror's JSON-RPC seam; detection itself lives in fortimanagerService as `detectCentralManagement`), eventLogService (`logEvent`).

**Used by:** src/api/routes/assets.ts (`PUT /:id/interfaces/:ifName/comment` → `syncDescriptionsOnSave(scope:"interface")`, response gains `sync: {attempted, status, error}`; asset PUT → `syncDescriptionsOnSave(scope:"device")` fire-and-forget when `description` changed; `GET /:id` exposes a derived `discoveredByIntegration.syncDescriptions` boolean — the raw config is stripped as it holds tokens); src/services/discovery/discoveryEngine.ts:syncDhcpSubnets Phase 13.7 (`runDescriptionSyncForIntegration`, gated on the toggle — zero cost when off). **Frontend enforcement of the 35-char FortiAP `location` cap:** public/js/assets.js caps the Description input `maxlength` to 35 (+ warning hint, and a defensive truncate-to-maxlength on save) only when `assetType==="access_point"` AND `discoveredByIntegration.syncDescriptions===true`; public/js/integrations.js fires a `showConfirm` (`onSyncDescriptionsToggle`) the moment the operator enables Description Sync, spelling out the AP cap (reverts the toggle on decline).

**Invariants:**
- Polaris-primary: a non-empty Polaris value pushes whenever the device differs (device-side edits overwritten, audited); an empty Polaris field adopts the device value. A device-side clear never removes a Polaris value (push re-asserts). The save-time path always pushes.
- Synced-value bookkeeping: a successful push/adopt (or a converged "none") stamps the value onto `Asset.descriptionSync.value` / `AssetInterfaceOverride.syncedValue` — consumed by the FMG mirror's device-agrees check and the UI badge. A failed push preserves the prior stamp.
- All device I/O goes through the shared Transport (both `useProxy` modes + standalone FortiGate). HA-secondary members are skipped (config replicates from the primary).
- Managed-switch addressing: the `switch-id` mkey is NOT reliably the serial — FortiLink setups rename it (e.g. to the hostname; confirmed on FortiOS 7.6.7, where a serial-keyed PUT 404s "Invalid url"). Serial-keyed entry points resolve the CMDB row by `switch-id` OR `sn` (`matchManagedSwitchRow` on the save-time pre-read; the reconcile keys its switch-row map by both), then address the device by the row's real mkey. The 63-char managed-switch/port description cap is confirmed on the same firmware.
- FMG central-management mirror: when discovery has stamped `Integration.config.centralManagement.{wtp,fsw}` (fortimanagerService.detectCentralManagement, run at FMG discovery start — primary signal: the ADOM's dvmdb `flags`, where the `per_device_wtp`/`per_device_fsw` flag being ABSENT means central; bit values decoded per-box from the `/dvmdb/adom` syntax dump via the pure `decodeCentralManagementFlags`, confirmed on a live FMG 7.x; the ADOM-level `obj/wireless-controller/wtp` / `obj/fsp/managed-switch` table probes supply the UI row counts and the fallback verdict), a successful device-side push for that class ALSO `update`s FMG's copy (`mirrorToFmg`, JSON-RPC via fortimanagerService.proxyQuery + read-back verify) — otherwise the next AP Manager / FortiSwitch Manager install reverts the device value. Mirror targets (confirmed on live FMG 7.x for wtp): FortiAP `location` in the controller FortiGate's DEVICE DB (`/pm/config/device/<fgt>/vdom/root/wireless-controller/wtp/<wtp-id>` — the per-AP rows AP Manager displays; the ADOM obj table is empty); FortiSwitch description / port description in the ADOM-level `obj/fsp/managed-switch` table (UNVERIFIED — inert on per-device-managed installs). **Never `set`** (would create objects FMG never had) **and never an install** (would push everything an FMG admin staged). Mirror failures log `asset.description.fmg_mirror_failed` warning Events and never touch device-side sync state; summary carries `fmgMirrored`/`fmgMirrorFailed`. The reconcile's `mirrorCentralDbDrift` batch pass (one FMG-table GET per class — per controller FortiGate for wtp) heals FMG-side drift for values the device already agrees on (pushedThisRun + stored synced-at-value state), so pre-mirror pushes and transient mirror failures converge. FMG's copy is a projection of the device value, not an edit surface: a staged-but-never-installed central-pane edit gets overwritten; an installed edit reaches the device and flows back through the normal adopt path.
- Best-effort, never throws to callers. Transport/read errors leave sync state untouched (quarantine-verify rule); only an actual failed PUT stamps `syncStatus="failed"` + `syncError` (prefixed `[permanent]`/`[transient]` via classifyPushError). `syncStatus` ∈ synced/failed/conflict.
- Every push verifies by read-back; mismatch = permanent failure.
- Clearing a Polaris value is local-only (no device-side delete): a cleared interface comment leaves the device description in place; a cleared `Asset.description` nulls `descriptionSync` and re-seeds from the device next discovery.
- No retry queue — the Phase 13.7 reconcile is the retry path, and is also where device-side edits are detected (adopt / conflict). DB writes only on change.
- Firewall transport deviceName resolves `fortinetTopology.deviceName` (FMG dvmdb name, stamped at discovery) before falling back to hostname; switches/APs route via `fortinetTopology.controllerFortigate`.

**When changing this:**
- Adding a synced surface: add the target kind + cap, a push function with read-back verify, the reconcile read + decision loop, and events; keep the Transport import (parity rule) and update the Description Sync tab copy in public/js/integrations.js.
- Test both FMG proxy and direct (bypass) modes plus standalone FortiGate; verify the FortiOS field shapes flagged in the header on a real 7.x device before relying on them in production.
- The interface-keying is name-only — a device-side rename orphans the override; don't "fix" this by adopting into renamed rows without a stable-ID design.
- Scale: the reconcile is a few CMDB GETs per FortiGate + work proportional to overrides with changed values. Keep it that way — no per-asset device calls, no unconditional DB writes.

---

## services/discoveryCancelWatchdog.ts

**What it owns:** The force-exit backstop for discovery cancellation. Armed when a run's abort signal fires, disarmed when `runDiscovery` reaches its finally. If the run hasn't unwound within the grace window (2 min), it logs the in-flight devices with ages, writes an `integration.discover.force_exit` Event, finalizes the `DiscoveryRun` row as `aborted`, and exits the process with code 1 (systemd `Restart=on-failure` / NSSM restart it).

**Public API:** `armDiscoveryCancelWatchdog` (returns the disarm fn), `formatStuckDevices`, `CANCEL_FORCE_EXIT_GRACE_MS`, `FORCE_EXIT_CLEANUP_TIMEOUT_MS`, `ActiveDeviceSnapshot`, `CancelWatchdogOptions`.

**Cross-service deps:** `discoveryRunState.finishRun`, `eventLogService.logEvent`, `logger` — all injectable via options for tests.

**Used by:** `src/services/discovery/discoveryEngine.ts` — `runDiscovery` arms it right after the heartbeat timer and disarms in the finally. One call site.

**Invariants:**
- Fires ONLY when armed (abort signal fired) and not disarmed — a run that cancels cleanly, completes, or errors never trips it.
- Exists for wedges the abort signal cannot reach (non-HTTP awaits, e.g. a lock-blocked Prisma query). Those keep the 60s heartbeat ticking, so the discoveryRunReaper never clears them either — this watchdog is the only automatic recovery.
- The pre-exit bookkeeping writes (Event, finishRun) are each raced against `FORCE_EXIT_CLEANUP_TIMEOUT_MS` — the DB may be the wedge; the exit must never be blocked by the hang it exists to break.
- Finalizing the row as `aborted` before exit clears the UI immediately (no reaper wait) and leaves `cancelRequested=true`, so a pg-boss redelivery of the interrupted job self-aborts at runDiscovery startup.

**When changing this:**
- Keep the grace ≥ the cancel poll interval (3s) with generous margin — a well-behaved abort must always beat the watchdog.
- The exit takes the whole process: fine for the discovery role, whole-app under `POLARIS_ROLE=all` / cursor-mode web fallback (same semantics as the operator /restart endpoint). Don't make the grace shorter without considering that case.
- The disarm call in runDiscovery's finally is load-bearing — if you restructure runDiscovery, a missing disarm means every cancelled run force-exits the process 2 minutes later.

---

## services/discoveryDurationService.ts

**What it owns:** Rolling discovery-duration tracking per integration (and per-FortiGate within FMG runs), baseline computation for slow-run detection, the threshold formula, and the auto-abort ceiling.

**Public API:** `recordSample`, `getBaseline`, `getBaselines`, `computeBaseline`.

**Cross-service deps:** none (reads/writes Settings key "discoveryDurationStats").

**Used by:** `src/services/discovery/discoveryEngine.ts` — slow-check baseline lookup (`checkForSlowRuns`, which reads both `thresholdMs` for the warning and `autoAbortMs` for the hard cancel) and record per-FG and overall run durations; `src/api/routes/integrations.ts` — the `GET /integrations` list endpoint attaches `discoveryBaseline` per row so the card UI can show an "Avg Discovery Time" sized against `pollInterval`. ~4 call sites.

**Invariants:**
- Only successful (non-aborted, non-errored) runs recorded; failed runs skip `recordSample()` to avoid poisoning the average. (This is why the auto-abort loop-breaker in `discoveryAutoAbortService` exists — an auto-aborted run can't refresh its own baseline.)
- Rolling window = 10 samples; new sample appends, list trims to last 10.
- Baseline requires ≥3 samples; returns null otherwise.
- Slow-run threshold = `max(avg + 2σ, avg × 1.5, avg + 60s)` — ensures headroom even on uniform fast runs.
- Auto-abort ceiling = `max(2× avg, thresholdMs)` — clamped to the slow threshold so the warning always fires at or before the abort, and tiny baselines keep the 60s floor instead of aborting at 2× a few seconds.
- Unit key is either integrationId (overall) or `${integrationId}:${fortigateDevice}` (per-FG).
- Stats are stored in Settings as `{ units: { [unitKey]: { samples: [ms], updatedAt } } }`.

**When changing this:**
- Test threshold formula on small sample sets (3–5 entries) to ensure floor (60s) prevents false positives.
- Verify window=10 balances responsiveness vs stability; too small (5) may be jittery, too large (20) may lag env changes.
- Check getBaselines() batch reads are correct (no off-by-one in map population).
- Confirm recordSample() ignores invalid input (negative ms, non-finite values).
- Test edge case: if all 10 samples are identical, stddev=0 and threshold should still be avg + 60s (floor wins).
- `autoAbortMs` must never drop below `thresholdMs` — checkForSlowRuns assumes the slow warning precedes any auto-abort.

---

## services/discoveryAutoAbortService.ts

**What it owns:** The loop-breaker state behind discovery auto-abort — after `checkForSlowRuns` cancels a run at its `autoAbortMs` ceiling, the NEXT overlong run is exempt (alternating abort/exempt) so a fleet that legitimately outgrew its baseline can complete once and re-baseline.

**Public API:** `decideAutoAbort` (pure), `evaluateAutoAbort`, `clearAutoAbortState`, `AutoAbortUnitState`, `AutoAbortDecision`.

**Cross-service deps:** none (reads/writes Settings key "discoveryAutoAbortState").

**Used by:** `src/services/discovery/discoveryEngine.ts` — `checkForSlowRuns` calls `evaluateAutoAbort` when an over-ceiling run is found (web/scheduler role); `runDiscovery`'s completed branch calls `clearAutoAbortState` alongside `recordSample` (discovery role). Cross-process coherence rides the Setting row.

**Invariants:**
- An entry exists only between an auto-abort and the next successful full (non-scoped) run; success deletes it.
- Exemption is granted to exactly one run (keyed by the run's `startedAt` ISO) and is stable across repeated 30s ticks; `granted: true` surfaces only on the first tick so the caller logs the skip Event once.
- If the exempted run never completes successfully, the following overlong run is aborted again (abort/exempt alternation) — the sequence can only end via a successful run or the runs dropping back under the ceiling.
- Scoped single-device runs never participate (checkForSlowRuns skips them before evaluating).

**When changing this:**
- Keep `decideAutoAbort` pure — it's the unit-tested core (`tests/unit/discoveryAutoAbortService.test.ts`).
- Any new terminal outcome in `runDiscovery` that records a duration sample must also clear this state, or the alternation logic will keep exempting/aborting against a baseline that's already fresh.
- The evaluate path only runs for over-ceiling runs, so Setting reads are rare — don't move it into the per-tick hot path for all runs.

---

## services/discoveryRunState.ts

**What it owns:** DB-backed live state for discovery runs (replaces the prior in-memory `activeDiscovery` Map). The discovery worker coalesces hot progress writes through a `RunAccumulator`; the web role reads the rows for the `/discoveries` list, slow-run detection, and cancel signalling.

**Public API:** `DiscoveryRunStatus`, `ActiveDeviceEntry`, `RunAccumulator`, `newRunAccumulator`, `upsertQueuedRun`, `markRunStarted`, `flushRunProgress`, `touchWorkerHeartbeat`, `finishRun`, `isRunActive`, `anyRunActive`, `isCancelRequested`, `requestCancel`, `listActiveRuns`, `persistSlowFlags`, `reapStaleRuns`, `DiscoveryRunRow`

**Cross-service deps:** `prisma`, `logger`.

**Used by:** `src/services/discovery/discoveryEngine.ts` (discovery control), `src/api/routes/integrations.ts` (`/discoveries` list + cancel + backup-restore guard), `src/api/routes/assets.ts` (`POST /:id/rediscover` pre-check via `isRunActive`), `src/jobs/discoveryRunReaper.ts` (stale-run reaping), `src/services/discoveryCancelWatchdog.ts` (`finishRun("aborted")` before force-exit).

**Invariants:**
- Hot progress is coalesced in the accumulator (mutates synchronously, flushes throttled + on terminal transitions); `flushRunProgress` / `touchWorkerHeartbeat` are best-effort and never kill a run on a transient DB hiccup.
- Slow-alert flags are owned by the web-role slow check, never touched by the worker flush; `createdAt` resets on every upsert so elapsed-time math reflects current run age.
- `reapStaleRuns` marks any queued/running row with a stale heartbeat as error.
- `scopeDeviceName` (single-FortiGate scoped re-discovery) is stamped by `upsertQueuedRun` and reset to NULL by the next run's upsert — it's part of the `base` reset object, so a full run never inherits a stale scope label.

**When changing this:**
- The worker heartbeat timer detects stalled phases — keep it shorter than the reaper's stale window.
- The heartbeat runs on a timer independent of progress, so a wedged-but-alive run heartbeats forever and the reaper never clears it — that gap is covered by `discoveryCancelWatchdog` (force-exit after a cancelled run overstays its grace), not by the reaper. Don't "fix" a stuck run by loosening the reaper.

---

## services/dnsService.ts

**What it owns:** Reverse (IP → PTR) and forward (hostname → A/AAAA) DNS lookup via three modes (standard/UDP, DoT/TLS, DoH/HTTPS); per-asset TTL caching; resolver configuration storage.

**Public API:** DnsSettings, PtrRecord, ARecord, ResolverLike, getDnsSettings, updateDnsSettings, createResolver, getConfiguredResolver.

**Used by:**
- src/api/routes/assets.ts — GET /assets/:id, resolve PTR names for associated IPs
- src/services/discovery/discoveryEngine.ts — resolve PTR during discovery (dispatched from POST /integrations/discover)
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

**Used by:** src/api/routes/integrations.ts — discovery trigger, test connection, manual Graph proxy query. src/services/discovery/discoveryEngine.ts — sync path syncEntraDevices.

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

## services/azureArcService.ts

**What it owns:** Azure Arc (Arc-enabled servers) discovery via Azure Resource Manager — `Microsoft.HybridCompute/machines`. The Connected Machine agent runs in the guest, so this source carries host truth (running OS SKU, real FQDN, live SMBIOS data, heartbeat status) rather than a directory record.

**Public API:** `testConnection(config)`, `proxyQuery(config, method, path, query?, body?)`, `discoverMachines(config, signal?, onProgress?)`, plus the pure helpers the unit tests drive: `normalizeSubscriptionId`, `buildArcMachinesQuery`, `buildArcVmInstancesQuery`, `buildArcSqlInstancesQuery`, `buildArcClustersQuery`, `normalizeArcCluster`, `buildArcClusterObservedBlob`, `normalizeVmUuid`, `swapVmUuidEndianness`, `parseArmResourceId`, `parentMachineIdFromExtensionId`, `normalizeArcMachine`, `normalizeArcVmInstance`, `normalizeArcSqlInstance`, `extractIpAddresses`, `inferArcAssetType`, `arcStatusIsConnected`, `matchesTagFilter`, `filterArcMachines`, `arcHostnameCandidates`, `buildArcObservedBlob`, `describeAadTokenError`, `extractArmError`, `throttleDelayMs`. Types `AzureArcConfig` / `DiscoveredArcMachine` / `ArcVmInstance` / `ArcSqlInstance` / `ArcDiscoveryResult`.

**Cross-service deps:** `src/utils/entraClientCredentials.ts` (the SAME token-request builder the Graph client uses — only the scope differs, at `https://management.azure.com/.default`; do not fork it), `src/utils/integrationFilter.ts -> matchesWildcard`, `src/utils/errors.ts -> AppError`.

**Used by:** `src/api/routes/integrations.ts` (config schema, `/:id/test`, pre-save `/test`, `/:id/query`), `src/services/discovery/discoveryEngine.ts` (`runPreflightTest`, the dispatch branch, and `syncArcDevices`).

**Invariants:**
- Token cached per `tenantId:clientId`; invalidated on 401 with exactly one retry. `testConnection` always invalidates first so it exercises the freshly-typed secret.
- **ONLY GUID-validated subscription ids are interpolated into the Resource Graph query.** Every other filter (resource group, machine name, tags) is applied client-side in `filterArcMachines` specifically so free-form operator wildcards never reach the query language. Do not "optimize" those into KQL without adding escaping and tests.
- `normalizeVmUuid` REJECTS the all-zero (and all-F) GUID. Some BIOSes report it; if those collapsed onto one map key every such machine would mass-merge into a single asset.
- `swapVmUuidEndianness` is involutive and BOTH variants must be indexed at match time. Windows, `dmidecode` and VMware disagree about byte-swapping the first three SMBIOS UUID fields, so the same machine can present either form — index one only and every Arc-on-VMware machine silently duplicates instead of merging.
- ARG and per-subscription rows must normalize IDENTICALLY (`normalizeArcMachine`); a unit test locks this. Drift means the two read paths mint different assets for the same machine.
- `proxyQuery` is host-pinned to `management.azure.com`, requires an `api-version`, and permits POST only to `/providers/Microsoft.ResourceGraph/resources`.
- API versions are module-level consts and are **verify-on-real-tenant**, as is the `detectedProperties` bag — its key names vary by Connected Machine agent version, so every read of it is optional-chained and case-tolerant.
- `fetchNetworkProfile` is ONE GET PER MACHINE: default off, concurrency-capped, deadline-bounded, and it reports what it skipped rather than silently truncating.
- The extension-resource enrichment (`enableVmInstances` / `enableSqlServer`) is **Resource-Graph-only and creates no assets**. Both fold into the owning machine's record. If you ever add a resource-provider fallback for them, remember why there isn't one: ARG costs one query for the tenant, the RP costs one GET per machine. The two parent links are NOT the same shape — VM instances nest under the machine id, SQL instances point at it via `properties.containerResourceId`.
- An extension row whose parent machine isn't in this run's result set is ORPHANED, not an error — the machine may simply have been filtered out.
- The serial bridge (`src/utils/hardwareIdentity.ts`) is what lets an Arc machine merge onto an AD-discovered asset — those two sources share NO definitive key otherwise. Matching on a raw serial is unsafe: `normalizeHardwareSerial` rejects vendor placeholders, and `indexUniqueBy` must ALSO drop serials claimed by two assets, because the agent's Windows fallback reports `SystemSKU` (a model SKU) when the real serial is empty. Never match on a serial without both guards; the failure mode is merging a whole model line into one asset, which is silent.
- Connected Kubernetes clusters (`enableKubernetes`) are the ONE Arc entity that becomes an asset in its own right — `assetType: "kubernetes_cluster"`, `sourceKind: "arc-k8s"`, synced by `syncArcClusters`. Adding that asset type is a THREE-WAY lockstep (migration + `BUILT_IN_ASSET_TYPES` + `BUILT_IN_SEEDS`); `seedBuiltInAssetTypes` skips seeds not in the built-in list, so two-of-three is a silent no-op on fresh volumes and restored backups. `tests/unit/arcAssetTypeLockstep.test.ts` guards it.
- Because the cluster class is a NEW asset type rather than a reused workstation/server one, it needs a `classBlockKeyForAssetType` arm, an `AddAsMonitoredAssetType` member, a `pickClassStreamsBlock` branch and **all three raw-SQL CASE expressions** in `monitorOverrideService`. That is the whole cost difference between Phase 4 and Phases 1–3.

**When changing this:**
- A new PROJECTED field needs three things in lockstep: the key in `buildArcObservedBlob`, an `arc` rule in `src/utils/assetProjection.ts` at a justified rank, and the `syncArcDevices` line that copies it out of the projection.
- A new per-class knob needs `AzureArcConfigSchema` in `src/api/routes/integrations.ts` + the readers in `public/js/integrations.js -> getArcFormConfig()`.
- Arc reuses the `workstationMonitor` / `serverMonitor` block names DELIBERATELY — most downstream registries key on the block name, not the integration type, which is why `monitorOverrideService`'s raw-SQL CASE expressions and `classToBlockKey` needed no change. Renaming those blocks would fan out across all of them.
- Field shapes are unverified against a live tenant. Capture a real response, **scrub it to synthetic all-zero GUIDs**, and freeze it as a fixture before trusting any new field.

**Related:** [cross-cutting/integration-type-onboarding](#cross-cuttingintegration-type-onboarding), `services/entraIdService.ts` (the shape this file mirrors), `services/vcenterService.ts` (the vmUuid cross-link counterpart).

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

## services/osEventLogService.ts

**What it owns:** The OS event-log → audit Event ingest. Transport-agnostic: curates host event-log entries (Windows Event Log channels / Linux journald / FortiOS device log) into `os_event.<channel>` audit Events (resourceType=asset) so they surface in the asset Events tab and ride the existing syslog/SFTP archival. **First and only external-event-ingestion path** — every other Event is Polaris-generated. Also owns the operator-tuned global config `Setting("agentEventLog")`.

**Public API:** `ingestOsEventLog(assetId, hostname, entries, cfg)` → `{accepted, suppressed}`; `getAgentEventLogConfig()`; `updateAgentEventLogConfig(patch)` (clamps + merges + persists, returns full config); `DEFAULT_AGENT_EVENT_LOG_CONFIG`; pure helpers `mapOsLevelToAudit` / `meetsMinAuditLevel` / `dedupeEntries` / `sanitizeChannel` / `buildAuditInputs`; types `AgentEventLogConfig` / `OsEventLogEntry` / `IngestResult`.

**Cross-service deps:** `eventLogService.logEventsBatch` (batched audit write); `prisma.event.count` (per-asset rolling-hour rate cap); `prisma.setting` (config read/upsert).

**Used by:** `src/api/routes/agents.ts:POST /samples` (the `eventLog` stream branch) + `GET /config` (ships the filter via `getAgentEventLogConfig`); `src/api/routes/serverSettings.ts` (`GET`/`PUT /server-settings/agent-event-log` → the Retention-tab **Agent OS Event Log** card). Later phases: the SSH / WinRM / FortiOS-REST pollers in `monitoringService.ts` call the same ingest so curated audit rows behave identically regardless of transport.

**Invariants:**
- Volume discipline (the audit Event table is NOT a hypertable): min-level filter → dedupe (collapse identical, sum count) → per-push cap (`maxPerPush`) → per-asset rolling-hour cap (`perAssetHourlyCap`). Overflow is summarized into ONE `os_event.suppressed` Event (no silent truncation).
- The agent already filters/dedupes/caps; this layer re-applies the same gates as defense-in-depth so a buggy or stale agent can't flood the audit log.
- `enabled` master switch lives on the caller side (the `/samples` branch drops when off) AND `minLevel` defends here; default config is OFF.
- Never throws — `logEventsBatch` swallows write errors, and the rate-cap COUNT failure falls back to the per-push cap rather than blocking ingest.

**When changing this:**
- New transport (SSH/WinRM/REST) feeding event logs: build the entry list to the `OsEventLogEntry` shape and call `ingestOsEventLog` — do NOT re-implement curation.
- Changing the action namespace (`os_event.*`) ripples to the Events-tab action filter + any operator-saved filters; keep it stable.

---

## services/agentCommandService.ts

**What it owns:** The agent command queue — the `AgentCommand` table + its lifecycle. Today the only queued action is `run_script` (agent-side automation script runs). Process/service start/stop/restart control was REMOVED (Satellite-posture change) — this module keeps only the shared fetch/report plumbing.

**Public API:** `fetchPendingCommands(managedAgentId)` (agent poll; marks sent atomically + flips linked run_script `AutomationScriptRun`s pending→running); `recordCommandResult(managedAgentId, commandId, success, error, resultState, output?)` (agent report → completes the command + the linked run + audit); type `AgentCommandView`.

**Cross-service deps:** `eventLogService.logEvent` (`automation.script.run`, generic `agent.command.*.result` fallback); `prisma.agentCommand`, `prisma.automationScriptRun`.

**Used by:** `src/api/routes/agents.ts` (bearer `GET /agents/commands` + `POST /agents/command-result`). Rows are ENQUEUED by `automationScriptService.requestScriptRun` (not this service).

**Invariants:**
- `fetchPendingCommands` flips pending→sent atomically so a slow agent (or a WS-wake + poll racing) doesn't double-execute the same command.
- `recordCommandResult` verifies the command belongs to the reporting agent (managedAgentId match).
- The agent refuses any non-`run_script` action; the server enqueues only `run_script`. A stale/foreign non-run_script row reaching `recordCommandResult` is audited generically, never as control.

**When changing this:**
- Near-real-time dispatch is via a `commands-pending` WS frame (`agentCommandWake.publishCommandWake` → `agentChannelService.wakeCommands`); the ≤20s `/commands` poll remains the source of truth + guaranteed floor. Don't make the WS frame authoritative.
- A new action would need: the enqueue path, the agent executor arm (`pollAndRunCommands` in `agent/cmd/polaris-agent/main.go`), and the result branch here — in lockstep. Process/service control is intentionally NOT here anymore.

---

## services/agentCommandWake.ts

**What it owns:** The cross-process "wake this agent" signal for near-real-time command dispatch. When a command is enqueued (from any process/role), this emits a Postgres NOTIFY so the process holding the agent's WS session pushes a `commands-pending` frame instead of the agent waiting out its ≤20s command poll.

**Public API:** `publishCommandWake(managedAgentId)` (best-effort `SELECT pg_notify(CMD_WAKE_CHANNEL, id)` via prisma — never throws); `CMD_WAKE_CHANNEL` constant (`polaris_agent_cmd_wake`).

**Cross-service deps:** `prisma.$executeRaw` (pg_notify); `logger`. Deliberately lightweight (no WS/pg-Client imports) so the enqueue side (`automationScriptService`, which runs in the monitor/all role) can import it without pulling the WS server.

**Used by:** `src/services/automationScriptService.ts` (`requestScriptRun` fires it after creating the agent `run_script` command). The LISTEN side is `agentChannelService.startCommandWakeListener` (web/all role) → `wakeCommands`.

**Invariants:**
- **Best-effort only** — a failed/missed NOTIFY just means the agent picks the command up on its next `/commands` poll (the guaranteed floor). Never let a wake failure block or fail the enqueue.
- NOTIFY works through PgBouncer; the paired LISTEN (agentChannelService) needs a session-pinned DIRECT connection — keep the two halves' transport assumptions aligned.
- Channel name is lowercase (unquoted-identifier fold) — `publishCommandWake` and the `LISTEN` must use the same literal.

**When changing this:** if another enqueue path (beyond script runs) starts creating `AgentCommand` rows, call `publishCommandWake` there too, or that path silently falls back to the poll latency.

---

## services/logFlagRuleService.ts

**What it owns:** User-defined log-flag rules (Feature C) — operator rules that FLAG matching process-log lines. Owns the `LogFlagRule` table, the compiled-rule cache, the read-time evaluator, and CRUD.

**Public API:** `evaluateLogFlags(assetId, name, rows, onlyFlagged)` (annotate log rows with matched rules); `listLogFlagRules` / `createLogFlagRule` / `updateLogFlagRule` / `deleteLogFlagRule`; `invalidateLogFlagRuleCache`; pure helpers `globToRegExp` / `compileRule` / `applicableRules`; types `LogFlagRuleRow` / `CompiledRule` / `LogFlagRuleInput` / `FlaggedLogLine`.

**Cross-service deps:** `eventLogService.logEvent` (audit `logflagrule.*`); `prisma.logFlagRule`.

**Used by:** `src/api/routes/logFlagRules.ts` (CRUD at `/api/v1/log-flag-rules`); `src/api/routes/assets.ts:GET /assets/:id/process-logs` (annotates returned lines via `evaluateLogFlags`; `?flagged=1` → only matches).

**Invariants:**
- **Read-time eval, no persisted flag** — flags are computed per fetch over the bounded log window, so a new/edited rule retroactively flags history and edits take effect on the next fetch (no backfill).
- The compiled-rule cache MUST be invalidated on every rule write (`invalidateLogFlagRuleCache` is called inside each CRUD) or stale rules apply.
- An invalid regex pattern compiles to a never-matching matcher (never throws on the read path).
- minLevel gate suppresses only when the line's level is KNOWN and below the floor; unknown level is not suppressed.

**When changing this:**
- New matchType: extend `compileRule` + the route Zod enum + the modal's match-type select in lockstep.
- Applying rules to OS event logs (Feature A) later: reuse `evaluateLogFlags` against those rows — the engine is transport-agnostic.

---

## services/eventLogService.ts

**What it owns:** The shared audit-event writer. `logEvent` (never throws; drops rows below the operator-configured min level; stamps `levelRank` at write time), `buildChanges` (before/after diff for `.updated` events), `LogEventInput`. Plus the discovery per-asset audit helpers: `snapshotMaterialAssetFields` (capture material fields before a discovery branch mutates the in-memory asset), `computeMaterialAssetChanges` (pure diff over the material-field whitelist), `logDiscoveryAssetCreated` (`asset.discovered`), `logDiscoveryAssetUpdated` (`asset.discovery_updated` — fires only when a material field changed), `DiscoveryAuditContext`.

**Public API:** `logEvent`, `buildChanges`, `LogEventInput`, `snapshotMaterialAssetFields`, `computeMaterialAssetChanges`, `logDiscoveryAssetCreated`, `logDiscoveryAssetUpdated`, `DiscoveryAuditContext`.

**Cross-service deps:** `eventArchiveService.getCachedRetentionSettings` (cached min-level read).

**Used by:** ~42 modules across routes / services / jobs. Most import via the back-compat re-export in `src/api/routes/events.ts`; new code should import from here directly so services never depend on the route layer. The discovery audit helpers are called from every asset create/update site in `discoveryEngine.ts` (firewall / FortiSwitch / FortiAP / Entra / AD update + create, plus FortiGate device-inventory endpoint create).

**Invariants:**
- `logEvent` must never throw — event logging can't be allowed to break the operation it audits. Failures are swallowed.
- `levelRank` is stamped here (0=info, 1=warning, 2=error); the Events list endpoint's `sortBy=level` depends on it.
- Sub-`minLevel` events are dropped silently (cached settings read, 60s TTL — accept staleness).
- The discovery audit MATERIAL_ASSET_FIELDS whitelist is the flood guard: discovery bumps `lastSeen` / fetched-at / monitor stamp every cycle on nearly every asset, so diffing those would write an event per asset per cycle (catastrophic at 2000 assets vs. 7-day Event retention). Only identity/classification/location fields are diffed; an unchanged pass emits nothing. The endpoint **update** path is intentionally NOT instrumented (it reassigns `macAddress` to the most-recently-sorted MAC each cycle → spurious diffs); only endpoint **create** is.

**When changing this:**
- The events.ts re-export must stay in lockstep (same symbol names) until the legacy importers are migrated.
- Anything that makes `logEvent` throw or block breaks every mutating route in the app — keep it best-effort.

---

## services/fortigateService.ts

**What it owns:** Standalone FortiGate REST API client & discovery (mirrors FMG scope—DHCP subnets, reservations, device inventory, interface IPs, managed FortiSwitches/FortiAPs, VIPs).

**Public API:** testConnection, fgRequest, proxyQuery, discoverDhcpSubnets, FortiGateConfig, plus re-exported DiscoveryResult & 6 DiscoveredXxx types from FMG.

**Cross-service deps:** fortimanagerService (imports DiscoveryResult shape + types; fortimanagerService imports fgRequest, testConnection, proxyQuery for proxy-mode device iteration).

**Used by:** src/api/routes/integrations.ts — test + manual proxy query, src/services/discovery/discoveryEngine.ts — discovery, src/services/monitoringService.ts — REST calls for uptime monitoring, src/services/reservationPushService.ts — direct REST push of DHCP reservations, src/services/assetQuarantineService.ts — direct REST push of quarantine targets.

**Invariants:**
- fgRequest is the low-level bearer-token auth layer; all per-device queries use it.
- discoverDhcpSubnets returns DiscoveryResult identical to FMG's shape so the discoveryEngine.ts syncDhcpSubnets pipeline handles both identically.
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

**Cross-service deps:** fortimanagerService (uses native FMG helpers `setFmgDeviceMetavarCoords` — Policy & Objects metadata-variable `dynamic_mapping` upsert — + `setFmgDeviceCmdbGuiCoords`), fortigateService (uses `fgRequest` for the standalone CMDB PUT).

**Used by:** src/services/discovery/discoveryEngine.ts:syncDhcpSubnets Phase 3 — fires once per FortiGate after the per-HA-member loop, gated on `pushGeocodedCoords` + geocode success + `coordsClose()` mismatch. Geocode coords come from either the SNMP sysLocation or the FMG address metavar (address wins; see the geo cross-cutting section).

**Invariants:**
- FMG mode writes BOTH per-device metavars AND CMDB GUI coords. Standalone FortiGate writes only CMDB. Single source of truth for routing — never inline another transport choice in callers.
- All FMG writes go through the native lane (no `/sys/proxy/json` wrapper) — they don't share the proxy-lane concurrency=1 constraint.
- Best-effort: per-target failures are collected into the returned `{ok, targets[], error?}` shape but never thrown. Audit events (`integration.coords.pushed` / `integration.coords.push_failed`) live at the caller in discoveryEngine.ts, not here.
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

**Used by:** src/services/discovery/discoveryEngine.ts:syncDhcpSubnets Phase 3 — gated on the integration's `fortigateMonitor.pullSnmpLocation` toggle. Fires ONCE per FortiGate per discovery cycle (NOT per HA member — cluster members share sysLocation by physical co-location).

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

**Used by:** src/api/routes/integrations.ts — test + manual proxy query, src/services/discovery/discoveryEngine.ts — discovery orchestration + realtime push via FMG, src/services/monitoringService.ts — FMG proxy REST for uptime monitoring, src/services/reservationPushService.ts — push DHCP reservations to FortiGate via FMG proxy/direct, src/services/assetQuarantineService.ts — push quarantine targets via FMG proxy/direct.

**Invariants:**
- Proxy mode (`useProxy: true`, default) clamps per-FortiGate parallelism to 1 because FortiManager drops parallel `/sys/proxy/json` connections. The FMG worker's proxy lane enforces that serialization; the per-device CMDB scrapes (interface config, DHCP CMDB, VIPs, geo coords, etc.) run concurrently on the worker's native lane, so per-device throughput is higher than the proxy-lane bottleneck alone would suggest.
- Direct mode (`useProxy: false`) requires valid fortigateApiUser/fortigateApiToken on the FMG integration; mgmt IPs come from either the warm cache (monitor-up firewall Asset rows) or `resolveDeviceMgmtIpViaFmg` for cache-cold/new devices. Cache-cold mgmt-IP resolves now run concurrently across the worker pool (native lane is unbounded) — fresh installs no longer pay the serial-resolve penalty before per-device discovery can start.
- All FMG-bound calls go through `rpc()`, which inspects the JSON-RPC payload's first param URL and routes to `getFmgWorker(integrationId).submitProxy` (when it's `/sys/proxy/json`) or `submitNative` (every other URL). Per-device direct-FortiGate calls do NOT touch FMG and fan out up to `discoveryParallelism` wide independently of the worker.
- Transport-level resilience (`rpcInner`/`rpcAttempt`): retries **transient** failures only — HTTP 5xx + network/timeout — up to 2 times with exponential backoff (500ms, 1500ms), serialized INSIDE the FmgWorker lane slot so the proxy lane stays concurrency=1 and a struggling FMG isn't piled on. **Permanent** failures fail fast with no retry: HTTP 401/403/404/405 and the FMG RPC `-11` surfaced by callers. Outward `AppError.httpStatus` stays 502 for every transport fault — the upstream HTTP code is encoded in the message and used only to decide retryability, never re-exposed to Polaris's own clients (a raw 401 would trip the frontend's session-expired logout). An external abort (integration re-saved) short-circuits without retrying. This is a transport-layer policy beneath the discovery callers; do NOT add a second app-level retry loop on top (see `fetchFortigateSysLocation` note).
- Projected CMDB `get` calls pass `loadsub: 0` to skip child-table loads (FMG API Best Practices Guide), EXCEPT where a child table is intentionally needed: `system/interface` (secondary-ip) and `firewall/vip` (mappedip + realservers — the latter is the Virtual-Server pool consumed by `parseVipServerInfo`). Do NOT add a `fields` list to the `/dvmdb/.../device` full-device-record fetch or `system/dhcp/server` — naming restricted fields like `latitude` makes this FMG authorize each field individually and fail the whole query with `-11`.
- Parity invariant: both FMG and standalone FortiGate return identical DiscoveryResult shape for sync pipeline compatibility.
- FortiAP `/api/v2/monitor/wifi/managed_ap` row parsing centralized in `src/utils/fortiapMonitorRow.ts` (`parseFortiapMonitorRow` + `FORTIAP_MONITOR_FORMAT`) — shared with the standalone FortiGate path. Captures IP / MAC (with `board_mac` fallback) / model (with `deriveFortiapModelFromSerial` for blank-model APs) / `apUplinkInterface` (from `wan_status[].interface` then LLDP `local_port`) plus the live telemetry snapshot (`cpu_usage` / `mem_free` / `mem_total` / `sensors_temperatures`) which feeds the AssetSource observed blob and the runtime AP REST telemetry collector. **Firmware version trust rule**: `os_version` is the live running firmware (canonical `FPxxx-vX.Y.Z-buildNNNN`); the `version` / `firmware_version` fields are CACHED display-format values that lag upgrades ("7.4.5 Build 0734", bare "FortiAP" placeholder — prod incident 2026-07) and are accepted only when they match the canonical shape (`isCanonicalFortiapVersion`). A row with no usable version yields `""` and `upsertFortinetInfraAssetSource` (discoveryEngine.ts) preserves the previous blob's `osVersion` instead of blanking it (absent ≠ wipe, LLDP-persist convention; applies to fortiswitch rows too).
- Step 3d.5's detected-device loop additionally builds `switchMacByName: Map<switch_id, mac>` from rows where `is_fortilink_peer===true` and stamps each managed FortiSwitch's `baseMac` field after the AP-attribution pass. Zero extra `/sys/proxy/json` calls — joined from the existing query response, so the FMG proxy lane stays at the same call count. Parity-mirrored in `fortigateService.ts` Chain C.
- Cache-miss fallback in processDevice's direct-mode branch: if a warm-cache dispatch fails, re-resolve via FMG worker and retry once at the freshly-resolved IP. Cleared via `cachedNames.delete(deviceKey)` so the loop never iterates more than twice.
- All FMG name-keyed in-memory state (`mgmtIpByDevice`, `cachedNames`, `warmDispatched`, `devicesByName`) keys on `fmgNameKey(name)` (lowercased). FMG-stored device names and FortiOS system-status hostnames can disagree in case for the same device; lowercasing the key on both write paths (warm-cache pre-populate + FMG-verify resolve) means the worker's lookup succeeds no matter which producer seeded the entry. Display names in log lines + Events still use original casing carried on the rawDevice / asset row.
- HA detection is **zero extra calls**: `extractHaFromFmgDevice(raw)` reads `ha_mode` + `ha_slave[]` directly off each `/dvmdb/adom/<adom>/device` record FMG already returns. The "current primary" is identified by matching `ha_slave[].sn` against `device.sn`; `idx === 0` is the fallback. Standalone devices return `{ haMode: "standalone", haMembers: [] }` so downstream code branches uniformly.
- Per-member health: `extractHaFromFmgDevice` also normalizes `ha_slave[].status` (numeric or string `1`=up / `0`=down; anything else → `status` undefined so unknown encodings degrade to "no signal", never a false alarm — verify-on-real-FMG) into `haMembers[].status`. The fortigateService Chain G stamps `status:"up"` for every ha-peer-listed member (listing IS liveness there; a dead member drops out of ha-peer entirely and falls to the Phase 2a sweep). Consumed by the discoveryEngine.ts firewall fan-out: `fortinetTopology.haMemberStatus` + the standby-only display `haClusterIp`, the `asset.ha.standby_down`/`asset.ha.standby_restored` Events (suppressed for offline-in-FMG cached reads and for primaries), and the frontend Standby / Standby Down pill. `haClusterIp` must NEVER be promoted to `Asset.ipAddress` — the standby's null IP is what keeps IP-keyed dedup/probe/reservation paths from cross-matching cluster members.
- Direct-mode HA precedence: when FMG's `ha_slave[]` is populated, it wins over fortigateService's `ha-peer`-derived view (FMG's view is stable across failover; ha-peer reflects whichever physical box is currently active and would flip on failover).
- `DiscoveryResult.knownDeviceNames` preserves FMG-side casing (whatever `/dvmdb/adom/.../device` returned). The downstream Phase 2 / 2a roster check in `discoveryEngine.ts:syncDhcpSubnets` builds a lowercase `knownDeviceNamesLc` view and compares lowercase-on-both-sides, AND prefers `knownFirewallSerials` over the hostname check entirely — same device, same chassis, different name casing is a real-world FMG-vs-FortiOS condition (FMG-stored "evansville-fw-1" vs FortiOS-returned "EVANSVILLE-FW-1"). If you add a new consumer of `knownDeviceNames`, normalize the same way.
- `testRandomFortiGate` Fisher-Yates-shuffles the filtered device list and walks up to `MAX_RANDOM_FORTIGATE_ATTEMPTS = 2` entries — so one offline/in-maintenance gate doesn't fail the whole direct-transport test when the rest of the fleet is healthy. Only the per-gate steps (`resolveDeviceMgmtIpViaFmg` + `fgTestConnection`) retry; FMG-level failures (device list fetch, empty/filtered-out ADOM, missing mgmt interface) are returned as-is on the first try. The response carries an `attempts: string[]` listing every gate name tried so callers can surface "initial pick failed; backup pick succeeded" or "also tried: X" in the UI.
- **Scoped re-discovery** (`discoverDhcpSubnets`'s trailing `scopeDeviceName?` param, from `POST /assets/:id/rediscover`): the roster is narrowed to the one matching device (case-insensitive `fmgNameKey` on name/hostname) AFTER `filterDevices` and AFTER the raw roster is captured into `knownDeviceNames` — so the returned `knownDeviceNames` still carries the whole fleet and nothing outside the scope can ever look "removed" downstream. No match THROWS (message distinguishes roster-miss from filtered-out); the scoped progress log must keep the `Found 1 managed device` phrasing (the run accumulator regex-parses `totalDevices` out of it). The caller (`runDiscovery`) is responsible for finalizing in `"finalize-scoped"` mode — this service only narrows.

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

**Used by:** src/services/topologyGraphService.ts — topology graph for Device Map (map.ts's sites/:id/topology endpoint); src/services/dependencyTreeService.ts — Phase 12 of FMG/FortiGate sync via `recomputeDependencyTree`.

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
- Test cross-site edge rendering (remoteAssets for peers outside seed set) in topologyGraphService.ts.
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

## services/manufacturerProfileService.ts

**What it owns:** CRUD + cached resolver for the editable per-manufacturer telemetry profiles (metric rows, per-metric overrides, custom widgets). A synchronous `getProfileFor` serves the hot probe path after a boot warm-up.

**Public API:** `MetricKey`, `MetricRowType`, `MetricOverrideRow`, `MetricRow`, `CustomWidgetRow`, `ProfileSummary`, `ProfileFull`, `refreshProfileCache`, `getProfileFor`, `listProfiles`, `getProfile`, `createProfile`, `updateMetricRow`, `createOverride`, `updateOverride`, `deleteOverride`, `createWidget`, `updateWidget`, `deleteWidget`, `deleteProfile`, `STD_MIB_KEYS`, `METRIC_KEYS`

**Cross-service deps:** `prisma`, `normalizeManufacturer`, transform/combiner-kind guards, `AppError`, `logger`.

**Used by:** `src/api/routes/manufacturerProfiles.ts` (full CRUD), `src/api/routes/assets.ts` (profile read), `src/services/monitoringService.ts` (metric resolver), `src/jobs/seedManufacturerProfiles.ts` + `src/jobs/backfillManufacturerProfileMemoryComposition.ts`.

**Invariants:**
- Metric row type gates transform validity (scalar/table take a unary transform; double_scalar takes a combiner); override rows always carry a symbol while metric rows may be unconfigured (null = use built-in seed).
- `defaultMibId` and `defaultMibStdKey` are mutually exclusive; `modelPattern` is operator regex (validated + length-capped).
- The cache `getProfileFor` reads is keyed by normalized-lowercase manufacturer and returns null until the boot warm-up completes.

**When changing this:**
- `touchProfile` (updatedAt bump) is best-effort and must not fail the operation.

---

## services/mibParserUtils.ts

**What it owns:** Shared ASN.1/SMI comment stripper — collapses comments to whitespace (preserving line numbers) and is string-literal aware.

**Public API:** `stripComments`

**Cross-service deps:** none.

**Used by:** `src/services/mibService.ts` and `src/services/oidRegistry.ts` (SMI text parsing).

**Invariants:**
- Comments become space/newline equivalents (not deleted) so line numbers stay correct for parser errors; both `--…<newline>` and `--…--` styles handled; `--` inside quoted strings is preserved.

**When changing this:**
- Test pathological cases: nested/escaped quotes, comment at EOF.

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

## services/monitorOverrideService.ts

**What it owns:** Monitor-override semantics — `Asset.monitorOverride` is an **explicit operator-intent bit** (true when an operator deliberately set `monitored` away from the owning integration's per-class `addAsMonitored` default), so discovery sweeps don't clobber operator intent. Crucially it is WRITTEN only at operator-action time and never re-derived from incidental divergence.

**Public API:** `AddAsMonitoredAssetType`, `getAddAsMonitoredFromConfig`, `computeMonitorOverride`, `resolveMonitorOverride`, `classBlockKeyForAssetType`, `snapshotAddAsMonitoredByAssetType`, `recomputeMonitorOverrideForAssets`, `sweepMonitoredForIntegration`, `buildMonitoredSweep`, `AUTO_MONITOR_ASSET_TYPES`

**Cross-service deps:** none (pure helpers + raw SQL via the caller's prisma).

**Used by:** `src/api/routes/assets.ts` (status-pill toggle / `PUT /assets/:id` → `recomputeMonitorOverrideForAssets`; `POST /assets/:id/monitor-override/reset` → `getAddAsMonitoredFromConfig`), `src/api/routes/integrations.ts` (save flow `sweepMonitoredForIntegration` + preflight `snapshotAddAsMonitoredByAssetType`), `assetGhostMergeService.ts` + `assetMergeService.ts` (`recomputeMonitorOverrideForAssets` after a merge carries `monitored=true` onto the survivor — the carry-over IS operator intent, so the bit must follow it).

**Invariants:**
- `monitorOverride` is written ONLY by operator write paths and the reset endpoint. NOTHING re-derives it from incidental state (no boot job, no integration-save recompute) — incidental divergence (decommission clamp, created-before-flag-enabled, HA standby) leaves it false so the next discovery sweep self-heals the asset. (This is the explicit-intent fix; the prior convergent model's every-boot/every-save re-derivation stranded such assets.)
- Operator write paths capture intent as `monitored XOR addAsMonitored` at action time; re-aligning monitored to the flag clears it on the same write.
- Only five asset types participate (`firewall` / `switch` / `access_point` / `workstation` / `server`); each maps to a type-specific config block (`fortigateMonitor` / `fortiswitchMonitor` / `fortiapMonitor` / `workstationMonitor` / `serverMonitor`).
- `sweepMonitoredForIntegration` leaves `override=true` assets alone (operator pins win) and otherwise sets `monitored` per the class flag; it does NOT recompute overrides — a flag flip respects pins.
- **HA-standby exception (firewall class):** an asset whose `fortinetTopology->>'haRole' = 'secondary'` has an effective default of `false` regardless of `fortigateMonitor.addAsMonitored` — encoded as a nested CASE in BOTH raw-SQL statements (`recomputeMonitorOverrideForAssets` + `sweepMonitoredForIntegration`, SET and WHERE clauses), in the reset endpoint (`assets.ts` forces `flag=false` for standbys), and in the auto-monitor preflight (standbys exempt from counts). This is what makes an operator's deliberate monitored=true on a standby compute override=true and survive the discovery flip-off sweep in `buildFortigateMonitorStamp` (discoveryEngine.ts), which sweeps override-false standbys to `monitored=false, consecutiveFailures=0` every cycle (covers failover role flips — the ex-primary must not keep burning probe slots on an IP-less row).

**When changing this:**
- The raw-SQL JSON-path block keys must stay in sync with `classBlockKeyForAssetType` and the cutover migration.
- The HA-standby `haRole='secondary'` CASE must stay in sync across all four sites (two SQL statements × SET/WHERE, the reset endpoint, the preflight) AND with `buildFortigateMonitorStamp`'s standby branch.
- Do NOT re-introduce a job/handler that recomputes `monitorOverride` across all assets — that is the bug the explicit-intent model fixed.

---

## services/monitoringService.ts

**What it owns:** Asset health monitoring via probes, telemetry collection, and state machine transitions across five monitor states (unknown → recovering → up → warning → down).

**Public API:** `probeAsset`, `resolveMonitorSettings`, `resolveMonitorSettingsWithProvenance`, `recordProbeResult`, `recordTelemetryResult`, `recordHardwareSensorResult`, `recordSystemInfoResult`, `recordFastFilteredResult`, `collectTelemetry`, `collectHardwareSensors`, `collectFastFiltered`, `collectSystemInfo`, `collectLldpOnlyFortinet`, `collectLldpOnlySnmp`, `persistManagedApLldpNeighbors`, `invalidateLldpMatchCache`, `fortilinkInterfaceNamesFromCmdb`, `snmpWalkRaw`, `probeCredentialAgainstHost`, `getMonitorSettings`, `updateMonitorSettings`, `invalidateMonitorSettingsCache`, `getAdMonitorProtocol`, `runProbeFor`, `runTelemetryFor`, `runSystemInfoFor`, `runFastFilteredFor`, `runMonitorPass`, `runRetentionPrune`, `RETENTION_PRUNE_INTERVAL_MS`, `RetentionPruneResult`, `pruneMonitorSamples`, `pruneTelemetrySamples`, `pruneSystemInfoSamples`, `ProbeResult`, `MonitorTierSettings`, `MonitorOverrideSettings`, `ResolvedMonitorSettings`, `AssetMonitorContext`, `ProvenanceTier`, `ResolvedSettingsWithProvenance`, `TelemetrySample`, `InterfaceSample`, `StorageSample`, `HardwareSensorSample`, `IpsecTunnelSample`, `LldpNeighborSample`, `SystemInfoSample`, `CollectionResult`, `SnmpWalkRow`, `SnmpWalkResult`, `MonitorCadence`, `CadenceOutcome`.

**Cross-service deps:** `fortigateService.ts`, `fortimanagerService.ts`, `timescaleService.ts`, `oidRegistry.ts`, `vendorTelemetryProfiles.ts`.

**Used by:** `src/app.ts` — boot timescale detection; `src/api/routes/credentials.ts` — probe credential testing; `src/services/discovery/discoveryEngine.ts` — AD monitor protocol selection + managed-ap LLDP persist during FMG/FortiGate discovery sync (`persistManagedApLldpNeighbors` per online FortiAP, `invalidateLldpMatchCache` once before the AP loop so switches created in the same run resolve as matched assets); `src/api/routes/integrations.ts` — monitor-settings cache invalidation on config save; `src/api/routes/assets.ts` — effective monitor settings + probe request; `src/services/monitorSettingsService.ts` — cache invalidation on tier writes; `src/jobs/monitorAssets.ts` — core monitor loop dispatch; `src/jobs/migrateMonitorSettingsHierarchy.ts` — cache invalidation; `src/services/capacityService.ts` — monitor settings for capacity calculation.

**Invariants:**
- **Four-tier resolver:** per-asset overrides (top) → class override → integration/manual tier → hardcoded floor. Call `invalidateMonitorSettingsCache(scope)` after any tier-3 or tier-2 write to refresh `resolveMonitorSettings()` on next call. The eight cadence/timeout fields (`intervalSeconds`, `cpuMemoryIntervalSeconds`, `temperatureIntervalSeconds`, `systemInfoIntervalSeconds`, `probeTimeoutMs`, `cpuMemoryTimeoutMs`, `temperatureTimeoutMs`, `systemInfoTimeoutMs`) cascade through every tier; `failureThreshold` and the three retentions stop at tier-2 (class override). CPU/memory and temperature dispatch independently: `collectTelemetry` consumes `cpuMemoryPolling` / `cpuMemoryTimeoutMs` / `cpuMemoryCredentialId` / `cpuMemoryMibId` and `collectHardwareSensors` consumes `temperaturePolling` / `temperatureTimeoutMs` / `temperatureCredentialId` / `temperatureMibId`, each opening its own SNMP session or FortiOS REST call. `runTelemetryFor` runs both in parallel each telemetry tick — they still share the telemetry cadence trigger (`cpuMemoryIntervalSeconds`); an independent `temperatureIntervalSeconds` timer is a future follow-up.
- **systemInfoIntervalSeconds linkage to integration.pollInterval:** when the integration tier doesn't explicitly set this field, `loadIntegrationTierSettings` derives the cadence from `integration.pollInterval × 3600` and stamps `tierSystemInfoFromPollIntervalCache.set(integrationId, true)`. `resolveMonitorSettingsWithProvenance` reads that sidecar cache and labels the field's provenance `"integrationPollInterval"` (the fifth ProvenanceTier value). Cache invalidation clears the sidecar alongside `tierCache`. Manual-tier orphan assets are not eligible — they fall through to the hardcoded floor. Both halves of the linkage must move together: changing the resolver without bumping the migration job (`migrateSystemInfoCadenceLinkage`) leaves existing 600s defaults frozen; changing the migration job without the resolver derivation leaves nulls that revert to the floor.
- **Five-state machine:** unknown → (cs≥threshold) recovering, (cf≥threshold) warning; recovering → (cs≥threshold) up, (cf≥threshold) down; up → (cf=1) warning, (cf≥threshold) down; warning → (cs≥threshold) up, (cf≥threshold) down; down → (cs=1) recovering, stay down.
- **Heavy-cadence suppression:** telemetry/systemInfo/fastFiltered run only when `monitorStatus === "up"`; all other states suppress to avoid unreliable samples.
- **Per-transport dispatch:** probes dispatch on polling method (rest_api → probeFortinet/probeFortinetController; snmp → probeSnmp; winrm → probeWinRm; ssh → probeSsh; icmp → probeIcmp). REST API probes to `/api/v2/monitor/system/status`; SNMP probes `sysUpTime` OID.
- **Per-host SNMP gate:** every SNMP path (probeSnmp + the `withSnmpSession` helper that fronts collectTelemetrySnmp / collectSystemInfoSnmp / collectLldpNeighborsSnmp / operator snmpWalkRaw) acquires a per-`host:port` FIFO lock so probe and heavy walks don't overlap on a single-threaded agent. Without it, a 10-min systemInfo IF-MIB+LLDP walk pins the agent and the cheap sysUpTime probe stretches from <50ms to 3-5 s (often past the probe timeout → reads as packet loss). Keyed on host:port not assetId so two assets sharing one SNMP target don't collide. FortiOS REST and FMG calls aren't routed through this gate — they have their own concurrency models. **probeSnmp resets `start = performance.now()` inside the gate's callback** so the reported `responseTimeMs` reflects only the device round-trip, not the FIFO wait behind a concurrent walk — otherwise probes queued behind a 20 s fastFiltered IF-MIB walk reported as ~20 s on the chart, producing a perfect zig-zag against the bare-probe ~2 ms samples.
- **SNMP walk loop guard:** both walk paths (internal `snmpWalk` + operator `snmpWalkRaw`) run every raw varbind through `makeOidMonotonicGuard` (`src/utils/oidCompare.ts`) and abort with an AppError 502 the moment the agent returns an equal-or-lower OID — net-snmp's subtree/walk re-anchors on the last varbind with no non-increasing check (and its `backwardsGetNexts` strict mode passes EQUAL OIDs), so a broken agent that echoes the queried OID back on GETBULK (field case: ControlByWeb X-4xx) would otherwise loop forever. The guard runs BEFORE the internal walk's `baseOid.` prefix filter — an echoed base OID never matches the prefix, so `out` never grows, the `SNMP_WALK_MAX` cap never trips, and the walk would hold the per-host SNMP gate indefinitely. Both cap/guard exits return `true` from the feed callback so the underlying net-snmp walk actually halts instead of continuing in the background until session close.
- **vendorTelemetryProfiles + oidRegistry consumers:** collectTelemetry/collectHardwareSensors/collectSystemInfo/collectLldpOnlySnmp call `pickVendorProfile()` and `resolveOidSync()` for SNMP walks; boot calls `ensureRegistryLoaded()` for warm cache.
- **Credential fallback chain:** asset-level credential → integration-stored token/SNMP → inherited from FMG on FMG-discovered firewalls.
- **Sample writes are async-buffered, status writes are synchronous.** The seven append-only sample tables (asset_monitor / asset_telemetry / asset_hardware_sensor / asset_interface / asset_storage / asset_ipsec_tunnel / asset_perf_sla) go through `sampleWriteBuffer.enqueue*` and flush every 2 s. `Asset.update` for `monitorStatus` / counters / `last*At` and the per-asset `$transaction` for `assetAssociatedIp`, `persistLldpNeighbors`, `persistSdwanRules` (current-state SD-WAN rules), and `persistMclagPeers` (current-state MCLAG ICL peers) stay synchronous because they need read-modify-write or per-asset replace semantics that an append-only buffer can't provide. Future contributors adding a new cadence must NOT batch the asset.update — the state machine reads counters then writes new ones, and batching would break that. **These synchronous system-info persists are wrapped in `retryOnDeadlock`** (the `assetAssociatedIp` delete+insert `$transaction`, the LLDP/wireless `deleteMany`s, and the wireless endpoint-stamp `$transaction` that updates OTHER assets' `lastSeenAp`). They can lose a 40P01 deadlock against a concurrent system-info pass or the probe-patch bulk `Asset` UPDATE; the bulk LLDP/wireless upserts were already retried, but these were not, and the loser crashed the entire scrape (`runSystemInfoFor` → "System info collection crashed", ~126/day observed on the split-role monitor). Each op is idempotent (full-replace / last-write-wins) so re-run on deadlock is safe. **The wireless endpoint-stamp updates are additionally sorted by asset id** so every concurrent endpoint-stamp `$transaction` acquires its `assets` row locks in the same order — the PG deadlock log showed a 3-way cycle whose three participants were ALL exactly this `lastSeenAp` UPDATE (APs with overlapping matched-endpoint sets locking in different Map-insertion order). Ordering makes that cycle impossible; retryOnDeadlock is the backstop for any residual cross-path collision (e.g. vs the probe-patch bulk Asset UPDATE).
- **One Asset findUnique per probe.** `probeAsset(assetId, out?)` populates `out.snapshot` with the asset row it already loaded (with credential + integration includes). `recordProbeResult(assetId, result, preloadedAsset?)` accepts that snapshot to skip its own findUnique. Hot-path callers (runProbeFor) pass the out-object; the operator /probe-now route doesn't bother and pays the extra read.
- **FortiLink LLDP exclusion (`config.excludeFortilinkLldp`, default off).** The system-info dispatch (`resolveAndCollectSystemInfo`) drops `data.lldpNeighbors` whose `localIfName` is a FortiLink interface before returning, when the owning integration's toggle is on. FortiGate firewalls only (`isFortinetSrc && !isManagedSwitchOrAp`). The FortiLink set is authoritative from the CMDB `fortilink` flag via the pure `fortilinkInterfaceNamesFromCmdb` (fortilink-flagged interfaces + their member ports). The REST-interfaces path reuses CMDB already fetched in `collectSystemInfoFortinet` (`SystemInfoSample.fortilinkInterfaces`, always `[]`+ on the REST path); the SNMP-interfaces path leaves it `undefined` and the dispatch makes one gated CMDB call (`fetchFortilinkInterfaceSet`) only when the toggle is on — `undefined` vs `[]` is the signal for which path ran. Added to BOTH `FortiManagerConfigSchema` + `FortiGateConfigSchema` (parity) and read in the create + FMG/FortiGate-edit `monitorSettingsFormHTML` opts → rendered as a checkbox on the FortiGate LLDP stream subtab (`public/js/integrations.js`, `_readExcludeFortilinkLldpToggle`). Peer-inferred FortiLink rows (`peerInferredLldpService`) are unaffected.
- **IPsec CMDB-only synthesis.** `collectIpsecTunnelsFortinet` appends a synthetic row (status `down`, or `dynamic` for dial-up templates; `parentInterface` + `remote-gw` from CMDB; null counters) for every `phase1-interface` CMDB entry absent from the `/monitor/vpn/ipsec` response — FortiOS drops a tunnel from the monitor endpoint entirely when IKE can't service it (parent interface down with no IP), which previously made dead tunnels vanish from `asset_ipsec_tunnel_samples` (System tab, Down IPsec Tunnels widget, auto-monitor dead-parent exclusion all read those rows). Synthesis requires the monitor call to have succeeded — a monitor failure rejects the collector (caller catches to "no ipsec data"), never fabricates a fleet-wide outage. CMDB failure (token without cmdb scope) → empty phase1Map → no synthesis, prior behavior.
- **LLDP asset match index is module-cached.** `persistLldpNeighbors` reads through `getLldpAssetMatchIndex()` which caches the index for 60 s and dedupes concurrent rebuilders via an inflight Promise. Stale-cache risk is one cycle of "LLDP neighbor matched to wrong asset" — self-corrects on next scrape. Discovery code that bulk-renames assets / rotates IPs / mass-MAC-edits can call `invalidateLldpMatchCache()` before its next sync if it wants the immediate refresh; the 60 s TTL is the safety net otherwise.
- **FortiSwitch port-VLAN overlay.** In the SNMP systemInfo path on `assetType="switch"` assets with a Fortinet source AND a resolvable `controllerFortigate`, `collectSystemInfo` calls `fetchFortiswitchControllerPortsCmdb(integration, controllerName, timeoutMs)` after `collectSystemInfoSnmp` lands and overlays per-port `nativeVlan` + `taggedVlans` + `trunksAllVlans` onto matching `InterfaceSample` rows by ifName == port-name. Fetcher hits `/api/v2/cmdb/switch-controller/managed-switch?datasource=1` once per (integration, controller) per 30 s (`fortiswitchControllerPortsCache` mirrors `fortinetControllerCache` TTL). Tagged set computed as `allowed-vlans − untagged-vlans`; the parser (`parseFortiosVlanList`) handles all three FortiOS shapes (array of `{vlan-id}` objects, raw number array, comma+range string) and drops `"all"` since "every VLAN" can't be a finite int list. Trunk-all detection reads `port["allowed-vlans-all"]` via `fortiosBool` (newer FortiOS) and falls back to the string sentinel `"all"` in `allowed-vlans` (older versions) — `trunksAllVlans=true` is a third state distinct from access (`taggedVlans=[]`) and explicit-list trunk (`taggedVlans=[10,20]`). Best-effort — overlay failure leaves all three fields at defaults (null/[]/false) and the interface scrape proceeds. Strictly additive; not wired for FortiGates, FortiAPs, or non-Fortinet SNMP switches in v1.
  - **MCLAG ICL-peer parse (same fetch).** The same `ports[]` loop also runs `parseFortiswitchMclagPeers` (pure, in `utils/fortiswitchCmdb.ts`), recording one `FortiswitchMclagPeer` per port flagged `mclag-icl-port` (peer named in `isl-peer-device-sn`/`-device-name`/`-port-name`, local ICL trunk in `isl-local-trunk-name`). It's returned on the per-switch ports object as `mclagPeers`, stamped onto `SystemInfoSample.mclagPeers` in the overlay block (only when the switch is present in the controller CMDB — `undefined` otherwise so stored rows aren't wiped, matching the LLDP undefined-vs-`[]` convention), and persisted by `persistMclagPeers` (delete-replace, resolving `peerSn → matchedAssetId` via one serial lookup). **Readers:** `GET /assets/:id/mclag-peers` (asset-detail General-tab row) + `topologyGraphService.ts` `mclagEdges` (one undirected sibling ICL edge per pair; the LLDP/interface edges for the same pair are stripped so it renders once, and `topology-render.js` flags it `isMclag` → visual-only, excluded from the column solver's depth/physical adjacency so peers never become parent/child). **CAVEAT:** like the trunk-member + SD-WAN parsers, the exact CMDB field shapes (`mclag-icl-port`, `isl-peer-*`) want confirmation on a live FortiOS 7.x device; the parser degrades to "no peers" on an unexpected shape. Case B (downstream `mclag:enable` trunks for dual-homed endpoints) is NOT parsed yet. Unit-tested in `tests/unit/fortiswitchTrunkMembers.test.ts`.
  - **Trunk-member overlay (same fetch).** `fetchFortiswitchControllerPortsCmdb` returns a per-switch `{ vlanByPort, trunkMembers, mclagPeers }` object — the `ports[]` loop also records a `trunkName → memberPorts[]` map (any port entry whose `members`/`member` field is non-empty IS a trunk; parsed by `parseFortiosMemberList`, permissive across object/string/CSV shapes). `overlayFortiswitchTrunkMembers(interfaces, trunkMembers)` then stamps `ifParent=<trunk>` + `ifType="physical"` onto each member's `InterfaceSample` (synthesizing the row when SNMP IF-MIB omitted the subordinate port — same pattern as the FortiGate aggregate back-fill in `collectSystemInfoFortinet`) and marks the trunk row `ifType="aggregate"` (only when its type was null/physical — never clobbers a real aggregate type). **Why:** the FortiLink uplink trunk is auto-named after the switch serial; without the parent/member linkage, `interfaceTopologyService.preferPhysical` and `topologyGraphService.ts`'s `ifDetail` swap can't resolve it to the physical port (`port52`) and the Device Map FortiLink tooltip shows the opaque serial. **CAVEAT:** the exact CMDB member field/shape wants confirmation on a live FortiOS 7.x device (same posture as the SD-WAN collector) — the parser + overlay degrade silently to "no trunk resolved" on an unexpected shape, so a wrong guess never breaks the VLAN overlay or the interface scrape. Pure functions `parseFortiosMemberList` + `overlayFortiswitchTrunkMembers` are exported and unit-tested in `tests/unit/fortiswitchTrunkMembers.test.ts`.

**When changing this:**
- Audit state-machine transitions and verify no edge cases leave assets in phantom states (esp. recovery threshold tuning).
- Update the resolver's tier caches if any integration/manual/override schema changes.
- If adding/removing transport probes, update `pollingCompatibility.ts` matrix and write-time validation in `monitorSettingsService.ts` (`assertPollingCompatible`).
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
- src/services/discovery/discoveryEngine.ts — tag assets with vendor during discovery
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

**What it owns:** Read-time supplementation of the persisted `AssetLldpNeighbor` set with neighbor rows synthesized from `Asset.fortinetTopology` so the System tab Neighbor column reflects topology Polaris already knows about (most importantly: managed FortiAPs that the FortiSwitch's SNMP LLDP-MIB silently consumes without re-publishing). Note the AP-side branch is now mostly a fallback: FMG/FortiGate discovery persists the AP's full managed_ap `lldp` table as real rows (source `"managed-ap"`, via `monitoringService.persistManagedApLldpNeighbors`), and those real rows dedupe the inferred AP row away — the inferred branch still covers firmware that omits the `lldp` array and installs whose discovery hasn't re-run yet.

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

## services/presenceVerificationService.ts

**What it owns:** Post-discovery network-presence verification for AD/Entra/Intune assets — a cheapest-first signal cascade (already-fresh → agent heartbeat → answering monitor probe → single ICMP) that establishes `Asset.lastSeen`, with bounded ICMP concurrency and a hard pass deadline.

**Public API:** `PresenceCandidate`, `PresenceSignal`, `PresenceVerificationSummary`, `classifyPresenceSignal`, `runPresenceVerification`

**Cross-service deps:** `prisma`, `logger`, `logEvent`, `bumpLastSeen`, `pingHost`.

**Used by:** `src/services/discovery/discoveryEngine.ts` — discovery post-sync pass / `verify-presence` (integration `config.verifyPresence` toggle).

**Invariants:**
- A failed ping writes NOTHING (Windows hosts commonly drop ICMP; no pong ≠ absence) — `lastSeen` advances only on positive evidence via `bumpLastSeen`.
- ICMP is concurrency-capped with a per-ping timeout and a hard pass deadline; `lastSeen` writes are batched in chunked transactions.
- Ping target priority is dnsName > hostname > ipAddress (stored ipAddress is often stale on directory-discovered assets).

**When changing this:**
- Agent-heartbeat and monitor-probe steps are best-effort; keep the no-write-on-ping-failure rule.

---

## services/nginxApplyService.ts

**What it owns:** Orchestrator that combines config persistence, rendering, the privileged sysadmin wrapper, and cert-info invalidation into the operator-facing operations: apply config, rotate cert, bootstrap, and report drift.

**Public API:** `applyProxyConfig`, `rotateCertAndKey`, `preflightCertRotation`, `bootstrapProxyConfig`, `getDriftStatus`

**Cross-service deps:** `nginxRenderer.renderNginxConfig`, `nginxConfigParser.parseNginxConfig`, `privilegedSysadmin` (stage + apply + wrapper-available), `proxyConfigService` (get/save/row-exists), `certInfo` (invalidate + fingerprint).

**Used by:** `src/api/routes/proxySettings.ts` (apply / rotate-cert), `src/jobs/bootstrapProxyConfig.ts` (startup bootstrap).

**Invariants:**
- Cert-pair validation is SPKI-only and happens before any graceful-reload attempt; the privileged wrapper owns the atomic rename + `nginx -t` + reload.
- The rendered config's SHA-256 is matched against `lastAppliedHash` for drift; `preflightCertRotation` is validation-only (touches no disk).
- `managedMode=false` blocks apply and surfaces the adopt-required flow.

**When changing this:**
- Hash computation must be byte-for-byte identical across platforms (CRLF normalization in the renderer).

---

## services/nginxConfigParser.ts

**What it owns:** Best-effort regex parse of the six operator-settable directives from a live nginx config; used at bootstrap to seed `proxyConfig` and to detect customization beyond those six (drift markers).

**Public API:** `parseNginxConfig`, `parseNginxConfigText`

**Cross-service deps:** none (proxyConfig types only).

**Used by:** `src/services/nginxApplyService.ts` (bootstrap + drift status), `tests/unit/nginxConfigParser.test.ts`.

**Invariants:**
- Whole-line comments are stripped before matching so comment text doesn't trip drift detection; drift reports unknown `proxy_pass` targets, unknown `add_header` keys, or a location-block count ≠ 5.
- Missing file returns defaults with `managedMode=false`; `KNOWN_PROXY_PASS_PATTERNS` + `KNOWN_ADD_HEADERS` define the template's expected schema.

**When changing this:**
- Update the KNOWN_* sets in lockstep with the nginx template, and keep regexes tight to avoid false-positive drift.

---

## services/nginxRenderer.ts

**What it owns:** Renders `proxyConfig` + env-derived values into a complete nginx server config (from `deploy/nginx/polaris.conf.template`), with a deterministic SHA-256 so the updater and apply service can detect drift.

**Public API:** `renderNginxConfig`

**Cross-service deps:** none (reads the on-disk template at runtime).

**Used by:** `src/services/nginxApplyService.ts` (apply + drift status), `tests/unit/nginxRenderer.test.ts`.

**Invariants:**
- Rendered bytes are identical for a given input (deterministic hash — no timestamps/random); CRLF is normalized at read time so Windows checkouts match Linux renders.
- Placeholders are `{{TOKEN}}` substituted by split/join (never regex); togglable directives are whole-line replacements.

**When changing this:**
- Verify the template path resolves in both `src/` (tsx dev) and `dist/` (tsc prod) layouts; substitution token names must match the template exactly.

---

## services/settingsStore.ts

**What it owns:** The generic TTL-cached accessor for JSON-blob Setting rows — `createSettingStore<T>({key, ttlMs, parse})` returning `{get, peek, save, invalidate}`. The store owns the read cache, the row I/O, and cache priming on save; callers keep their parse (defaults merge) and write-side validation/merge rules.

**Public API:** `createSettingStore`, `SettingStore<T>`.

**Cross-service deps:** `prisma` (settings) only.

**Used by:** `azureAuthService` (key `sso`; `peek` backs the synchronous `isAzureSsoConfigured` fast path), `entraProxyAuthService` (key `entraProxy`), `dashSettingsService` (key `dashConfig`, 10s TTL = the cross-process propagation delay to the dash listener). Other Setting-blob sites still hand-roll the pattern — migrate them onto this as they're touched.

**Invariants:**
- The cache is per-process, exactly like the hand-rolled copies it replaced — a write in one role propagates to other roles only after their ttlMs expires. Don't shorten a TTL without checking what read frequency it implies (dash consults its store on every request).
- `save` primes the cache with the written value (it does not invalidate) — callers that need a post-save DB re-read must call `invalidate()` themselves.
- `parse` runs on every cache miss and must be total (handle `undefined` = missing row).

**When changing this:** anything altering cache semantics changes every adopter at once — check each adopter's TTL expectation (auth gates, the dash listener's per-request read) before touching expiry behavior.

---

## services/dashSettingsService.ts

**What it owns:** Persistence of the Dash wallboard operator config — the `dashConfig` Setting row `{ enabled (default false), ipScope ("rfc1918"|"all"|"custom", default "rfc1918"), allowedCidrs (canonical IPv4 CIDRs for the custom scope) }` — with a ~10s TTL in-process cache. The TTL is the **cross-process propagation delay**: the web process writes the row (Server Settings → Web Server → Dash Wallboard), the dash process (`POLARIS_ROLE=dash`) reads it on every request through the cache, so a toggle lands within ~10s with no restart.

**Public API:** `getDashSettings`, `saveDashSettings`, `invalidateDashSettingsCache`, `defaultDashSettings`, `DASH_SETTING_KEY`, `DashSettings`, `DashIpScope`

**Cross-service deps:** `src/utils/cidr.ts` (`normalizeAllowlistCidr`), `AppError` (prisma otherwise).

**Used by:** `src/dash/dashServer.ts` (per-request kill-switch + `isSourceAllowed` scope decision), `src/api/routes/serverSettings.ts` (`GET/PUT /server-settings/dash`).

**Invariants:**
- `enabled` defaults FALSE — a new unauthenticated surface must never silently appear on upgrade; the operator flips it on once.
- Parsing is tolerant: a garbage/wrong-typed row falls back per-field to the safe defaults (never throws on read); a legacy `rfc1918Only` boolean migrates to `ipScope` (true→rfc1918, false→all). Invalid stored CIDRs are dropped on parse.
- `saveDashSettings` validates + normalizes custom CIDRs (throws 400 on an invalid entry) and REJECTS an enabled+custom+empty list (would lock every viewer out). Disabling is the way to turn the surface off.
- Writes invalidate the cache synchronously in the writing process; the OTHER process converges via TTL expiry — don't assume immediate cross-process visibility.

**When changing this:**
- New fields need a default + tolerant parse + merge handling, AND the Web-Server-tab card (`public/js/server-settings.js` `dashCardHtml`/`handleDashSave`) + the `PUT /server-settings/dash` Zod schema updated in lockstep.
- Don't lengthen the TTL casually — it's the operator-visible latency of the kill-switch.
- The gate DROPS unauthorized sources (socket destroy in dashServer, not a 403) — keep that stealth posture in mind when touching the scope decision.

---

## services/dashRoleSnapshotService.ts

**What it owns:** The Dash wallboard's permission identity: loads the seeded built-in `readonly` Role and materializes it via `snapshotFromRole()` (60s TTL cache) so `dashServer` can stamp `req.roleSnapshot` and every existing `requirePermission` / `hasPermission` / `ensureRoleSnapshot` gate resolves the anonymous caller as a readonly user with zero changes to `permissions.ts`.

**Public API:** `getReadonlyRoleIdentity` (→ `{ snapshot, regionTags }`), `invalidateDashRoleSnapshotCache`, `DashRoleIdentity`

**Cross-service deps:** `src/api/middleware/permissions.ts` (`snapshotFromRole`, `SessionRoleSnapshot`).

**Used by:** `src/dash/dashServer.ts` (snapshot injector middleware + the synthetic `GET /dash/api/v1/auth/me`).

**Invariants:**
- The `readonly` role is `isProtected` (uneditable), so the 60s TTL is defense-in-depth, not a freshness requirement.
- Missing `readonly` row ⇒ AppError 500 ("mis-seeded") — never a silent empty-permission fallback.
- `resolveSnapshot()` in permissions.ts returns `req.roleSnapshot` when already set — that contract is what makes injection work; if permissions.ts ever stops short-circuiting on a pre-set `req.roleSnapshot`, the whole Dash permission model breaks.

**When changing this:**
- If Dash ever becomes role-configurable (not hardcoded `readonly`), route the choice through dashSettingsService and keep the snapshot provider injectable (dashServer's `identityProvider` test seam).

---

## services/proxyConfigService.ts

**What it owns:** Persistence + validation of the operator-settable `proxyConfig` (single Setting row) with a short-TTL in-process cache — httpsPort, TLS protocols, HTTP/3 toggle, HSTS, Prometheus allow-list, and `managedMode`.

**Public API:** `getProxyConfig`, `proxyConfigRowExists`, `saveProxyConfig`, `invalidateProxyConfigCache`

**Cross-service deps:** none (prisma, proxyConfig types, AppError).

**Used by:** `src/services/nginxApplyService.ts` (apply / bootstrap / drift), `src/api/routes/proxySettings.ts`.

**Invariants:**
- Single cached row per process with a short TTL; `invalidateProxyConfigCache()` clears it synchronously and writes always invalidate.
- Validation: httpsPort 1–65535, TLS protocols a non-empty subset of {TLSv1.2, TLSv1.3}, HTTP/3 requires TLSv1.3, allow-list entries parse as IPs; partial updates merge into current state.

**When changing this:**
- Port/IP/protocol validation is security-relevant; new fields need defaults + merge/validate handling. Don't change the Setting key without a migration.

---

## services/privilegedSysadmin.ts

**What it owns:** Thin TypeScript wrapper around the `sudo /usr/local/sbin/polaris-nginx-apply` shell script — stages files into the run dir and spawns the privileged wrapper with bounded output capture. The wrapper (not this module) is the entire privileged surface.

**Public API:** `NginxApplySubcommand`, `WrapperResult`, `runNginxApply`, `stageNginxConfig`, `stageCertAndKey`, `isWrapperAvailable`

**Cross-service deps:** none (node spawn/fs, AppError, logger).

**Used by:** `src/services/nginxApplyService.ts` (config apply + cert rotation).

**Invariants:**
- All subcommand/arg validation lives in the shell script — this module only stages files + spawns; captured output is size-capped with a truncation flag.
- Stage dir/files are written with restrictive modes; `ensureStageDir` is a defensive fallback when systemd-tmpfiles didn't run.

**When changing this:**
- `isWrapperAvailable()` lets route handlers short-circuit on dev boxes that lack the wrapper.

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
- Compared fields: hostname, serialNumber, manufacturer, model, os, osVersion, learnedLocation, ipAddress, latitude, longitude (match `ProjectedAsset` keys). latitude/longitude are SKIPPED when `Asset.coordSource === "manual"`, hostname is SKIPPED when `Asset.hostnameOverride` is set, and ipAddress is SKIPPED when `Asset.ipOverride` is set — an operator pin deliberately diverges from the projection (the db.ts guard re-asserts it over discovery writes), so it's not drift (the IP disagreement already surfaces as an ip-override Conflict instead).
- Logs include `assetId, integrationKind, drifts[]` with per-field projected/current/winningSource provenance.

**When changing this:**
- Sync `PROJECTED_FIELDS` list against `ProjectedAsset` interface additions (assetProjection.ts).
- If projection rules change in `projectAssetFromSources()`, review which drifts are expected (e.g. hostname tiebreak logic).
- Check pino logger setup in `src/utils/logger.ts` for structured field compatibility.
- Once Phase 3b.1 write is implemented, wire `detectAndLogDrift()` into the post-upsert callback in discovery sync paths.

---

## services/ipOverrideService.ts

**What it owns:** Side effects of the operator IP pin (`Asset.ipOverride`) around discovery writes — the pin's ONLY writer besides the assets PUT route. The pure decision (release-on-match / reassert-on-mismatch) lives in `applyIpOverride` (`src/utils/assetInvariants.ts`), executed inside the `enforceOperatorOverrides` guard in `src/db.ts`; this service handles what happens next, invoked fire-and-forget AFTER the guarded write lands.

**Public API:** `handleIpOverrideReleased(assetId, ip)` (release path: auto-close pending ip-override conflicts + `asset.ip_override.released` Event), `raiseIpOverrideConflict(assetId, discoveredIp, ipSource?)` (mismatch path: create/refresh the asset's single pending Conflict), `resolvePendingIpOverrideConflicts(assetId, resolvedBy)` (close pending rows; returns count), `IP_OVERRIDE_COLLISION_REASON`.

**Cross-service deps:** `prisma` (db.ts — imported lazily FROM db.ts via dynamic import to break the cycle), `logEvent`.

**Used by:** `src/db.ts` (`fireIpOverrideFollowUp` after asset update/upsert), `src/api/routes/assets.ts` (PUT calls `resolvePendingIpOverrideConflicts` when the operator sets/clears the pin). Resolution UI path: `src/services/conflictResolutionService.ts` (`acceptIpOverrideConflict` / `rejectIpOverrideConflict` branch on `proposedAssetFields.collisionReason === "ip-override"`).

**Invariants:**
- At most ONE pending ip-override conflict per asset — repeat sightings refresh it (re-pointing `proposedAssetFields.ipAddress` when the discovered IP moves again) and keep `existingAssetSnapshot` current while pending.
- A REJECTED conflict with the same proposed IP suppresses re-raising (the rejected row IS the dedup marker); a new discovered IP raises a fresh conflict.
- `proposedAssetFields` shape: `{ collisionReason: "ip-override", ipAddress, ipSource, overrideIp, hostname }` — no `proposedDeviceId` / AssetSource identity; `hostname` is there for the conflictQueue widget subtitle.
- Race-guarded: re-reads the asset and no-ops when the override was cleared (or moved onto the discovered IP) between the guarded write and the follow-up.
- Auto-resolution convention matches `resolveStaleReservationConflicts`: `status="rejected"` + `resolvedBy` ("auto" for discovery-convergence, actor for operator pin changes).
- Everything is best-effort (errors logged + swallowed) — runs after the asset write already landed and must never break it.

**When changing this:**
- Keep the accept/reject handlers in `src/services/conflictResolutionService.ts` in sync with the `proposedAssetFields` shape (accept reads `ipAddress`/`ipSource`/`overrideIp`).
- Keep the events.js `renderIpOverrideConflictCard` reading the same keys.
- If the dedup model changes (e.g. per-IP instead of per-asset pending rows), revisit `resolvePendingIpOverrideConflicts` callers — the PUT route assumes "close everything pending for this asset."
- The JSON path filter (`proposedAssetFields.path ["collisionReason"]`) requires PostgreSQL; keep it in sync with `IP_OVERRIDE_COLLISION_REASON`.

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
- **Discovery queue payload:** `DiscoveryJobPayload` is `{ integrationId, actor, scopeDeviceName? }` — the optional third field is the single-FortiGate scoped re-discovery (threaded `publishDiscoveryJob(id, actor, scope?)` → consumer → `DiscoveryJobHandler(id, actor, scope?)` → `runDiscovery`). `singletonKey` stays `integrationId` regardless of scope: a scoped run and a full run for the same integration must coalesce, never run concurrently (they'd double-write the same device's rows).

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

**Used by:** src/services/reservationService.ts (pushReservation on create, unpushReservation on dhcp_reservation release, releaseDhcpLease on both dhcp_reservation and dhcp_lease release); src/services/subnetRefreshService.ts (read-only per-subnet refresh consumes the transport helpers).

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

**What it owns:** Reservation creation, updates, release, expiry, and DHCP push orchestration — including ALL the reservation audit Events: the push-lifecycle detail rows AND the top-level `reservation.created` / `reservation.updated` / `reservation.released` CRUD rows (createReservation is a thin wrapper around the internal flow that emits the one created-Event with the final push outcome in its message; `via: "auto-allocate"` discriminates the nextAvailableReservation message; releaseReservation takes `(id, actor?)` and emits after its transaction commits).

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
- Both createReservation and updateReservation auto-stamp `owner` with the caller's username when the operator didn't type one (create: `input.owner || input.createdBy`; update: `input.owner === undefined` → actor). Pairs with the discovery sync's MAC-aware owner-preservation rule in `discoveryEngine.ts` `syncDhcpSubnets` Phase 6 — discovery only overwrites owner with `asset.assignedTo` when the discovered MAC differs from `reservation.macAddress`, so a Polaris-stamped owner survives across discovery cycles for stable reservations.
- Released reservations clear pushedTo* fields and drop historical released rows (unique constraint relief)
- `expireStaleReservations` applies the SAME unique-constraint relief for `expired`: inside one `$transaction` it first DELETEs (set-based `DELETE…USING` self-join) any stale `expired` row sharing (subnetId, ipAddress) with an active row about to expire, THEN runs the active→expired `updateMany`. Without the pre-delete a reserve→expire→re-reserve→expire cycle leaves a colliding `expired` row, and since the flip is one bulk updateMany a single P2002 aborts the whole batch (job fails every 15 min, nothing expires). NULL ipAddress (full-subnet) never collides (NULL distinct) and is excluded by the `=` join.
- Discovered dhcp_lease release attempts bestEffort via releaseDhcpLease (failure does not block Polaris release)
- Releasing a dhcp_reservation (non-pending) deletes the device-side reserved-address (unpushReservation — pinned ids for Polaris-pushed, resolve-by-CIDR/IP for discovered when pushReservations=true) AND drops the IP's active lease (releaseDhcpLease). Both best-effort; neither blocks the Polaris release.

**When changing this:**
- Test createReservation's push eligibility detection and MAC validation order
- Verify releaseReservation's transaction scope (unpush, lease release, subnet status reset)
- Check expireStaleReservations is called every 15 min via jobs/expireReservations.ts
- Audit the atomic create-and-push path for rollback edge cases (orphaned device entries)
- Exactly ONE top-level CRUD Event per mutation, in-service (route layer emits nothing) — `tests/integration/reservations.test.ts` asserts the contract. A queued release intentionally writes TWO rows (`reservation.released` top-level + `reservation.push.queued.released` detail) — historical behavior, preserved.

---

## services/arpPrimeService.ts

**What it owns:** The ARP-priming presence sweep — fire-and-forget UDP datagrams at reserved IPs so a FortiGate is forced to ARP-resolve each target right before discovery reads its ARP table. Owns the sweep constants (port 33434, batch 256 / pause 25ms, cap 4096, `ARP_SETTLE_MS` 2s). Sends packets; never reads or writes the DB.

**Public API:** `planSweepBatches(ips, batchSize?, maxTargets?)` (pure: dedupe / IPv4-validate / cap / chunk), `primeArpCache(ips)` (paced send, never throws), `ARP_SETTLE_MS`, `ARP_SWEEP_PORT`, `ARP_SWEEP_BATCH_SIZE`, `ARP_SWEEP_MAX_TARGETS`.

**Used by:** `fortimanagerService.discoverDhcpSubnets` Step 3d.54 (proxy mode, per-device, targets from the `arpSweepTargets` map param) and `fortigateService.discoverDhcpSubnets` Chain D Step 3e.54 (standalone + FMG-direct, targets from `FortiGateConfig.arpSweepIps`). Targets are built by `buildArpSweepTargets` in `src/services/discovery/discoveryEngine.ts` (active dhcp_reservation IPs grouped per FortiGate device) only when `Integration.config.arpPresenceSweep === true`.

**Invariants:**
- Fire-and-forget: no replies expected, per-datagram errors swallowed, function never throws — a failed sweep degrades to "no priming," never blocks discovery
- Per-gate targeting only (each FortiGate is swept with its own subnets' reserved IPs immediately before ITS table read) — never a fleet-wide blast; FortiOS GCs unreferenced neighbor-cache entries in ~60–90s so sweep → settle → read must stay contiguous
- Callers await the send (socket close drops queued datagrams behind the implicit bind) and then settle `ARP_SETTLE_MS` before the ARP query
- Over-cap overflow is logged (never silent); malformed/non-IPv4 entries are skipped silently (never sweepable)
- Opt-in per integration (default off — IDS-visible traffic); the Phase 7.6 lastSeenArp stamping is NOT gated by the toggle (passive ARP bindings are equally valid evidence)

**When changing this:**
- Keep the settle window well inside the FortiOS neighbor-cache GC window (~60s floor) — if you raise `ARP_SETTLE_MS`, remember proxy-mode FMG devices serialize, so N devices pay N × settle per cycle
- Scale-check pacing at 2000+ reservations per gate (batch × pause math) and confirm the socket send path stays awaited before close
- If sweep targets gain a new source, keep the per-gate grouping — a global sweep at discovery start ages out before late devices' reads

---

## services/reservationStaleService.ts

**What it owns:** Stale DHCP-reservation detection, alerting, and alert management (snooze, ignore) — including the lifecycle audit Events (`reservation.stale-settings.updated` / `reservation.stale.snoozed` / `reservation.stale.ignored` / `reservation.stale.unignored`), emitted in-service with the route passing `actor`.

**Public API:** getStaleSettings, updateStaleSettings, listStaleReservations, snoozeReservation, setStaleIgnored, flagStaleReservations.

**Used by:** src/api/routes/reservations.ts (list/snooze/ignore endpoints), src/jobs/flagStaleReservations.ts (flagStaleReservations every 6 hours).

**Reads (cross-signal):** Asset.lastSeen, AssetMacAddress.mac, AssetAssociatedIp.ip — `buildAssetPresenceResolver` correlates each candidate reservation to an Asset (MAC first via `normalizeMacOrNull`, then IP) so a statically-addressed device that never pulls a DHCP lease but is still on the network is NOT flagged stale. Three batched, indexed findMany calls per scan (bounded by candidate-reservation count); no per-row queries. Also reads `Reservation.lastSeenArp` — written by `syncDhcpSubnets` Phase 7.6 (discoveryEngine.ts) when the owning FortiGate's ARP table binds the reserved IP to the reserved MAC; the opt-in `Integration.config.arpPresenceSweep` toggle makes `arpPrimeService` prime the gate's ARP cache (per-gate UDP sweep) right before each table read so ICMP-silent static devices resolve too.

**Invariants:**
- Stale threshold (staleAfterDays) defaults to 60 days, 0 = disabled
- Cold-start grace: effective baseline = max(createdAt, detectionStartedAt) to avoid flooding on first run
- Effective last signal = freshest of {lastSeenLeased, lastSeenArp, matched Asset.lastSeen}; baseline is a fallback used only when NONE exists (not a floor — a real but old signal still flags during cold-start)
- lastSeenArp is stamped only on an exact (device, ip, MAC) match — a different MAC answering the reserved IP is not presence; absence of an ARP entry is never negative evidence (sweep reach depends on routing + firewall policy)
- A row is stale if effectiveLastSignalMs < (now − threshold) AND (threshold > 0)
- Active list/count exclude reservations on DEPRECATED subnets (decommissioned-firewall networks) via `where.subnet.status != "deprecated"`; the ignored review list is NOT filtered by subnet status
- MAC correlation wins over IP (DHCP reservations are MAC→IP, the stable identity); entry carries assetLastSeen + assetPresenceMatch ("mac" | "ip" | null)
- Snooze extends alert by staleAfterDays from now (not from threshold); clears staleNotifiedAt
- Ignored rows stay suppressed regardless of threshold; detectionStartedAt persists across runs
- flagStaleReservations emits one reservation.stale Event per fresh transition (staleNotifiedAt null → timestamp)
- Discovery clears staleNotifiedAt on re-sighting (re-arms alert for future silence) — both the lease path (Phase 5) and the ARP path (Phase 7.6) clear staleNotifiedAt + staleSnoozedUntil

**When changing this:**
- Verify staleAfterDays threshold propagates to all callers (threshold=0 should disable all alerts)
- Test cold-start grace window (rows pre-dating detectionStartedAt get full threshold window)
- Check flagStaleReservations only fires on active dhcp_reservation rows (not discovered dhcp_lease)
- Audit snooze idempotency: repeated snooze clicks should extend from "now" not from prior snooze
- effectiveLastSignalMs is pure + exported — extend its unit test when changing evidence precedence
- Keep the presence resolver batched (no per-row asset lookups) — scale-check at 2000 assets

---

## services/dnsResolvedReservationService.ts

**What it owns:** Auto-creation, update, and release of `sourceType="dns_resolved"` Reservation rows that mirror Assets whose primary `ipAddress` isn't covered by an authoritative reservation. Plays no part in DHCP push, conflict raising, or asset writes themselves — strictly a downstream observer of the Asset table.

**Public API:** `reconcileDnsResolvedForAsset(assetId)`, `reconcileDnsResolvedForAllAssets()`, `releaseDnsResolvedForAsset(assetId)`, `releaseDnsResolvedAt(subnetId, ipAddress)`, `ReconcileResult` interface.

**Used by:** `src/db.ts` Prisma extension (per-asset reconcile on create/update/upsert; release on delete); `src/jobs/reconcileDnsResolvedReservations.ts` (periodic sweep); `src/services/discovery/discoveryEngine.ts` `syncDhcpSubnets` + `src/api/routes/integrations.ts` `registerFortinetHost` (inline `releaseDnsResolvedAt` before each authoritative create); `src/services/reservationService.ts:createReservation` (same inline release for manual creates).

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
- Adding a new authoritative `sourceType`? Add a `releaseDnsResolvedAt(subnetId, ip)` call in `discoveryEngine.ts` next to the new create, and (if it can be created from the manual UI) in `reservationService.createReservation`. The activeResMap exclusion already covers the discovery read path.
- Adding a new column to the eligibility check? Update `assetEligible()` and ensure the periodic job's `findMany` scope still surfaces rows that need release-without-create. The job intentionally scans even ineligible-by-status assets so they can release stale rows.
- Switching to a real `Reservation.assetId` FK? Replace `findOwnedSystemRows`'s identity-match SQL with a direct join, and the per-asset reconcile becomes trivially correct (no more "hostname or MAC" heuristic).
- Verify the unique-on-active constraint: create an authoritative reservation at an IP that has a dns_resolved row; the release MUST run before the create (the order matters — Postgres can't have two active rows at the same `(subnetId, ipAddress)`).
- Performance check at 2000 monitored assets: the periodic sweep should complete in seconds. If it slows, raise BATCH from 25; the inner work is one `findContainingSubnet` + one upsert per asset, both index-friendly.

---

## services/roleService.ts

**What it owns:** CRUD over the `Role` table for the dynamic-role RBAC model — enforces protected/built-in/custom invariants, normalizes the permission matrix + tags, emits `role.*` Events, and bumps the role-version cache so live sessions refresh.

**Public API:** `RoleSummary`, `CreateRoleInput`, `UpdateRoleInput`, `listRoles`, `getRole`, `getRoleByName`, `createRole`, `updateRole`, `deleteRole`, `countAdminEquivalentUsers`, `isAdminEquivalentRole`

**Cross-service deps:** `prisma`, `AppError`, `logEvent`, `tagNormalize`, `bumpRoleVersion` + `normalizePermissions` + `FUNCTION_KEYS` (permissions middleware).

**Used by:** `src/api/routes/roles.ts` (CRUD + `GET /roles/functions`), `src/api/routes/users.ts` (role assignment + admin-equivalent checks).

**Invariants:**
- Protected roles (`admin`, `readonly`) can't be edited/renamed/deleted; built-in roles (`networkadmin`, `assetsadmin`, `user`) can be edited but not deleted; reserved names are case-insensitively protected even for new custom roles.
- Delete refuses with 409 when any user holds the role; `regionTags`/`otherTags` are normalized (trim/dedupe/cap); badge color is `#rrggbb` or null.
- Every write bumps the role-version cache via `bumpRoleVersion` (live sessions refresh on next request) and emits a per-field diff Event.

**When changing this:**
- `countAdminEquivalentUsers` filters in JS (role counts are tiny) and backs the last-admin invariant alongside `userService`.

---

## services/probePatchBuffer.ts

**What it owns:** Batching buffer for per-probe Asset state writes (`monitorStatus`, `consecutiveFailures`/`Successes`, `lastMonitorAt`, `lastResponseTimeMs`, `lastUptimeSec`, `lastRebootAt`, and on a successful probe `lastSeen`/`lastSeenSource = "probe"`) — collapses N per-tick `Asset.update`s into one bulk `UPDATE … FROM (VALUES …)` per ~2 s window with last-write-wins merge. `monitorStatusChangedAt`, `lastUptimeSec`, `lastRebootAt`, `lastSeen`, and `lastSeenSource` are merge-preserved + flushed via `COALESCE(v.x, t.x)` so a probe that didn't carry a transition / uptime / reboot / success keeps the prior DB value instead of NULL-erasing it. The `lastSeen`/`lastSeenSource` columns make this the presence authority for monitored assets (see cross-cutting/asset-last-seen-presence); a failed probe omits them and freezes presence at the last successful poll.

**Public API:** `enqueueProbePatch`, `getPendingProbePatch`, `flushProbePatchBuffer`, `startProbePatchBuffer`, `shutdownFlushProbePatchBuffer`, `ProbePatch`, `FLUSH_INTERVAL_MS`

**Cross-service deps:** `prisma`, `logger`, `retryOnDeadlock`, metrics (write timer + buffer depth).

**Used by:** `src/services/monitoringService.ts` (`recordProbeResult` enqueues + overlays the pending patch for read-your-writes), `src/app.ts` (boot start + SIGTERM drain).

**Invariants:**
- Last-write-wins per asset within a window EXCEPT `monitorStatusChangedAt`, `lastUptimeSec`, `lastRebootAt`, `lastSeen`, and `lastSeenSource`, which are preserved on merge when the new patch omits them (so a failed probe doesn't erase a successful probe's presence/uptime stamps within the same window).
- Read-your-writes: `recordProbeResult` overlays the pending patch before running the state machine; re-entrant safe (concurrent enqueues during flush land in a fresh buffer); on flush failure the snapshot is re-prepended only for assets not already overwritten.
- A size threshold triggers an early flush; the shutdown hook must drain before process exit.

**When changing this:**
- `FLUSH_INTERVAL_MS` matches `sampleWriteBuffer` for consistent UI lag — keep them aligned.

---

## services/sampleQueryRouter.ts

**What it owns:** Pure tier-selection — routes a chart-history query to the detail / hourly / daily tier based on the requested range and the operator-configured retention windows. No I/O.

**Public API:** `pickSampleTier`, `pickSampleTierForAsset`, `SampleTier`, `TierPick`, `DEFAULT_TIER_RETENTION`

**Cross-service deps:** `sampleRetentionService` (retention windows + FOREVER + entities).

**Used by:** `src/services/sampleHistoryService.ts` (`SampleTier` type) and `src/api/routes/assets.ts` (history endpoints dispatch through `pickSampleTierForAsset`).

**Invariants:**
- Tier decision uses ONLY the `since` timestamp (the oldest point binds the tier), not `until`; `DEFAULT_TIER_RETENTION` applies when per-asset overrides aren't available.
- The returned `bucketSeconds` (0 / 3600 / 86400) signals to the client whether rates are pre-computed (rollup) or client-diffed (detail).

**When changing this:**
- Retention edits flow through `sampleRetentionService` (read per call behind its short cache); tier-picking logic itself rarely changes.

---

## services/sampleRetentionService.ts

**What it owns:** Global per-entity sample-retention policy (Server Settings → Retention), stored in `Setting("sampleRetention")`. Axis is per-entity (assets / cpuMem / hardware / interfaces / storage / ipsec / perfSla — 7 entities), not per-asset-class; selection-aware entities apply configured retention only to selected/monitored rows. (SD-WAN rules are current-state and NOT a retention entity.)

**Public API:** `getSampleRetention`, `updateSampleRetention`, `invalidateSampleRetentionCache`, `getRetentionDays`, `defaultSampleRetention`, `unselectedSlowPruneWindow`, `tieredPruneWindow`, `SETTING_KEY`, `FOREVER`, `UNSELECTED_DETAIL_HOURS`, `RetentionEntity`, `RETENTION_ENTITIES`, `SELECTION_AWARE_ENTITIES`

**Cross-service deps:** `prisma`.

**Used by:** `src/services/sampleQueryRouter.ts`, `src/api/routes/serverSettings.ts` (`GET`/`PUT /sample-retention`), `src/services/capacityService.ts` + `src/services/monitoringService.ts`, `src/jobs/migrateSampleRetentionToEntities.ts`.

**Invariants:**
- Encoding: positive = N days, 0 = tier off (pruned), `FOREVER` = -1 (keep forever); short in-process cache TTL, invalidated on every write; partial PUT merges into stored value.
- Unselected rows keep a fixed short detail window with no rollup; the unselected-slow-prune window respects the compress-after frontier to avoid expensive decompression.

**When changing this:**
- `RETENTION_ENTITIES` has eight entries (the two SD-WAN streams included) — keep it aligned with the sample-table inventory.

---

## services/sampleRollupService.ts

**What it owns:** Rolls the seven source sample tables up into hourly and daily aggregates (fourteen rollup tables, 2 tiers × 7 sources); the daily tier reads from the hourly tier, not from detail. Counter tables store first/last for rate derivation, gauges store avg/min/max. (The SD-WAN rules rollup was removed when rules became current-state.)

**Public API:** `rollupHourly`, `rollupDaily`, `RollupTier`, `SourceTable`

**Cross-service deps:** `prisma`, `logger`, metrics (rollup timer).

**Used by:** `src/jobs/runSampleRollup.ts` (hourly + daily ticks).

**Invariants:**
- `INSERT … ON CONFLICT DO UPDATE` (idempotent — re-running the same window rewrites buckets in place); hourly uses a short lookback for late-arriving samples, daily a longer one.
- Counter rate = (last − first) / elapsed with negative deltas treated as resets; daily aggregates are sampleCount-weighted.

**When changing this:**
- A new sample source needs a new `SourceTable` variant, a `DEFS` entry, and matching hourly + daily SQL builders — the SQL is brittle (verify bucket cardinality + aggregate semantics).

---

## services/sampleHistoryService.ts

**What it owns:** Tier-aware readers for the asset chart-history endpoints (monitor, telemetry, hardware sensors, storage, interfaces, IPsec, perf-SLA) — returns serialized rows + stats matching the chart renderers, with overflow-boundary points for unbroken polylines. (SD-WAN rules are current-state — read directly from `prisma.assetSdwanRule` in the route, no history reader here.) Also the merge-comparison **polling-history summary** (`readPollingHistorySummary`): oldest/newest sample + stitched non-double-counting sample count across the monitor + telemetry streams' three tiers, served by `GET /assets/:id/polling-history`.

**Public API:** `readMonitorHistory`, `readLastMonitorSuccessAt`, `readTelemetryHistory`, `readHardwareSensorHistory`, `readStorageHistory`, `readInterfaceHistory`, `readIpsecHistory`, `readPerfSlaHistory`, `readSdwanMembers`, `readPollingHistorySummary`

**Cross-service deps:** `sampleQueryRouter` (`SampleTier`), `prisma`.

**Used by:** `src/api/routes/assets.ts` (`/assets/:id/*-history` + `/sdwan-members` endpoints).

**Invariants:**
- Detail tier reads the source tables; hourly/daily tiers read rollups and translate aggregate columns back to source field names so renderers consume both shapes.
- Counter tables (interface, ipsec) return values for client/rollup rate computation; gauge tables return avg/min/max; BigInt coerced to number with a safe-integer cap; the fetch-since window can extend past `since` for chart continuity while stats stay within the visible range.
- A rollup row's `timestamp` IS its `bucketStart`, so no consumer may read data *freshness* off a rollup series (a daily bucket is up to 24h old when written, and the daily rollup only runs at 02:30 UTC). `readLastMonitorSuccessAt` exists for exactly that: the response-time chart's stale banner reads it (surfaced as `lastSuccessAt` on `monitor-history`, rollup tiers only) instead of the newest sample's timestamp, which otherwise made a healthy 1-minute probe read "Last successful update 17h ago" on the 30d range.

**When changing this:**
- Rollup schema changes require matching SQL in `sampleRollupService`; a new stream needs schema + a tier-aware reader + rollup SQL + router support.

---

## services/sampleWriteBuffer.ts

**What it owns:** Periodic batch-flush buffer for the seven append-only monitor sample tables (asset_monitor_samples / asset_telemetry_samples / asset_hardware_sensor_samples / asset_interface_samples / asset_storage_samples / asset_ipsec_tunnel_samples / asset_perf_sla_samples). Collapses per-work-item `prisma.<table>.create*` calls into one `createMany` per 2 s flush window so the monitor hot loop stops eating DB pool capacity per probe. (SD-WAN **rules** are no longer buffered — they're current-state, written via `persistSdwanRules`; only the SD-WAN SLA-metrics stream `asset_perf_sla_samples` rides this buffer.)

**Public API:** `enqueueMonitorSample`, `enqueueTelemetrySample`, `enqueueHardwareSensorSamples`, `enqueueInterfaceSamples`, `enqueueStorageSamples`, `enqueueIpsecTunnelSamples`, `enqueuePerfSlaSamples`, `flushAllSampleBuffers`, `startSampleWriteBuffer`, `shutdownFlushSampleBuffers`, `FLUSH_INTERVAL_MS`, all seven row-type interfaces.

**Cross-service deps:** `prisma` (db.js), `retryOnDeadlock` (utils/dbRetry.js), `startSampleWriteTimer` + `setSampleBufferDepth` (metrics.js), `logger` (utils/logger.js).

**Writers (the only callers of `enqueue*`):**
- `src/services/monitoringService.ts:recordProbeResult` — `enqueueMonitorSample` for the probe outcome row.
- `src/services/monitoringService.ts:recordTelemetryResult` — `enqueueTelemetrySample` (CPU/memory only).
- `src/services/monitoringService.ts:recordHardwareSensorResult` — `enqueueHardwareSensorSamples` (per-sensor; dispatched by the separate `collectHardwareSensors` call that `runTelemetryFor` issues in parallel with `collectTelemetry`).
- `src/services/monitoringService.ts:recordSystemInfoResult` — `enqueueInterfaceSamples`, `enqueueStorageSamples`, `enqueueIpsecTunnelSamples`, plus `enqueuePerfSlaSamples` when the heavy pass ran `collectSdwanFortinet` (gated by `Integration.config.pullSdwan`; perfSla rows are stamped cadence="fast"). SD-WAN **rules** are persisted in the same flow via `persistSdwanRules` (current-state delete-replace, NOT buffered). Also folds EVERY scraped interface MAC into `AssetMacAddress` (source="monitor-interface") via `reconcileInterfaceMacs` — contiguous MACs coalesce into `[mac, macEnd]` range rows; the replace is scoped to that source, and `reconcileMacAddresses` symmetrically filters monitor-interface entries + scopes its deletes, so the discovery and interface-fold writers never churn each other's rows.
- `src/services/monitoringService.ts:recordFastFilteredResult` — same three as systemInfo, smaller subset (pinned interfaces only).
- `src/api/routes/agents.ts:POST /samples` — the Polaris Agent ingestion path: `enqueueMonitorSample` (responseTime, also via `recordProbeResult`), `enqueueTelemetrySample` + `enqueueHardwareSensorSamples` (telemetry), `enqueueInterfaceSamples`, `enqueueStorageSamples`. The `interfaces` stream also mirrors `recordSystemInfoResult`'s interface MAC fold — `reconcileInterfaceMacs` (source="monitor-interface", contiguous MACs coalesced into range rows) over every pushed NIC MAC, since for agent-monitored hosts this push IS the system-info source. **This writer runs on the `web` role**, not monitor — which is why the web role must also run the flush tick (see Boot).

**Readers:** none directly. The sample tables are read by `assets.ts` route handlers (chart endpoints), `capacityService.ts` (sample-table breakdown), and Cytoscape topology builders — none of those see the buffer, only the persisted rows after a flush.

**Boot + shutdown:**
- `src/app.ts:startSampleWriteBuffer()` called once after queue init, gated on `cfg.runsWriteBuffers`. **That flag is true for BOTH `monitor` AND `web`** (and `all`) — monitor produces samples via probes, web produces them via the agent `/samples` + `/probe-now` ingestion. If web ever loses the flush tick (it did before this was fixed — `runsWriteBuffers` was monitor-only), agent-sourced rows pile up in the web process's in-memory buffer and only land on the next graceful shutdown flush, while `lastTelemetryAt` (a direct synchronous `Asset.update`, not buffered) stays misleadingly fresh.
- `src/app.ts` SIGTERM/SIGINT hook awaits `shutdownFlushSampleBuffers()` before `process.exit(0)` so a graceful restart drains the buffer — this is the ONLY thing that flushed agent samples while the web role lacked the tick.

**Invariants:**
- **Append-only.** No conflicts on createMany — every row is a fresh time-series sample with a synthetic UUID `id`. Don't try to add upsert/dedupe logic; if you need replace semantics, do it synchronously in the record function before enqueueing (cf. `persistLldpNeighbors`, which is NOT buffered for this reason).
- **Snapshot-on-flush.** `flushTable` splices the current array up front so concurrent enqueues during the awaited `createMany` land in a fresh array. On retry-exhausted failure the snapshot is re-prepended for the next tick.
- **Per-table flush guard.** `flushing[key]` prevents re-entry on the same table — a 2 s tick that fires while a slow flush is still mid-write becomes a no-op for that table, no concurrent writer per table.
- **Trade-off documented:** up to 2 s of sample rows lost on hard crash. Acceptable because samples are an append-only time series and the next cadence tick re-supplies. Asset-level state (status pill, counters, lastMonitorAt) is buffered separately by `src/services/probePatchBuffer.ts` with last-write-wins semantics — same 2 s window, different shape because state needs replace + read-your-writes, the append-only contract here doesn't fit.
- **Detail tier only.** This buffer covers the eight SOURCE tables. The sixteen `*_hourly` / `*_daily` rollup tables use INSERT...ON CONFLICT DO UPDATE from `sampleRollupService.ts` instead — rollup writes are inherently upsert (idempotent re-runs over the same window must rewrite buckets in place) and the append-only buffer contract has no upsert path.

**When changing this:**
- New sample table → add a `BufferKey`, an `enqueueXxx` helper, a `TABLE_LABEL` entry, and a `switch` arm in `writeBatch`. Touch the test file too — same shape.
- Flush interval change → consider both UI latency (samples take this long to appear on charts) and crash-window data loss. The current 2 s was the explicit operator choice.
- Don't add a `prisma.$transaction` here. `createMany` is one network round-trip already; wrapping it in a transaction just adds round-trips without giving us anything (each table is independent, no cross-table invariant).

---

## services/searchService.ts

**What it owns:** Global typeahead search across all domain entities, with input classification (IP/CIDR/MAC/text), whitespace/quoted-phrase tokenization into AND-combined terms, parallel entity-specific queries capped at 8 results per group, AND scope-prefix shortcuts (`block:`/`b:`, `network:`/`n:`, `asset:`/`a:`, `reservation:`/`r:`, `map:`/`m:`) that bypass the per-group cap.

**Public API:** `searchAll(rawQuery, allowed?)`, `SearchAllowed`, `normalizeMac`, `parseSearchTerms`, `assetMonitorPillState` (+ `AssetMonitorPillFields`).

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
- **Monitor Status pill on asset/site hits:** `assetHit` and `siteHit` stamp `status: { kind, label }` via `assetMonitorPillState` — same precedence as `assetMonitorBadge` in `public/js/assets.js` (unmonitored → Dependency Test → Dep. Down → five-state, unknown/null → Pending; unit-tested in `tests/unit/assetMonitorPillState.test.ts`). The desktop dropdown (`section()` inside `_renderSearchDropdown` in `public/js/app.js`) maps `kind` onto the existing `.badge-monitor-*` classes via `pillClassByKind` + the `.gs-item-pill` size override in `styles.css`. If the assets-table pill gains a state, extend the server helper AND the client class map together.
- Asset origin resolution (for topology modal focus) prioritizes most-recent DHCP sighting, falls back to `learnedLocation` for Entra/AD-discovered hosts. **A firewall is never its own origin** — a pinned FortiGate's sighting/`learnedLocation` resolves back to itself, and stamping `context.siteId` on it would make both dropdown renderers synthesize a virtual Device Map row duplicating the gate's real `sites` hit.
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

**What it owns:** Subnet creation, allocation, bulk templates, and lifecycle (manual vs discovered), plus the `subnet.created` / `subnet.updated` / `subnet.deleted` / `subnet.bulk-allocated` audit Events (emitted in-service; inputs carry `actor?`, and `via: "auto-allocate"` discriminates the allocateNextSubnet message from a manual create).

**Public API:** listSubnets, getSubnet, createSubnet, allocateNextSubnet, bulkAllocate, previewBulkAllocate, updateSubnet, getSubnetIps, deleteSubnet, buildIpContexts + IpContext (batched IP → most-specific containing subnet + active-reservation summary; THE single implementation of the `cidr >>= ip` / `masklen DESC` containment SQL).

**Cross-service deps:** ipService (indirectly via cidrContains/cidrOverlaps from utils/cidr.ts).

**Used by:** src/api/routes/subnets.ts (all operations), src/api/routes/assets.ts (buildIpContexts — per-row `ipContext` for the asset table's View Lease button), src/services/dnsResolvedReservationService.ts (buildIpContexts — target-subnet resolution in the reconciler), src/services/reservationService.ts (subnet lookups, status checks), src/services/utilizationService.ts (subnet status grouping).

**Invariants:**
- Subnet must be contained within parent block CIDR
- No overlapping sibling subnets in the same block (checked before create)
- IPv4-only for auto-allocation (allocateNextSubnet, bulkAllocate)
- Subnet status = "deprecated" rejects new reservations
- Full-subnet reservation (ipAddress=null) sets subnet status → "reserved"
- Prefix length must be [8, 32] for IPv4
- **First-claim parity (discovery side, lives in `src/services/discovery/discoveryEngine.ts` syncDhcpSubnets Phase 1):** when a discovery cycle's CIDR matches a manual subnet (`existing.discoveredBy == null`), the row gets brought into parity with a freshly-discovered subnet — `name` rewritten to `DHCP: <scope> (<fortigate>)`, `status` reset to `available`, `tags` union-merged with `["dhcp-discovered", <integrationType>]`, `purpose` stamped only when blank. Subsequent passes see `discoveredBy` set and skip the claim branch (operator can rename/retag after claim and edits survive). One `subnet.claimed` Event per first-claim.

**When changing this:**
- Test allocateNextSubnet's findNextAvailableSubnet logic (concurrent allocations must not race)
- Verify bulkAllocate's anchor-aligned packing (all-or-nothing transaction)
- Check updateSubnet does not allow status changes that violate reservation constraints
- Review overlapping-sibling check performance for large blocks
- **bulkAllocate's single `subnet.bulk-allocated` Event must stay AFTER the `$transaction` resolves** (an event from inside would be a phantom on rollback), and the per-subnet `tx.subnet.create` calls must stay event-free — `tests/integration/subnets.test.ts` asserts one-bulk-event + zero-per-subnet-events. allocateNextSubnet delegates to createSubnet, so it must keep passing `via: "auto-allocate"` rather than emitting its own event.

---

## services/timescaleService.ts

**What it owns:** TimescaleDB extension detection and hypertable migration for the seven sample tables + fourteen rollup tables + the standalone detail-only `asset_custom_widget_samples` (22 hypertable candidates); `dropChunks` pre-filter for retention pruning. Boot-time detection caches hypertable status; subsequent `isHypertable()` checks return cached value without round-tripping. (SD-WAN rules — `asset_sdwan_rules` — are a plain current-state table, not a hypertable candidate.)

**Public API:** `detectTimescale`, `isTimescaleAvailable`, `isHypertable`, `getDetectionState`, `dropChunks`, `getEffectiveCompressAfterDays`, `migrateToHypertables`, `SAMPLE_TABLES`, `ROLLUP_TABLES`, `STANDALONE_SAMPLE_TABLES`, `ALL_HYPERTABLE_CANDIDATES`, `SampleTableName`, `RollupTableName`, `StandaloneSampleTableName`, `ManagedHypertableName`, `DetectionState`.

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
- Audit all call sites in auth.ts for pendingToken lifecycle (issue, consume at 195/226/233).
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

## services/backupService.ts

**What it owns:** The whole database backup + restore mechanism. Extracted from `src/api/routes/serverSettings.ts` (2026-08) so the routes are thin and the pipeline is testable.

**Public API:** `createBackup({password, kind, actor}) -> {record, path}`, `restoreBackup({filePath, password})`, `listBackups`, `getBackupRecord`, `deleteBackup`, `backupFilePath`, `isEncryptedBackupFile`, `timescaleInstalled`, plus the format constants `BACKUP_MAGIC` / `ENCRYPTED_HEADER_LEN`.

**Cross-service deps:** `utils/pgEnv.ts` (libpq PG* env), `utils/dbConnections.ts` (`getDirectDatabaseUrl`), `utils/paths.ts` (`BACKUP_DIR`), `utils/version.ts`, `services/eventLogService.ts`. Spawns `pg_dump` / `psql`.

**Used by:** `src/api/routes/serverSettings.ts — POST /database/backup, POST /database/restore, GET /database/backups, DELETE /database/backups/:id, GET /database/backups/:id/download`; `src/services/updateService.ts — the pre-update backup step`; `src/jobs/scheduledBackup.ts — the automatic-backup cadence`. Three writers of `backup_history`, all through this service.

**Invariants:**
- **Nothing is buffered.** `pg_dump` stdout streams through gzip (and the cipher when encrypting) straight to disk, and the route streams the finished file to the client. Peak memory is a few stream watermarks regardless of database size. The pre-2026-08 version did `execSync` + `readFileSync` + `gzipSync` + in-memory cipher + `res.end(payload)` — three copies of a multi-GB dump in the heap, with the event loop blocked for the whole dump.
- **No wall-clock cap.** The old fixed 120 s `execSync` timeout failed a healthy dump the moment the database outgrew two minutes. A dump still emitting bytes is making progress; the watchdog (`NO_OUTPUT_TIMEOUT_MS`, 10 min) kills only a SILENT child.
- **The connection never appears in argv.** `pg_dump`/`psql` get PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from the environment via `pgChildEnv`. Putting the URL on the command line exposed the DB password to `ps aux`, and (because the command was an interpolated shell string) Node's `Command failed: <command>` message was being returned in the HTTP response body. Child-process stderr is logged, never echoed to the caller.
- **Restore is TimescaleDB-aware.** On a database with the extension, restore runs `SELECT timescaledb_pre_restore();` → the dump → `SELECT timescaledb_post_restore();` in THREE SEPARATE psql sessions (pre_restore sets the flag at database level and only affects sessions started afterwards). `post_restore` is in a `finally`: a database left in restoring mode rejects normal hypertable writes, which is worse than the failed restore that caused it. `timescaleInstalled()` fails toward TRUE — running the gates on a non-Timescale DB is a benign, detectable error; skipping them on a Timescale DB corrupts the restore.
- **Every connection is stale after a restore.** `--clean --if-exists` DROPs and recreates every table, so any connection opened before the restore holds cached relation OIDs that no longer exist and fails its next query with `XX000 could not open relation with OID <n>`. `restoreBackup` therefore recycles the pool (`prisma.$disconnect()`) in its `finally` — in the finally, not the success path, because a failure after the inner commit leaves the same situation. That is a MITIGATION, not a cure: a dump from a different schema version also leaves the process with a generated Prisma client that no longer matches the database, which reconnecting cannot fix, and the monitor/discovery roles have their own pools this call cannot touch. Hence `restartRequired: true` on the route response and the restart banner in the UI. Found by actually running the round trip against a real database — the pre-2026-08 code had the same defect and the route reported plain success.
- **File format is a compatibility contract.** `"POLARIS " | salt(32) | iv(16) | authTag(16) | AES-256-GCM(gzip(sql))`, unchanged across the rewrite so operators' existing `.enc.gz` files still restore. Pinned by `tests/unit/backupEnvelope.test.ts`.
- A failed backup deletes its partial file — never leave a truncated file masquerading as a usable backup.
- Backup ids are server-generated (`bk-` / `bk-pre-update-` / `bk-scheduled-` + timestamp) but the delete/download routes accept them from the URL, so `backupFilePath` requires containment under `BACKUP_DIR` before any filesystem access.
- History lives in the `backup_history` Setting row, capped at 50 entries. A history-write failure is logged but does NOT fail the backup — the file on disk is valid, only the index entry is missing.

**When changing this:**
- Run `tests/integration/backupRestore.test.ts` on a host with `pg_dump`/`psql` AND the timescaledb extension installed. It skips silently otherwise, so a green local run is not coverage of the Timescale gates — the test logs which branch it took.
- Never reintroduce `readFileSync` / `gzipSync` / `execSync` on this path, and never size a backup with `readFileSync(f).length` (use `statSync(f).size`).
- If you change the envelope layout, bump the magic header — do not silently reinterpret bytes, or every existing encrypted backup becomes unrestorable with no error the operator can act on.
- Keep `post_restore` in a `finally`. Any early return between `pre_restore` and it strands the database in restoring mode.

---

## services/backupScheduleService.ts

**What it owns:** The operator-configured automatic-backup cadence — the `backupSchedule` Setting row, its validation/merge rules, the pure due-check, and the off-host copy helper.

**Public API:** `getBackupSchedule` (full, INCLUDING the passphrase — internal callers only), `getBackupScheduleMasked` (API shape), `saveBackupSchedule`, `recordScheduledBackupOutcome`, `isScheduledBackupDue(schedule, now)` (pure), `copyBackupOffHost`, `invalidateBackupScheduleCache`, `defaultBackupSchedule`, plus the bounds constants.

**Cross-service deps:** `services/settingsStore.ts` (TTL-cached Setting accessor), `utils/secretMask.ts`, `utils/backupPassword.ts`.

**Used by:** `src/jobs/scheduledBackup.ts — the 5-minute tick`; `src/api/routes/serverSettings.ts — GET|PUT /database/backup-schedule`.

**Invariants:**
- **Default `enabled: false`.** Many sites already back this Postgres up with an enterprise product, and an in-app update must not start writing gigabytes unasked. Turning it on is an operator action.
- **Never-run means due immediately.** Enabling the feature must produce a recovery point now, not `intervalHours` later.
- **A missed pinned hour is not skipped forever.** `hourUtc` holds an otherwise-due run until that hour, but past 2× the interval it runs anyway — a host that is down through 03:00 every night would otherwise never back up.
- `lastRunAt` advances only on SUCCESS, so a failing schedule keeps retrying rather than silently marking itself done. `lastError` carries the most recent failure for the settings card.
- Run bookkeeping (`lastRunAt`, `lastError`) is owned by the job, never by operator input — `saveBackupSchedule` preserves both.
- Passphrase handling follows the shared secret convention: masked on read, a masked echo preserves the stored value, an empty string clears it, a new value is strength-checked by `validateBackupPassword`.
- `copyToDir` must be ABSOLUTE. A relative path would resolve against the service's cwd, which is not something an operator can reason about.
- The off-host copy is best-effort: the local backup already succeeded, and a full or unmounted share must not mark the run failed (it writes a warning Event instead).
- Retention prunes ONLY `kind === "scheduled"` backups. A cadence must never delete the manual backup an operator took deliberately, or a pre-update recovery point.

**When changing this:**
- `isScheduledBackupDue` is pure precisely so the cadence is testable without a clock — keep it that way and extend `tests/unit/backupSchedule.test.ts`.
- The passphrase lives in a Setting row, so it is covered by the secret-at-rest sealing in `db.ts` (`Setting.value`, key `passphrase`). Do not rename the field without adding the new name to `SECRET_CONFIG_KEYS`.
- If you add a cadence dimension, decide explicitly what it does when the host was down through the window — silently skipping is the failure mode this service is designed against.

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

## services/storageForecastService.ts

**What it owns:** Per-filesystem "days until full" forecasting — the ONE shared computation behind the Storage Forecast dashboard widget (nocDashboardService `storageForecast` feed) and the `storageDaysUntilFull` automation metric (notificationEngine's asset-metric resolver).

**Public API:** `computeStorageForecast(assetIds | null, lookbackDays?, minPoints?)` → `StorageForecastRow[]` (assetId, mountPath, daysUntilFull, usedPct, slopeBytesPerDay, points; soonest-full first), plus the tuning constants `FORECAST_LOOKBACK_DAYS` (30), `FORECAST_MIN_POINTS` (7), `FORECAST_MAX_DAYS` (365).

**Cross-service deps:** `prisma` (raw regr_slope aggregate over `asset_storage_samples` + `asset_storage_samples_daily`), `utils/linearTrend.daysUntilFull`.

**Used by:** `nocDashboardService.getStorageForecast` (widget feed), `notificationEngine.resolveAssetMetricReadings` (the `storageDaysUntilFull` case — dimKey = mountPath, so single-trigger rules alert per filesystem and composite leaves fold ANY-mount).

**Invariants:**
- Trend source is a UNION of day-bucketed DETAIL samples (7-day retention — covers every storage-scraped asset, incl. the slow 24h cadence) and the DAILY rollups (365-day retention but **cadence='fast' pinned assets only** — sampleRollupService's sqlStorageHourly cadence filter). Never rely on the rollups alone: unpinned assets would silently vanish from the forecast.
- Growing mounts only (regr_slope > 0 in the HAVING) with ≥ minPoints distinct days — a flat/shrinking/new filesystem produces NO row, which is what keeps `storageDaysUntilFull <= N` automations silent for healthy mounts (absence of a reading is never a firing signal).
- READ-ONLY over the hypertable + rollup table; one aggregate query, flat at 2000 assets.

**When changing this:** The lookback/min-points defaults are user-visible semantics (widget copy + metric help in notificationTypes) — change them in lockstep. If storage rollups ever stop filtering on cadence, the UNION dedup keeps working but the detail arm becomes redundant past 7 days.

---

## services/nocDashboardService.ts

**What it owns:** Fleet-wide read-only aggregates for the SolarWinds-style NOC dashboard widgets, surfaced via `GET /dashboard/noc-summary`.

**Public API:** `getNocSummaryPayload` (the route's entry point: `NOC_FEEDS` registry over the 13 `NOC_FEED_NAMES`, per-feed permission gates + empty values + response-key flattening, every (feed, filter, cap[, samples]) computation served through a shared 10s `createTtlCache` — `NOC_FEED_CACHE_TTL_MS`, `clearNocFeedCache()` test hook; only the `usesSamples` feeds key on the samples count), plus the per-feed functions `getStatusSummary`, `getDownNodes`, `getDownInterfaces`, `getDownIpsecTunnels`, `getHighestCpu`, `getHighestMemory`, `getSlowestResponse`, `getPacketLoss`, `getHighestDiskUsage`, `getStalePolls`, `getRecentReboots`, `getRecentAlerts`, `getSitesWithIssues`, `resolveFilteredAssetIds` (+ exported result interfaces). Every feed takes a trailing `assetIds: string[] | null` arg; `resolveFilteredAssetIds({assetTypes, regionNames, fortigateNames})` produces that set (or null = unfiltered) — `fortigateNames` (the widgets' "Selected FortiGates" per-site narrowing, `?fortigates=`) matches assets behind any named gate via `learnedLocation` equals-insensitive OR any `AssetFortigateSighting.fortigateDevice`, the same two haystacks as the tag/maintenance "Behind FortiGate" criteria but exact-only, ANDed with the type/region dimensions; the `FORTIGATE_NONE_SENTINEL` (`__none__`, the picker's "(No FortiGate)" entry) instead matches gate-less assets (zero sightings AND learnedLocation not any known gate's name). `getFilterOptions` additionally returns `fortigates` (`{name, regions}` per distinct live-firewall `learnedLocation`, name-sorted — regions = the gate's own `region:` tags so the widget picker narrows its list to the selected regions client-side) for the picker. `getHighestCpu`/`getHighestMemory` additionally take a `sampleCount` (the widgets' "Average over" gear control via `?samples=`; default `DEFAULT_TOPN_SAMPLE_COUNT` = 10, ceiling `MAX_TOPN_SAMPLE_COUNT` = 100, 1 = rank on the latest sample only) — the scan window scales at 6 min/sample (`topNWindowMinutes`, 1h at the default) so it always holds N samples while staying chunk-excluded. `getDownInterfaces` = interfaces admin-up + oper-down grouped by gate (firewall→own hostname, managed FortiSwitch/FortiAP→parent `learnedLocation`); one windowed single-pass CTE over `asset_interface_samples` joined to `assets` on `ifName = ANY(monitoredInterfaces)` — only interfaces selected for monitoring qualify, filtered before the LIMIT — (latest-per-`(asset,ifName)` + last-up timestamp) then a monitored/non-suppressed hydrate findMany. `getDownIpsecTunnels` = same shape over `asset_ipsec_tunnel_samples` (`status='down'`), with the same pin gate joined on `tunnelName = ANY(monitoredIpsecTunnels)` — only tunnels selected for monitoring qualify (an unpinned dead-parent tunnel's CMDB-synthesized samples stay fresh forever, so without the gate it would show as a permanent outage) — carrying each tunnel's `parentInterface` (phase1-interface WAN port). The `downInterfaces` widget merges both feeds into one gate-grouped list (gates youngest-outage-first, rows alphabetical within each gate, merged pre-clip total as a red header pill). `getDownNodes` returns `{ nodes, total }` where `total` is the TRUE down count (indexed `asset.count` over the same where, run in parallel — NOT the limit-capped rows.length); the feed's flatten exposes it as `downNodesTotal` for the Down Nodes widget's header pill. `getPacketLoss` excludes 100%-loss assets in the SQL HAVING (requires ≥1 failure AND ≥1 success in the window) — a fully-down asset is a Down Nodes matter, not packet loss. **Timezone rule (applies to EVERY raw window predicate here and in autoMonitorInterfaces/autoMonitorStorage/interfaceTopology/capacityService):** Prisma timestamp columns are naive UTC; bare `now()` makes Postgres interpret them in the SERVER TimeZone (RHEL-native Postgres defaults to the system zone), silently shifting every "last N minutes" window by the UTC offset — a 15-min packet-loss window read ~5¼h of history and reported 50% loss on a healthy device. Always `(now() AT TIME ZONE 'UTC')` in raw SQL against Prisma-written timestamps; Prisma-bound Date params are unaffected. Unit-tested on getPacketLoss. Every top-N hydrate (`hydrateNames` + the per-volume disk and per-sensor temperature hydrates) attaches `TopNRow.site` (the Down Nodes `siteOf` coalesce) for the shared `_topnBar` Group-by-Site view.

**Used by:** `src/api/routes/dashboard.ts` (`/dashboard/noc-summary` → `getNocSummaryPayload`; the route only parses `?feeds=`/`?assetTypes=`/`?regionTags=`/`?fortigates=`/`?limit=`/`?samples=` and resolves permissions — filter resolution, feed fan-out, and the 10s per-feed cache live in the service). Frontend NOC widgets each fetch only their own feed via `PolarisWidgets.getNocSummary(opts, feeds)` (15s memoized **per (feeds, filter, limit, samples)**) in `public/js/widgets/`, so a widget renders as soon as its own feed returns. Adding a feed = add a `NOC_FEEDS` registry entry (gate + empty + runner + optional flatten), not a route change.

**Reads:** `Asset` (monitorStatus, monitored, dependencySuppressed, assetType, tags, location/learnedLocation/snmpLocation, department, lastMonitorAt, latitude/longitude); `asset_telemetry_samples` + `asset_monitor_samples` + `asset_storage_samples` + `asset_interface_samples` (down interfaces: oper/admin status latest-per-interface + last-up timestamp) + `asset_ipsec_tunnel_samples` (down tunnels: status latest-per-tunnel + parentInterface + last-up timestamp) hypertables (read-only DISTINCT-ON / groupBy / windowed `row_number()` for the rolling averages + per-volume disk used % + down interfaces + down tunnels, never write/delete); `Event` (`device.reboot` for reboots, `levelRank>=1` for active alerts). Calls `monitoringService.resolveMonitorSettings` for stale-poll cadence.

**Invariants:**
- `activeAlertCount` uses the EXACT `monitorAlerts` where-clause (`monitored, monitorStatus in [warning,down], dependencySuppressed:false, status not maintenance`) so the tile count and the alert list agree — the `/summary` monitorAlerts findMany in `routes/dashboard.ts` must be kept in lockstep.
- **Maintenance windows are not outages:** `status="maintenance"` freezes `monitorStatus` (possibly at down/warning), so every down/warning/stale surface excludes it — the shared `NOT_IN_MAINTENANCE` spread on the Prisma feeds (status tiles, downNodes, the down-interface/tunnel hydrates, stalePolls — where the exclusion also stops every polling-paused asset drifting into "stale" past the grace) and `AND "status" <> 'maintenance'` in the sites-with-issues raw SQL FILTER/HAVING. `getStatusSummary` counts them into their own `statusCounts.maintenance` bucket (still in `total`, never in up/down/warning/unknown or the uptime gauge); the Status Summary widget renders it as the purple "Maint" tile, matching the Status Map's purple dot (siteMap.js keys off `site.status` from `/map/sites`).
- Top-N CPU/Memory and slowest-response are each the **avg of the most-recent N samples per asset** (windowed `row_number()<=N` then `avg`; CPU/Mem N = the caller's `sampleCount`, default 10 — the widgets' "Average over" control — slowest-response is fixed at 10); packet-loss is a failed-probe ratio. All scan only recent (chunk-excluded) hypertable rows via a `now() - interval` predicate (CPU/Mem 6 min × N, ≥1h; response 6h); names hydrated in ONE `findMany` (no per-row lookup). Never row-DELETE/UPDATE the sample tables.
- `getStalePolls` pre-filters with `@@index([monitored, lastMonitorAt])` then resolves the exact cadence per candidate via the cached `resolveMonitorSettings` — don't reimplement the tier hierarchy; suppressed assets use 2× interval (mirrors monitorAssets).
- Permission-denied feeds return their `empty` value WITHOUT entering the TTL cache — a denied caller must never poison (or be served from) a granted caller's cache slot. Errors are never cached either (`createTtlCache` evicts rejections).
- The no-`?feeds=` response shape is frozen (external kiosk consumers + `tests/integration/dashboardNocToken.test.ts`): `status` flattens to the three tile keys, `downNodes` unwraps `.nodes`.
- `getSitesWithIssues` coalesces `location > learnedLocation > snmpLocation > "(unknown)"`; the same coalesce key buckets the node detail rows.
- **Severity-first ordering + per-widget relevance (2026-07):** every asset-sourced feed decorates its rows with the owning asset's highest ACTIVE automation alert (`activeAlertSeverityByAsset` over uncleared Notification rows joined to `rule.trigger`; `ALERT_SEVERITY_RANK` covers the 5-level vocabulary + legacy info/error) via `attachAlertSeverity`, then sorts `severityFirst` (STABLE — equal ranks keep the feed's own order: value desc / youngest outage / most overdue). **The pill is SCOPED to each widget's own dimension** — a row pills only when the firing automation's trigger is *about what the widget measures*, so a fast/low-CPU asset no longer wears a "serious" pill sourced from an unrelated disk/interface alert. Each feed passes an `AlertRelevance` (`metricRel`/`stateRel`/`eventRel`/`{kind:"none"}`): CPU→`cpuPct`, Memory→`memPct`|`memUsedBytes`, Slowest Response→`responseTimeMs`, Packet Loss→`probeLossPct`, Disk→`storageUsedPct`, Temperature→`hwSensorValue`, Storage Forecast→`storageDaysUntilFull`, Down Nodes/Sites→state `monitorStatus`, Down Interfaces→state `ifOperStatus`, Down IPsec→state `ipsecStatus`, Recent Reboots→event `device.reboot` (glob-matched), Stale Polls→`none` (no matching automation dimension, never pills). `triggerMatchesRelevance` walks composite trigger trees (matches if ANY leaf matches); a rule-deleted (null-trigger) notification matches nothing but `{kind:"any"}`. **When you add a new metric widget, give its feed the matching `AlertRelevance` or it silently shows no pill.** One bounded notification findMany per feed run, scoped to the rows' own asset ids, inside the 10s feed cache. `getRecentAlerts` (Event-sourced) instead orders `levelRank desc, timestamp desc`; `getSitesWithIssues` takes the max rank across each site's affected nodes. Widgets render the rank via `PolarisWidgets.alertSeverityPill`, whose class map mirrors the canonical `badge-level-*` scale (notice→grey `widget-pill-neutral`, informational→blue `-watch`, warning→yellow `-amber`, serious→orange `-orange`, critical→red `-red`) so a severity reads identically to the Automations page. **Count pills follow the row pills:** the group-header and header-total counts on Down Nodes / Down Interfaces color off the same map via `PolarisWidgets.countPillClass(rows)` / `setHeaderCount(el, count, PolarisWidgets.maxAlertSeverity(rows))` rather than the flat `widget-pill-red` they used to hardcode — a gate whose interfaces are all `serious` was reading critical-red. They fall back to red when no row carries an alert (no severity to honor; red stays the generic down-count). **Down Interfaces and Highest Temperature show the SPLIT rather than the worst** (2026-08): `setHeaderSeverityCounts(el, rows[, {unalerted, severityOf}])` stamps one header pill per active severity in the set (counted by `alertSeverityCounts`, most severe first, each in its own color) — Down Interfaces keeps the total honest with a trailing grey `unalerted:"neutral"` bucket and falls back to the red total when nothing alerts, while Highest Temperature opts in through `_topnBar`'s `headerSeverityCounts` flag with `unalerted:"omit"` (a top-N row count is the Row limit, not a fleet total). Both go through `setHeaderPills`, the one owner of the `.widget-header-count` container; enabling the pills on the other top-N widgets is one flag each. Count pills over rows that aren't severity-tiered (Sites With Issues, the threshold-colored Stale Polls / Conflict Queue / Capacity counts) deliberately keep their own color rule. The rank ladder is additionally mirrored client-side as `PolarisWidgets.ALERT_SEVERITY_RANK` (widgets/index.js), which drives the severity-bearing listing widgets' header ⤓ CSV export tiers (`setHeaderExport`: All / Critical only / Serious and up / Warning and up over the full pre-clip row set) AND the gear popover's **Minimum severity** display filter — both read the ONE tier ladder `PolarisWidgets.SEVERITY_TIERS` (All rows / Notice / Informational / Warning / Serious and up / Critical only; the export menu takes the four historical tiers off it), so the two surfaces can't disagree about what "Serious and up" means. `filterByMinSeverity(rows, config[, severityOf])` narrows a widget to rows whose alert ranks at/above `config.minSeverity`, applied BEFORE the row limit / red guarantee / header count / CSV export so every number the widget shows agrees — safe client-side precisely BECAUSE these feeds are `severityFirst`-sorted server-side (the qualifying rows are the ones that survive the row cap). Any tier past "All rows" therefore hides un-alerted rows entirely (that's the point; the popover hint says so, and `minSeverityEmptyText` makes an emptied widget read "No rows at or above serious severity" instead of "No nodes down"). Wired on Down Nodes / Down Interfaces / Storage Forecast / all six top-N widgets (once, in `_topnBar`) + Active Alerts, whose pre-control `severities` checkbox array folds into a tier through `severityTierForRank`. Keep the ladder in lockstep with this file's `ALERT_SEVERITY_RANK`; widgets must NOT re-sort by value alone (`_topnBar.renderRows` sorts (alertRank, value); `downInterfaces.mergeRows` sorts (alertRank, lastUpAt); the fillTo red-guarantee filters by position-or-redness since red rows are no longer a contiguous head).

**When changing this:**
- Scale-check at 2000 assets — keep every feed to groupBy/count/one windowed aggregate/one bounded findMany.
- Recent Reboots depends on `device.reboot` Events emitted by `recordProbeResult` (sysUptime drop) — see cross-cutting reboot-detection notes; the widget never scans the hypertable.

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

**What it owns:** Built-in vendor telemetry profiles (Cisco, Juniper, Mikrotik, Fortinet FortiSwitch, Fortinet FortiAP, Fortinet FortiGate, HP-Aruba, Dell) matching assets by manufacturer + OS + model regex and exposing symbolic OID queries for CPU / memory / disk / temperature — plus, on FortiSwitch, a `model` identity query — via oidRegistry resolution.

**Public API:** `VENDOR_TELEMETRY_PROFILES`, `pickVendorProfile`, `memoryQueryToDoubleScalar`, `VendorTelemetryProfile`, `CpuQuery`, `MemoryQuery`, `DiskQuery`, `TemperatureQuery`, `ModelQuery` (symbol + parse fn; FortiSwitch `fsSysVersion` → `utils/fortiswitchModel.ts` — consumed by `collectSystemInfoSnmp`, adopted onto `Asset.model` by `recordSystemInfoResult` only while the stored model is empty/generic; NOT part of the editable ManufacturerProfile surface — `pickVendorProfileMerged` only overrides cpu/memory/temperature, so the hardcoded profile is the model query's only source). `memoryQueryToDoubleScalar(mem)` translates a hardcoded `MemoryQuery` into the editable Manufacturer Profile's double-scalar shape (`{type, symbol, symbolB, transform}` with the matching `CombinerKind`) — consumed by `seedManufacturerProfiles` and `backfillManufacturerProfileMemoryComposition`. Returns null for empty memory blocks.

**Cross-service deps:** None (vendorTelemetryProfiles is leaf; consumed by monitoringService + mibService).

**Used by:** `src/services/monitoringService.ts — probe strategy selection for telemetry`, `src/services/mibService.ts — profile status reporting in MIB database UI`.

**Invariants:**
- `match` regex is tested against `"${manufacturer ?? ''} ${os ?? ''} ${model ?? ''}".trim()` (all three fields optional).
- Entries ordered in priority; first match wins (no fallback after). Both FortiSwitch and FortiAP must precede the generic Fortinet entry because all three match `manufacturer="Fortinet"`; the model-specific regexes (`/fortiswitch/i`, `/fortiap/i`) sit before the broad `/fortinet|fortigate|fortios/i` so FortiSwitches/FortiAPs don't fall into the FortiGate OID tree.
- CPU/memory/temperature symbols resolve from one of three layers (in priority order): an uploaded MIB at the asset's scope, an entry in `oidRegistry`'s `BUILT_IN_OIDS` seed (currently covers Cisco / Juniper / HP-Aruba / Dell-RADLAN / Fortinet FortiGate + FortiSwitch + FortiAP — these vendors show "READY" out of the box), or — when neither resolves — the HOST-RESOURCES-MIB fallback inside the probe.
- `TemperatureQuery.mode` is `"scalar" | "table"`. `pickVendorProfileMerged` maps the manufacturer-profile `temperature` metric's `type`: `table` → `mode: "table"` (the SNMP collector runs the full `fgHwSensorTable` hardware-sensor walk via `collectHardwareSensorsFortinetSnmp`), `scalar` → `mode: "scalar"` (single `.0` reading, used by FortiAP `fapTemperature` after the fgHwSensorTable + ENTITY-SENSOR walks both come back empty). This is what makes the operator's `table` / `fgHwSensorTable` profile override actually populate (it was silently coerced to a broken scalar GET before the Hardware Sensors work).
- Profile selection is read-only; no runtime mutations. (The `model` identity query's DOWNSTREAM write — `recordSystemInfoResult` stamping `Asset.model` — is guarded: only while the stored model is empty or matches /^fortiswitch\b/i, so operator-typed models survive and a hardware swap self-heals.)
- The parsed model value must keep matching /fortiswitch/i (the `"FortiSwitch <token>"` prefix from `fortiswitchModelFromFsSysVersion`) — the profile `match` haystack includes the model and FortiSwitch assets carry no `os`, so a bare token would drop the asset into the generic Fortinet/FortiGate profile whose 12356.101 OIDs a FortiSwitch doesn't expose. The persisted ManufacturerProfile override's `modelPattern: "FortiSwitch"` regex relies on the same prefix.

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

**Used by:** src/api/routes/integrations.ts — discovery trigger, test connection. src/services/discovery/discoveryEngine.ts — subnet sync.

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

---

## services/weatherProxyService.ts

**What it owns:** Server-side proxy + cache for the Status Map widget's weather overlay: RainViewer radar frame index (5 min TTL, serve-stale ≤30 min on upstream failure), radar tile PNGs (immutable per frame-id content hash → size-bounded FIFO cache, ~48 MB / 4000 entries, no TTL), and Open-Meteo current temperature (20 min TTL per 1.5° grid cell).

**Public API:** `getRadarFrames()`, `getRadarTile(frameId, z, x, y)`, `getTemperature(lat, lng)`, `__resetWeatherProxyCachesForTests()`.

**Cross-service deps:** None (global fetch to api.rainviewer.com / tilecache / api.open-meteo.com; `getAppVersion()` for the User-Agent). No DB, no Events — public weather data only.

**Used by:** src/api/routes/weather.ts (mounted on the main router at `/weather` under requireAuth AND on the Dash listener via its `/weather/` prefix allowlist + `dashWeatherLimiter`). The consumer is public/js/widgets/siteMap.js (proxy-first, direct-CDN fallback).

**Invariants:**
- Tile requests validate the frame id against the union of the last TWO index generations — grace so an animation started just before an index rotation keeps resolving, and a hard gate so the endpoint can't be used as an open proxy to arbitrary upstream paths.
- Frame ids are content hashes → a cached tile can never go stale; the route serves `Cache-Control: public, max-age=86400, immutable` (deliberately overriding the Dash listener's blanket no-store).
- Temperature grid rounding (1.5°) must match siteMap.js loadTemps' grid key, or every viewer becomes a cache miss.
- Transport failures throw AppError 502 and never poison any cache (geocoderService precedent); the widget interprets non-200 as "fall back to the CDN for this cycle/cell".
- Tile render options (256px, color scheme 6, "1_1") are hardcoded to match the widget's direct-CDN URL template — a mismatch would make proxy and fallback look different.
- In-flight dedupe on the index and per-tile fetches — a 14-frame layer add must not stampede upstream.

**When changing this:**
- Keep the CSP fallback hosts (api.rainviewer.com / *.rainviewer.com / api.open-meteo.com in securityHeaders.ts) as long as the widget's CDN fallback exists.
- If tile URL options change, change siteMap.js's fallback template in the same commit.
- The dash rate limiter (`dashWeatherLimiter`, 4000/5min) is sized to radar bursts (~14 frames × viewport tiles); revisit if frame count or tile size assumptions change.
- Scale check: cache is per-process; in the split-role layout only the web + dash processes serve this (no monitor/discovery involvement).
