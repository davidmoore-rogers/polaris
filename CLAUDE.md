# Polaris — Claude Code Project

## Project Overview

**Polaris** is an IP management tool that allows users to reserve and manage IP address space (IPv4 and IPv6) for use across other infrastructure projects. Named after the North Star — a fixed reference point operators can navigate by when wiring up everything else. It provides a central registry for subnets, individual IPs, and reservations — preventing conflicts and giving teams visibility into IP utilization.

> **Naming:** the project was previously called Shelob and has been fully rebranded — every on-host identifier (install path, system user, Postgres DB/user, systemd unit, NSSM service name, firewall rule label), browser-side identifier (CSRF cookie, localStorage keys), and source-level constant (argon2 timing dummy, encrypted-backup magic) now uses `polaris` / `Polaris` / `POLARIS`. Encrypted backups are versioned by the 8-byte magic header `POLARIS\0`; the previous `SHELOB1\0` format is no longer recognized. Existing installs migrate via dump-and-reinstall (plain `pg_dump` carries cleanly into a polaris-named DB).

Version policy: `<major>.<minor>` lives in `package.json` and is the single source of truth — pre-release line is the 0.x series, bump the minor (e.g. `0.9.0` → `0.10.0`) when cutting a named release. The patch is the git commit count, computed at runtime by `src/utils/version.ts`: it reads `POLARIS_BUILD_COMMIT_COUNT` (baked into the Docker image at build time) when set, otherwise falls back to `git rev-list --count HEAD` for RHEL prod / dev where the .git tree is present. Never edit the patch in package.json — it stays `<major>.<minor>.0` there. Version is shown in the sidebar and embedded in backup filenames.

---

## Architecture

```
polaris/
├── CLAUDE.md
├── README.md
├── .env.example
├── package.json
├── tsconfig.json
├── prisma.config.ts                 # Prisma 7 config (datasource URL, seed command)
├── demo.mjs                         # Demo/seed script
├── prisma/
│   ├── schema.prisma                # Database schema
│   └── seed.ts
├── docs/
│   └── INSTALL.md                   # Fresh-install guide (RHEL/Rocky/AlmaLinux 9, Ubuntu/Debian, Windows Server). Includes disk-sizing requirements per volume (DB ≥50 GB, app/state ≥5 GB, /var/log ≥5 GB on STIG layouts) and recovery steps for the "/var is full and Postgres is crash-looping" case. Don't follow this for upgrades — those use the in-app updater under Server Settings → Maintenance → Updates.
├── scripts/
│   ├── test-fmg.mjs                 # FortiManager integration test harness
│   ├── audit-multi-mac-assets.ts    # One-off: unstitch assets cross-stapled by old IP-fallback bug
│   └── check-fmg-tokens.ts          # One-off: print stored FMG/FortiGate token length/prefix to diagnose token corruption
├── public/                          # Vanilla JS frontend (served statically)
│   ├── index.html                   # Dashboard
│   ├── login.html
│   ├── setup.html                   # First-run wizard
│   ├── blocks.html
│   ├── subnets.html
│   ├── assets.html
│   ├── integrations.html
│   ├── events.html
│   ├── users.html
│   ├── server-settings.html
│   ├── logo.png
│   ├── map.html                     # Device Map page (Leaflet basemap + Cytoscape topology modal)
│   ├── mobile.html                  # Phone-targeted SPA (Material 3). Single document, hash-routed, reuses /api/v1 + session auth from the desktop app. Phone-class user-agents hitting `/` or `/index.html` are auto-redirected here by the UA middleware in `src/app.ts`; the `?desktop=1` query param is the escape hatch the More tab's "Desktop view" link uses to bypass the redirect.
│   ├── css/
│   │   ├── styles.css
│   │   ├── map.css                  # Device Map styles (marker icons, topology modal grid)
│   │   ├── mobile.css               # Material 3 component library for mobile.html (tonal surfaces, navigation bar, list items, chips, sheets)
│   │   └── vendor/leaflet/          # Leaflet + markercluster CSS + marker PNGs (bundled; CSP blocks external CDN)
│   └── js/
│       ├── api.js                   # HTTP client with auth/error handling. 401 redirect goes to /login.html unless `window.__polarisOn401` is set (mobile app sets this to route back to its in-app login).
│       ├── app.js                   # Navigation, layout, theme switching
│       ├── dashboard.js
│       ├── blocks.js
│       ├── subnets.js
│       ├── assets.js
│       ├── integrations.js          # Discovery progress, abort
│       ├── events.js                # Audit log viewer, syslog/SFTP settings
│       ├── users.js
│       ├── ip-panel.js
│       ├── map.js                   # Device Map: Leaflet markers, autocomplete search, Cytoscape topology modal
│       ├── table-sf.js
│       ├── mobile/                  # Mobile SPA bundle (loaded by mobile.html). router.js (hash routing), auth.js (login + TOTP screens), map-tab.js (Device Map tab — lazy-loads Leaflet/markercluster, plots health-coded firewall pins, opens a bottom sheet on tap; backs both #map and #site/<id>), assets-tab.js (Assets tab — paged card feed with type filter chips, tap-through to asset detail), tabs.js (per-tab registry + Search renderer + shared snackbar helper), details.js (detail-route renderers — asset / subnet / block / site; site delegates to map-tab), app.js (orchestrator: bootstraps auth, mounts the tab shell, dispatches tab and detail routes; detail specs may carry a `parentTab` to keep the corresponding navbar item highlighted).
│       └── vendor/                  # Bundled: jspdf, leaflet/, cytoscape, dagre, cytoscape-dagre
├── src/
│   ├── index.ts                     # Entry point
│   ├── config.ts                    # App config / env vars
│   ├── db.ts                        # Prisma client singleton
│   ├── httpsManager.ts              # TLS certificate management
│   ├── api/
│   │   ├── router.ts                # Express router aggregator + auth guards
│   │   ├── middleware/
│   │   │   ├── auth.ts              # Session auth + RBAC middleware
│   │   │   ├── csrf.ts              # Synchronizer-token CSRF protection (`polaris_csrf` cookie + `X-CSRF-Token` header)
│   │   │   ├── validate.ts          # Zod request validation middleware
│   │   │   └── errorHandler.ts      # Global error handler
│   │   └── routes/
│   │       ├── auth.ts              # Login, logout, Azure SAML SSO
│   │       ├── blocks.ts            # IP block CRUD
│   │       ├── subnets.ts           # Subnet CRUD & allocation
│   │       ├── reservations.ts      # Reservation CRUD
│   │       ├── utilization.ts       # Reporting endpoints
│   │       ├── users.ts             # User CRUD & role management
│   │       ├── integrations.ts      # FMG / FortiGate / Windows Server / Entra ID config & discovery
│   │       ├── assets.ts            # Device inventory CRUD, PDF/CSV export
│   │       ├── map.ts               # Device Map: site list, search, per-FortiGate topology graph
│   │       ├── events.ts            # Audit log, syslog, SFTP archival
│   │       ├── conflicts.ts         # Discovery conflict review & resolution
│   │       ├── search.ts            # Global typeahead search across all entity types
│   │       ├── allocationTemplates.ts # CRUD for saved multi-subnet allocation templates
│   │       ├── credentials.ts       # CRUD for the named-credential store used by monitoring probes (SNMP / WinRM / SSH)
│   │       ├── manufacturerAliases.ts # Admin CRUD for the manufacturer alias map (Fortinet, Inc. → Fortinet, etc.)
│   │       └── serverSettings.ts    # HTTPS, branding, backup/restore
│   ├── services/
│   │   ├── ipService.ts             # Core IP math & validation
│   │   ├── blockService.ts          # Block business logic
│   │   ├── subnetService.ts         # Subnet allocation logic
│   │   ├── reservationService.ts    # Reservation business logic
│   │   ├── reservationPushService.ts # Push manual DHCP reservations to FortiGate via an FMG integration (proxy or direct realtime, with read-back verify); used by reservationService on create + release
│   │   ├── reservationStaleService.ts # Stale-reservation detection: settings (staleAfterDays), alert lister (active|ignored), snooze/ignore mutators, and the job entry point that emits reservation.stale Events
│   │   ├── utilizationService.ts    # Utilization reporting
│   │   ├── fortimanagerService.ts   # FMG JSON-RPC client & discovery orchestration
│   │   ├── fortigateService.ts      # Standalone FortiGate REST API client & discovery
│   │   ├── windowsServerService.ts  # Windows Server WinRM DHCP discovery
│   │   ├── entraIdService.ts        # Microsoft Entra ID + Intune device discovery via Graph
│   │   ├── activeDirectoryService.ts # On-premise Active Directory computer discovery via LDAP/LDAPS
│   │   ├── searchService.ts         # Global typeahead search (classifies IP/CIDR/MAC/text; parallel entity queries)
│   │   ├── allocationTemplateService.ts # Saved multi-subnet allocation templates (Setting-backed)
│   │   ├── autoMonitorInterfacesService.ts # "Auto-Monitor Interfaces" feature: pure resolver (names/wildcard/type modes) + DB-bound aggregate/preview/apply for the FMG/FortiGate Monitoring tab. Strictly additive to Asset.monitoredInterfaces.
│   │   ├── assetIpHistoryService.ts # Asset IP history reads, retention settings, pruning (Setting-backed)
│   │   ├── discoveryDurationService.ts # Rolling discovery-duration samples + "slow-run" threshold (Setting-backed)
│   │   ├── azureAuthService.ts      # Azure AD/Entra SAML SSO, user provisioning
│   │   ├── totpService.ts           # RFC 6238 TOTP secret / code / backup-code helpers
│   │   ├── dnsService.ts            # Reverse DNS lookup for assets
│   │   ├── ouiService.ts            # MAC OUI lookup with admin overrides
│   │   ├── deviceIconService.ts     # Operator-uploaded device icons. Validates uploads (PNG/JPEG/WebP only, 256 KB cap, magic-byte check), stores bytes in the DeviceIcon model, exposes resolveIconUrl(asset, cache) for the topology endpoint to stamp `iconUrl` on each node.
│   │   ├── eventArchiveService.ts   # Syslog (CEF) + SFTP/SCP event archival
│   │   ├── projectionDriftService.ts # Phase 3b.0 shadow projection drift detection. After every successful AssetSource upsert, compares projectAssetFromSources output against current Asset values; logs disagreements to pino with `event: "asset.projection.drift"`. Best-effort and fire-and-forget.
│   │   ├── serverSettingsService.ts # HTTPS, branding, backup/restore
│   │   ├── credentialService.ts     # Named credential store (SNMP / WinRM / SSH) with masking + secret-preservation merge
│   │   ├── manufacturerAliasService.ts # Manufacturer alias map: CRUD + cache + idempotent default seed + backfill of existing Asset/MibFile rows
│   │   ├── mibService.ts            # SNMP MIB module storage + minimal SMI parser (validates uploads, extracts moduleName + IMPORTS)
│   │   ├── oidRegistry.ts           # Symbolic name → numeric OID resolver. Per-asset **scoped** resolution: device-specific MIBs override vendor-wide MIBs override generic MIBs override the built-in SMI seed. Each scope is computed lazily and cached; cache + parsed entries refresh on MIB upload/delete and at app startup. Tracks per-symbol provenance so the UI can show which MIB provided each resolved name.
│   │   ├── vendorTelemetryProfiles.ts # Per-vendor SNMP CPU/memory profile registry. Maps `manufacturer + os` regex → symbolic OID names; resolved through oidRegistry at probe time. Built-ins for Cisco / Juniper / Mikrotik / Fortinet (SNMP path) / HP-Aruba / Dell.
│   │   ├── monitoringService.ts     # Authenticated response-time probes (fortimanager/fortigate/snmp/winrm/ssh/icmp) + System tab telemetry (CPU/memory) + system-info (interfaces/storage) collection. runMonitorPass dispatches all three cadences; per-stream retention prune helpers.
│   │   ├── capacityService.ts       # Capacity snapshot: host (cpu/ram + per-volume disk free), DB sample-table breakdown, monitoring workload + steady-state size projection, severity grading (ok/watch/amber/red). Volume scan walks every distinct filesystem Polaris/Postgres write to (app dir, state dir, backups dir, plus the PostgreSQL data directory when DB is co-located — resolved authoritatively via `SHOW data_directory`, falling back to platform-conventional paths like `/var/lib/pgsql/...` when SHOW fails because the application's DB role lacks `pg_read_all_settings`), deduped by stat.dev so single-LV installs collapse cleanly and STIG-style multi-LV layouts surface each filesystem once. `recordCapacityTransition()` compares against a stored `capacity.lastSeverity` Setting and writes one `capacity.severity_changed` Event on each transition (any direction), routed out through eventArchiveService → syslog/SFTP so an alert reaches on-call before the DB dies. Feeds the Maintenance tab Capacity card and the sidebar critical alert via the /server-settings/pg-tuning endpoint. Snapshot also carries `database.timescale: { extensionInstalled, hypertableTables[] }` and a `timescale_recommended` watch-severity reason that fires when sample tables exceed 1 GB without the extension installed; reason text adapts via `deploymentContext` heuristics (local-DB vs remote/managed, bare-metal vs container).
│   │   ├── timescaleService.ts      # TimescaleDB detection + hypertable utilities. `detectTimescale()` runs once at startup (warmed in src/app.ts) and queries `pg_extension` + `timescaledb_information.hypertables` to populate a module-level cache; `isTimescaleAvailable()` and `isHypertable(name)` are sync getters used by the prune layer and capacityService. `dropChunks(table, olderThan)` is the chunk-granular fast path used as a pre-filter before the per-class `deleteMany` in `pruneOneTable` — no-op when the target table isn't a hypertable, so callers don't need to branch. `migrateToHypertables()` runs at boot (after detection) and idempotently converts the six sample tables to hypertables (`create_hypertable(if_not_exists => TRUE, migrate_data => TRUE)`), enables column compression with `compress_segmentby = "assetId"` + `compress_orderby = "timestamp" DESC`, and applies the compression policy with the `TIMESCALE_COMPRESS_AFTER_DAYS` window (default 7). Sample tables carry a composite PK on `(id, timestamp)` to satisfy Timescale's "all UNIQUE/PK constraints must include the partitioning column" rule — works fine on plain Postgres too.
│   │   ├── queueService.ts          # Monitor work queue mode + pg-boss runtime. Two implementations: `cursor` (default — in-process worker pool inside runMonitorPass; fits small/medium fleets fine after the Step 4a split-tick fix) and `pgboss` (durable queue with per-cadence worker pools — recommended once the fleet crosses ~500 monitored assets). Active mode lives in `Setting.monitor.queueMode`; captured at boot via `initializeQueue()` and frozen as the running process's mode regardless of subsequent Setting writes (operator changes take effect on next restart). `startPgbossWorkers()` boots pg-boss (only when boot-time mode is `pgboss`), creates the four queues with `policy: "exclusive"` + per-asset singletonKey for natural coalescing, and registers worker handlers that call back into the same `runFooFor()` functions the cursor pass uses. `publishMonitorJob(cadence, assetId, transport?)` is the publisher entry point; `monitorAssets.ts` calls it from the same two ticking loops it uses for cursor — only the dispatch differs. Worker counts default CPU-aware (`POLARIS_MONITOR_PROBE_WORKERS` / `POLARIS_MONITOR_FAST_WORKERS` / `POLARIS_MONITOR_HEAVY_WORKERS` env-overridable). Naming convention `polaris-monitor-*`; future `polaris-discovery-*` queues should be added when discovery moves under pg-boss and worker tuning revisited together.
│   │   ├── assetSightingService.ts  # DHCP-only sighting recorder: recordSightings() batch-upserts AssetFortigateSighting rows (deduped by (assetId, fortigateDevice)); getQuarantineCandidates(assetId) returns sightings within max-age; getSightingSettings/updateSightingSettings backed by Setting key "quarantineSightingSettings". Default max-age: 180 days.
│   │   ├── assetQuarantineService.ts # FortiGate MAC quarantine push/pull. quarantineAsset()/releaseQuarantine() orchestrate per-FortiGate pushes using buildTransportForIntegration() (supports both FMG proxy/direct and standalone FortiGate). Pushes to user.quarantine.targets/<name>/macs on FortiOS. quarantineTargets JSON array tracks per-target status (synced|drift|failed). verifyAssetQuarantine() drift-checks all targets without writing. statusBeforeQuarantine preserves prior status for restore on release. Auto-quarantine fires from discovery when a quarantined asset is sighted on a new FortiGate.
│   │   ├── apiTokenService.ts       # Bearer-token auth for external callers. createToken/listTokens/revokeToken/deleteToken/verifyToken. Wire format: polaris_<32-char-base64url>. argon2id hash + tokenPrefix-indexed candidate lookup. Scopes: assets:quarantine, assets:read. lastUsedAt/lastUsedIp bumped on successful verify.
│   │   ├── interfaceTopologyService.ts # Inter-Fortinet topology inference from interface naming conventions. inferInterfaceTopology(seedAssetIds) reads the latest AssetInterfaceSample per (assetId, ifName) for the seed set, parses each ifName through fortinetSerialPattern, and resolves matches against the in-memory Fortinet asset inventory by serial-fragment endsWith (FortiOS-auto peer aggregates) or hostname exact/prefix-with-separator (operator-named MCLAG aggregates). Skips ambiguous (>1 hit) and self-loop matches. Returns sibling edges plus a remoteAssets map for cross-site peers. Read-only — uses data the monitoring pipeline already collected, no new device queries. Wired into GET /map/sites/:id/topology.
│   │   └── updateService.ts         # Software update checking
│   ├── jobs/
│   │   ├── expireReservations.ts    # Mark past-TTL reservations as expired (every 15 min)
│   │   ├── discoveryScheduler.ts    # FMG/Windows Server auto-discovery polling
│   │   ├── discoverySlowCheck.ts    # 30s tick: flag in-flight discoveries that exceed their rolling-duration baseline
│   │   ├── ouiRefresh.ts            # Refresh IEEE OUI database
│   │   ├── pruneEvents.ts           # 7-day event log retention (nightly)
│   │   ├── updateCheck.ts           # Software update notifications
│   │   ├── clampAssetAcquiredAt.ts  # One-shot startup fix: clamp acquiredAt to lastSeen
│   │   ├── decommissionStaleAssets.ts # Every 24h: decommission assets not seen in N months
│   │   ├── monitorAssets.ts          # Two ticking loops with independent `running` guards. Light loop (probe + fastFiltered) ticks every 5s; heavy loop (telemetry + systemInfo) ticks every 30s and runs the daily retention prune. A wedged systemInfo on dead hosts blocks ONLY future heavy ticks — light loop keeps firing on its own clock so per-minute probe polling stays close to its configured cadence regardless. Default concurrency is CPU-aware (`cpus().length * 2` for light, `cpus().length` for heavy), env-overridable via POLARIS_PROBE_CONCURRENCY / POLARIS_HEAVY_CONCURRENCY.
│   │   ├── normalizeManufacturers.ts # One-shot startup: seed default aliases, load cache, backfill existing Asset/MibFile rows
│   │   ├── migrateMonitorTransport.ts # One-shot startup: back-fill Integration.config.monitorResponseTimeSource=snmp where legacy monitorCredentialId implied SNMP
│   │   ├── backfillAssetSources.ts  # One-shot startup (Phase 1 of multi-source asset model): walks every Asset and upserts AssetSource rows from the legacy `assetTag` / `sid:` / `ad-guid:` tag conventions. Idempotent; pairs with the shadow-write extension in src/db.ts.
│   │   ├── resolveStaleReservationConflicts.ts # One-shot startup: auto-reject pending reservation Conflict rows whose proposed values now match the live Reservation (legacy lingering conflicts)
│   │   ├── backfillFortigateEndpointSources.ts # One-shot startup: stamps a `fortigate-endpoint` AssetSource row on every existing endpoint asset that was discovered by an FMG/FortiGate integration but predates the source-kind cutover. Pairs with the inline upsert added to `syncDhcpSubnets` so future sync cycles maintain the row. Eligibility: assetType not firewall/switch/access_point, has macAddress, has discoveredByIntegrationId pointing at a fortimanager/fortigate integration. Sweeps any "manual" source row from the same asset (Phase 1 backfill placeholder superseded by the real source). Idempotent.
│   │   ├── scrubLegacySidGuidTags.ts # One-shot startup: Phase 4b cleanup. Strips `sid:<SID>` and `ad-guid:<GUID>` entries from `Asset.tags` arrays. Both signals now live on AssetSource (entra/intune/ad source rows; SID on observed.onPremisesSecurityIdentifier or observed.objectSid; GUID on the ad source's externalId), so the legacy tag mirroring is redundant. Idempotent. Discovery code stops writing the markers in the same release; this catches data left over from earlier runs. Does NOT touch `Asset.assetTag` (entra:/ad:/fgt:) or `prev-*` breadcrumb tags — those need parallel changes to searchService + conflict resolution before they can be retired.
│   │   └── capacityWatch.ts        # 10-minute tick: builds a capacity snapshot and calls `recordCapacityTransition` so a flip into watch/amber/red emits one `capacity.severity_changed` Event independent of whether anyone has the Maintenance tab open. Out-of-band path is the operationally important one — when the DB is on the verge of dying the UI is moments from being unreachable, but the Event still flows out via syslog/SFTP archival.
│   ├── setup/
│   │   ├── setupRoutes.ts           # First-run setup wizard routes
│   │   ├── setupServer.ts           # Setup server initialization
│   │   └── detectSetup.ts           # Resolves setup state: configured / needs-setup / locked
│   ├── models/
│   │   └── types.ts                 # Shared TypeScript interfaces
│   └── utils/
│       ├── cidr.ts                  # CIDR parsing, contains(), overlap()
│       ├── errors.ts                # AppError class with httpStatus
│       ├── logger.ts                # Structured logging (pino)
│       ├── assetInvariants.ts       # Write-time clamp: acquiredAt <= lastSeen
│       ├── loginLockout.ts          # Per-username login-failure counter + temporary lockout
│       ├── manufacturerNormalize.ts # Pure (no DB) cache + sync normalizeManufacturer(); imported by db.ts Prisma extension to canonicalize every Asset/MibFile manufacturer write
│       ├── assetSourceDerivation.ts # Pure (no DB) deriveAssetSources(): turns an Asset row's legacy assetTag / `sid:` / `ad-guid:` tag conventions into the AssetSource rows it should own. Shared by the shadow-write Prisma extension in src/db.ts and the backfillAssetSources startup job.
│       ├── fortiapLldp.ts            # Pure (no I/O) extractApLldpAndMesh(): pulls wired-uplink LLDP fields (system_name, port_id) plus mesh fields (mesh_uplink, parent_wtp_id) off a /api/v2/monitor/wifi/managed_ap row. Filters lldp[] by system_description starting with "FortiSwitch-" so wireless-mesh peers are skipped. Used by both fortimanagerService and fortigateService for AP→switch attribution.
│       ├── fortinetSerialPattern.ts  # Pure (no I/O) parser for FortiOS interface names that encode a peer device's identity. parseFortinetPeerInterface(name) recognizes two pathways: (1) FortiOS-auto peer-serial aggregates — uppercase alnum 8–30 chars, optional trailing `-N` aggregate index, no internal dashes (e.g. `8FFTV23025884-0` ↔ asset serial `S108FFTV23025884`, `GT61FTK22002079` ↔ `FGT61FTK22002079`); (2) operator-named hostname aggregates — same shape but with internal dashes allowed (e.g. `METROR2-T1024E` for a custom MCLAG to a peer named `METROR2-T1024E`). Trailing `-<digits>` is always stripped as the FortiOS aggregate suffix when the remaining fragment is ≥6 chars. Companion matchers: serialMatchesPeerInterface (case-insensitive endsWith on Asset.serialNumber, defends fragment ≤ serial length) and hostnameMatchesPeerInterface (case-insensitive exact match OR prefix-with-separator on Asset.hostname — `-` or `.` after the fragment, so `METROR2` won't false-match `METROR21`). Rejects: lowercase, mixed-case, names with non-alnum-non-dash chars (port1, wan1, internal, _FlInK1_ICL0_), leading/trailing dashes, length out of [8,30]. Used by interfaceTopologyService.
│       ├── assetProjection.ts       # Pure (no DB) projectAssetFromSources(): deterministic priority-driven projection of an asset's discovery-owned fields (hostname, serialNumber, manufacturer, model, os, osVersion, learnedLocation, ipAddress, latitude, longitude) from its AssetSource rows. Priority rules tuned from production shadow-drift logs: hostname picks AD's `dnsHostName` first when it's an FQDN (contains a dot) — operators search for the FQDN form; os picks AD when present (verbose Windows edition like "Windows 10 Pro" beats Intune's "Windows"); osVersion picks Intune first (4-part build is more specific); manufacturer is normalized through the alias map so "Dell Inc." → "Dell" matches the canonicalized Asset.manufacturer. Phase 3b.0: shadow-only (drift logged for analysis); Phase 3b.1 will cut Asset writes to use the projection as source of truth.
│       ├── mfaPending.ts            # Short-lived pending-MFA tokens for two-phase login
│       ├── password.ts              # argon2id hash/verify helpers (with legacy bcrypt detection off)
│       ├── paths.ts                 # Single source of truth for runtime-state file paths (.env, .setup-complete, data/backups, public/uploads). Reads optional POLARIS_STATE_DIR env var; unset → falls back to project root, so RHEL prod and dev installs see no behavior change. Set only by the Docker image (to /app/state) so the container needs one bind mount.
│       ├── deploymentContext.ts    # Best-effort heuristics for "where is Polaris running?" — `dbIsLocal()` parses DATABASE_URL host vs the box's network interfaces; `runtimeIsContainer()` checks /.dockerenv, KUBERNETES_SERVICE_HOST, /proc/1/cgroup, and POLARIS_STATE_DIR. Used to pick deployment-aware suggestion text in the TimescaleDB and pg-boss recommendation alerts. Cached after first call; false negatives surface conservative (more general) help text rather than wrong instructions.
│       └── startupDiskCheck.ts     # Cross-platform boot-time disk diagnostic. Statfs's the app dir, state dir, backups dir, plus conventional PostgreSQL data directory candidates per platform (RHEL `/var/lib/pgsql`, Debian/Ubuntu `/var/lib/postgresql/<ver>/main`, Windows `C:\Program Files\PostgreSQL\<ver>\data`). Logs at info/warn/error per volume depending on free percent. Non-fatal — never blocks boot; the value is turning a "polaris flapping with cryptic Prisma error" symptom into a clear "DB volume X has Y MB free" log line. The runtime `capacityService` resolves PGDATA authoritatively via `SHOW data_directory` once the DB connection is up.
└── tests/
    ├── unit/
    │   ├── cidr.test.ts
    │   ├── ipService.test.ts
    │   └── subnetService.test.ts
    └── integration/
        ├── blocks.test.ts
        ├── subnets.test.ts
        └── reservations.test.ts
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ / TypeScript (ESM) |
| Framework | Express 5 |
| ORM | Prisma 7 (driver-adapter via `@prisma/adapter-pg`; generated client at `src/generated/prisma/`, regenerated by `postinstall`) |
| Database | PostgreSQL 15 |
| Sessions | express-session + connect-pg-simple (PostgreSQL store) |
| Validation | Zod |
| Logging | Pino + pino-pretty |
| Auth | argon2id via @node-rs/argon2, @node-saml/node-saml (Azure SAML SSO), otpauth + qrcode (optional TOTP second factor for local accounts) |
| IP Math | ip-cidr + netmask + cidr-tools |
| Security | helmet, express-rate-limit |
| File uploads | multer |
| PDF export | jspdf + jspdf-autotable |
| Mapping | Leaflet + leaflet.markercluster + OpenStreetMap tiles (bundled under `public/css/vendor/leaflet/` and `public/js/vendor/leaflet/`) |
| Graph layout | Cytoscape.js + dagre + cytoscape-dagre (bundled under `public/js/vendor/`) for the Device Map topology modal |
| Asset monitoring | net-snmp (SNMP v2c/v3 authenticated GETs against `sysUpTime`); ssh2 (SSH connect+authenticate); built-in `node:https` (FortiOS REST + WinRM SOAP Identify); spawn the system `ping` for ICMP |
| Testing | Vitest + Supertest |
| Frontend | Vanilla JavaScript + HTML (served from /public) |

---

## Domain Model

### Enums

```
IpVersion:               v4 | v6
SubnetStatus:            available | reserved | deprecated
ReservationStatus:       active | expired | released
ReservationSourceType:   manual | dhcp_reservation | dhcp_lease | interface_ip | vip | fortiswitch | fortinap | fortimanager | fortigate
ConflictStatus:          pending | accepted | rejected
UserRole:                admin | networkadmin | assetsadmin | user | readonly
AssetStatus:             active | maintenance | decommissioned | storage | disabled | quarantined
AssetType:               server | switch | router | firewall | workstation | printer | access_point | other
```

### Core Entities

```
IpBlock
  id            UUID PK
  name          String
  cidr          String    @unique
  ipVersion     IpVersion
  description   String?
  tags          String[]
  subnets       Subnet[]

Subnet
  id              UUID PK
  blockId         UUID FK → IpBlock (cascade delete)
  cidr            String          -- Host bits zeroed on write
  name            String
  purpose         String?
  status          SubnetStatus    @default(available)
  vlan            Int?            -- 802.1Q VLAN ID (1–4094)
  tags            String[]
  discoveredBy    UUID? FK → Integration (set null on delete)
  fortigateDevice String?         -- FortiGate hostname/device
  createdBy       String?         -- username
  reservations    Reservation[]

Reservation
  id              UUID PK
  subnetId        UUID FK → Subnet (cascade delete)
  ipAddress       String?         -- Null = full subnet reservation
  hostname        String?
  owner           String?
  projectRef      String?
  expiresAt       DateTime?
  notes           String?
  status          ReservationStatus     @default(active)
  sourceType      ReservationSourceType @default(manual)
  createdBy       String?
  conflictMessage String?         -- human-readable conflict summary
  -- DHCP reservation push to FortiGate. Populated only when the subnet was
  -- discovered by an FMG integration with `pushReservations=true` AND the
  -- reservation is sourceType=manual + per-IP (full-subnet reservations are
  -- never pushed). pushedScopeId / pushedEntryId pin the device-side row so
  -- unpush hits the exact entry without re-resolving by IP. macAddress is the
  -- MAC sent to the device — DHCP reservations are MAC→IP, so a missing MAC
  -- on a push-eligible subnet aborts the create with 400. pushStatus values:
  -- "synced" (verified on device); "drift" (was synced, missing on a later
  -- discovery — operator deleted on the device). On create-time push failure
  -- the entire reservation create aborts and no row is persisted, so "failed"
  -- is not a stored state. See `reservationPushService.ts`.
  macAddress      String?
  pushedToId      UUID? FK → Integration (set null on delete)
  pushedScopeId   Int?            -- FortiOS DHCP server `id`
  pushedEntryId   Int?            -- reserved-address row id under that scope
  pushStatus      String?         -- "synced" | "drift"
  pushedAt        DateTime?
  pushError       String?
  -- Stale-reservation detection. lastSeenLeased is bumped during DHCP
  -- discovery whenever /api/v2/monitor/system/dhcp confirms the reservation's
  -- IP is being actively held by a client right now. staleNotifiedAt records
  -- the last `reservation.stale` Event emitted for this row; cleared by the
  -- sync on activity so the alert re-arms cleanly when the row goes silent
  -- again. staleSnoozedUntil hides the row from the active alert list while
  -- in the future (operator-driven Snooze; cleared by sync on activity).
  -- staleIgnored permanently silences the row until an admin un-ignores
  -- (network-admin/admin-driven; NOT cleared by sync — operator intent
  -- persists across online/offline cycles). See reservationStaleService.ts.
  lastSeenLeased    DateTime?
  staleNotifiedAt   DateTime?
  staleSnoozedUntil DateTime?
  staleIgnored      Boolean        @default(false)
  conflicts       Conflict[]
  @@unique([subnetId, ipAddress, status])

Integration
  id            UUID PK
  type          String            -- e.g. "fortimanager", "fortigate", "windowsserver"
  name          String
  config        Json              -- Type-specific connection settings (host, port, adom, credentials, etc.)
  enabled       Boolean           @default(true)
  autoDiscover  Boolean           @default(true)
  pollInterval  Int               @default(4)  -- Hours between auto-discovery runs (1–24)
  lastTestAt    DateTime?
  lastTestOk    Boolean?
  lastDiscoveryAt DateTime?        -- Stamped at start of each run; used by scheduler to gate auto-runs across restarts
  subnets       Subnet[]

Asset
  id              UUID PK
  ipAddress       String?
  ipSource        String?         -- Where ipAddress was last set from: "manual", "fortimanager", "fortigate", etc.
  macAddress      String?         -- Most recently seen MAC (Intune writes prefer Ethernet over Wi-Fi when both are reported)
  -- macAddresses: stored in the AssetMacAddress side table (one row per
  -- assetId+mac pair). The list/get response still serializes the relation
  -- back into the legacy `macAddresses: [...]` JSON shape so the frontend
  -- reads the same field name as before. Discovery code paths (FMG /
  -- FortiGate DHCP, device-inventory, Intune sync, conflict ghost-merge)
  -- hydrate `asset.macAddresses` from the rows on load, modify the array
  -- in JS as before, then call `reconcileMacAddresses(assetId, macs)` from
  -- src/utils/macAddresses.ts to sync the side table after the
  -- asset.update lands.
  hostname        String?
  dnsName         String?         -- FQDN from PTR lookup
  dnsNameFetchedAt DateTime?      -- When the last PTR lookup ran (success or failure)
  dnsNameTtl      Int?            -- TTL (seconds) from the PTR record; null = unknown (standard mode falls back to 3600s)
  assetTag        String? @unique -- Internal tracking tag
  serialNumber    String?
  manufacturer    String?
  model           String?
  assetType       AssetType       @default(other)
  status          AssetStatus     @default(active)
  location        String?         -- User-set (overrides learnedLocation)
  learnedLocation String?         -- Auto-discovered from DHCP (FortiGate name)
  department      String?
  assignedTo      String?
  os              String?
  osVersion       String?
  lastSeenSwitch  String?         -- e.g. "FS-248E-01/port15"
  lastSeenAp      String?         -- FortiAP name
  lastSeen        DateTime?
  -- associatedIps: stored in the AssetAssociatedIp side table (one row per
  -- asset+ip pair). The list/get response still serializes the relation back
  -- into the legacy `associatedIps: [...]` JSON shape so the frontend reads
  -- the same field name as before. Per-row PTR cache (ptrName/ptrTtl/
  -- ptrFetchedAt) lives on the row directly. Persist semantics: monitor
  -- system-info pass deletes all source != "manual" rows for the asset and
  -- re-inserts the fresh interface set in one $transaction; manual entries
  -- are preserved across pulls.
  associatedUsers Json            -- [{user, domain?, lastSeen, source?}]
  latitude        Float?          -- FortiGate geo coord from `config system global` (decimal degrees); drives Device Map pins
  longitude       Float?
  fortinetTopology Json?           -- { role: "fortigate" | "fortiswitch" | "fortiap", controllerFortigate?, uplinkInterface?, parentSwitch?, parentPort?, parentVlan? } — real connection graph from FMG/FortiGate discovery
  acquiredAt      DateTime?
  warrantyExpiry  DateTime?
  purchaseOrder   String?
  notes           String?
  tags            String[]
  createdBy       String?
  discoveredByIntegrationId UUID? FK → Integration (set null on delete) -- Stamped on FortiGate firewall asset writes (FMG + standalone) and on Windows-OS Active Directory asset writes; drives the Monitoring tab's *default* probe path (FortiOS REST via the integration's API token, or AD bind credentials for realm-monitorable hosts). Operators can override `monitorType` to a generic snmp/icmp/winrm/ssh probe — useful for small-branch FortiGates whose REST sensor endpoint 404s on FortiOS 7.4.x — and subsequent discovery runs preserve the override.
  monitored       Boolean         @default(false)
  monitorType     String?         -- "fortimanager" | "fortigate" | "activedirectory" | "snmp" | "winrm" | "ssh" | "icmp"
  monitorCredentialId UUID? FK → Credential (set null on delete) -- Used for snmp/winrm/ssh; null for icmp and the integration-default fortinet/AD probes (those reuse the integration's API token / bind credentials). Set when an operator overrides an integration-discovered asset to a generic probe.
  monitorIntervalSec Int?         -- Per-asset response-time probe interval; null falls back to monitor.intervalSeconds
  monitorStatus   String?         -- "up" | "down" | "unknown"
  lastMonitorAt   DateTime?
  lastResponseTimeMs Int?         -- Most recent successful probe RTT; null while pending or after a failure
  consecutiveFailures Int         @default(0)
  -- Per-stream transport overrides for FMG/FortiGate-discovered firewalls.
  -- null = inherit from the integration's matching toggle (default "rest").
  -- "rest" = FortiOS REST API; "snmp" = SNMP via the asset's monitorCredential
  -- (or, if null, the integration's monitorCredentialId). Only consulted
  -- when monitorType resolves to fortimanager/fortigate; ignored when the
  -- operator switched to a generic snmp/winrm/ssh/icmp probe (those follow
  -- monitorType end-to-end). Built so a fleet of branch-class FortiGates can
  -- keep monitorType=fortimanager but individually reroute telemetry or
  -- interfaces to SNMP — useful for boxes whose REST sensor-info / interface
  -- endpoints 404 on FortiOS 7.4.x. IPsec always stays REST regardless.
  monitorResponseTimeSource String? -- null | "rest" | "snmp" — sysUpTime vs /system/status
  monitorTelemetrySource    String? -- null | "rest" | "snmp" — covers CPU + memory + temperature
  monitorInterfacesSource   String? -- null | "rest" | "snmp" — covers interfaces + storage
  -- System tab cadences (asset details modal). Same monitorAssets job, but
  -- on independent timers from the response-time probe. Telemetry =
  -- CPU+memory snapshot (~60s default); systemInfo = full interface +
  -- storage scrape (~600s default). Per-asset *IntervalSec columns override
  -- the global telemetryIntervalSeconds / systemInfoIntervalSeconds settings.
  telemetryIntervalSec  Int?
  systemInfoIntervalSec Int?
  lastTelemetryAt       DateTime?
  lastSystemInfoAt      DateTime?
  -- ifNames pinned for fast-cadence polling on the System tab. Each entry
  -- in this array is also scraped on the response-time interval (default
  -- 60s) so the operator gets sub-minute throughput + error history for
  -- chosen uplinks/critical ports. The full system-info pass at ~10 min
  -- still covers all interfaces and skips the fast-scrape collision.
  monitoredInterfaces   String[]   @default([])
  -- Storage hrStorageDescr mountPaths pinned for fast-cadence polling.
  -- Same model as monitoredInterfaces — sub-minute disk-usage history for
  -- chosen volumes; the full system-info pass still covers all mountpoints.
  monitoredStorage      String[]   @default([])
  -- Phase-1 IPsec tunnel names pinned for fast-cadence polling. The full
  -- /api/v2/monitor/vpn/ipsec endpoint can be slow on busy gateways and is
  -- normally skipped on the fast cadence; pinning a tunnel here issues a
  -- targeted scrape that filters down to just the requested phase-1.
  -- ADVPN dynamic shortcut tunnels are filtered out of discovery (the
  -- collector skips any tunnel with a non-empty `parent` field) so they
  -- don't pollute the table or this pinning surface.
  monitoredIpsecTunnels String[]   @default([])
  -- Quarantine state. Status "quarantined" is owned by the dedicated quarantine
  -- endpoints and cannot be set/cleared via the generic PUT /assets/:id update.
  -- quarantineTargets is a JSON array of per-FortiGate push records:
  --   [{ fortigateDevice, integrationId, pushedMacs[], pushedAt, status: "synced"|"drift"|"failed", error? }]
  -- statusBeforeQuarantine preserves the prior status so release can restore it.
  statusBeforeQuarantine String?
  quarantineReason       String?
  quarantinedAt          DateTime?
  quarantinedBy          String?
  quarantineTargets      Json?

AssetFortigateSighting          -- DHCP-only sightings: tracks which FortiGate each asset has been seen on
  id                UUID PK
  assetId           UUID FK → Asset (cascade delete)
  integrationId     UUID? FK → Integration (set null on delete)
  fortigateDevice   String          -- FortiGate device name from the DHCP entry
  source            String          -- "dhcp_reservation" | "dhcp_lease"
  ipAddress         String?         -- IP last seen on this FortiGate. Bumped on every re-sighting alongside lastSeen. Nullable for rows recorded before this column existed; the Quarantine tab joins it against Subnet.cidr (filtered by fortigateDevice) at read time to surface subnet name + VLAN.
  lastSeen          DateTime
  @@unique([assetId, fortigateDevice]) -- one row per (asset, FortiGate); updated on re-sighting

ApiToken                        -- Long-lived bearer tokens for external callers (e.g. SIEM quarantine)
  id            UUID PK
  name          String @unique
  tokenHash     String            -- argon2id of the raw token; never returned in API responses
  tokenPrefix   String            -- first 16 chars (polaris_ + 8 chars) for fast candidate lookup
  scopes        String[]          -- e.g. ["assets:quarantine", "assets:read"]
  integrationIds String[]         -- FMG/FortiGate ids this token may target. REQUIRED + non-empty when scopes contains assets:quarantine; empty for read-only tokens. The quarantine service drops sightings whose integration isn't in this list before pushing, and refuses release/verify outright if the existing quarantine touches integrations outside the token's scope (partial release would leave Polaris flipped to active while orphan entries linger on out-of-scope gateways). Validated at create-time: each id must exist and be type fortimanager or fortigate.
  createdBy     String
  createdAt     DateTime
  expiresAt     DateTime?
  lastUsedAt    DateTime?
  lastUsedIp    String?
  revokedAt     DateTime?
  revokedBy     String?
  -- Wire format: Authorization: Bearer polaris_<32-char-base64url-tail>
  -- Raw token shown ONCE at creation (POST /api-tokens); only the hash is stored.
  -- Available scopes: assets:quarantine, assets:read

AssetIpHistory                  -- Auto-populated log of every IP each asset has held
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  ip            String
  source        String          -- "manual", "fortimanager", "fortigate", "dns", etc.
  firstSeen     DateTime
  lastSeen      DateTime
  @@unique([assetId, ip])       -- one row per (asset, ip); lastSeen and source update on re-sighting

AssetMacAddress                 -- All MACs an asset has been seen with. Replaces the legacy Asset.macAddresses JSONB column.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  mac           String                    -- normalized colon-uppercase (AA:BB:CC:DD:EE:FF)
  source        String                    -- "fmg-discovery" | "fortigate" | "intune-ethernet" | "intune-wifi" | "device-inventory" | "ad" | "manual" | various
  device        String?                   -- FortiGate device name when this MAC came from a DHCP scrape
  subnetCidr    String?                   -- populated when the IP at sighting time fell inside a known subnet
  subnetName    String?
  firstSeen     DateTime
  lastSeen      DateTime
  @@unique([assetId, mac])
  -- Persist: discovery code that builds an in-memory mac list (deduped + sorted lastSeen desc) calls `reconcileMacAddresses(assetId, macs)` from src/utils/macAddresses.ts after the asset.update lands. The list/get response serializes the relation back into the legacy `macAddresses: [...]` JSON shape so existing API consumers keep reading the same field name.

AssetAssociatedIp               -- Additional ("secondary") IPs an asset holds beyond Asset.ipAddress. Replaces the legacy Asset.associatedIps JSONB column.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  ip            String
  source        String          -- "manual" | "monitor-system-info" | various legacy values from the JSON backfill
  interfaceName String?
  mac           String?
  ptrName       String?         -- reverse-DNS cache, populated by the bulk DNS job and the per-asset DNS lookup endpoint
  ptrTtl        Int?
  ptrFetchedAt  DateTime?
  firstSeen     DateTime
  lastSeen      DateTime
  @@unique([assetId, ip])
  -- Persist: system-info scrape deletes all source != "manual" rows for the asset and re-inserts the fresh interface set in one $transaction; source="manual" rows are preserved. The list/get response serializes the relation back into the legacy `associatedIps: [...]` JSON shape so the frontend reads the same field name as before.

AssetSource                     -- Per-discovery-source view of an asset (Phase 1 of the multi-source asset model)
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  sourceKind    String          -- Phase 1: "entra" | "ad" | "fortigate-firewall" | "manual". Phase 2 cutover adds "intune" | "fortiswitch" | "fortiap" | "fortigate-dhcp-host" | ...
  externalId    String          -- Source-natural identity: entra.deviceId / ad.objectGUID / fortigate-firewall.serial. Manual sources use Asset.id itself.
  integrationId UUID? FK → Integration (set null on delete) -- null for "manual" rows and for inferred rows where the integration linkage couldn't be reconstructed
  observed      Json            -- Source-shaped raw observation blob (see "Per-source observed shapes" below). Stays as the source said it; the Asset row is the merged projection across sources.
  inferred      Boolean         @default(false) -- true when the row was synthesized by the Phase-1 backfill from legacy assetTag / sid: / ad-guid: tags rather than discovered fresh; cleared on next real run
  syncedAt      DateTime?       -- last successful refresh from this source (drives staleness)
  firstSeen     DateTime        -- when Polaris first recorded this source
  lastSeen      DateTime        -- last time this source reported the device as active
  @@unique([sourceKind, externalId]) -- (sourceKind, externalId) is the dedupe key — re-runs upsert in place
  -- Phase 1 populates this from existing assetTag / "sid:" / "ad-guid:" tags via the shadow-write Prisma extension in src/db.ts plus the one-shot backfillAssetSources startup job. Discovery still writes to Asset directly; AssetSource is shadowed alongside until Phase 2 cuts integrations over to write here as the source of truth. The unified Asset row stays the stable FK target for everything downstream (monitoring, ip-history, sightings, quarantine).

AssetMonitorSample              -- Time-series of monitoring probe results; written by the monitorAssets job
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  timestamp     DateTime        @default(now())
  success       Boolean
  responseTimeMs Int?           -- Round-trip in ms on success; null on failure (the "packet loss" signal)
  error         String?
  @@index([assetId, timestamp])

AssetTelemetrySample            -- System tab CPU+memory snapshot (~60s cadence). Populated by monitoringService.collectTelemetry for FortiOS- and SNMP-monitored assets; ICMP/SSH cannot deliver this data; WinRM/AD return supported=false until WMI Enumerate-over-WS-Management lands.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  timestamp     DateTime        @default(now())
  cpuPct        Float?
  memPct        Float?          -- Set when the source reports memory only as a percentage (FortiOS)
  memUsedBytes  BigInt?         -- Set when the source reports absolute bytes (SNMP HOST-RESOURCES-MIB hrStorageRam, WMI)
  memTotalBytes BigInt?
  @@index([assetId, timestamp])

AssetInterfaceSample            -- System tab per-interface scrape (~600s cadence). Many rows per scrape (one per interface). recordSystemInfoResult also mirrors {ip, interfaceName, mac} into Asset.associatedIps with source "monitor-system-info" — manual entries are preserved. Pinned interfaces (Asset.monitoredInterfaces) get extra rows on the response-time cadence (~60s) via collectFastFiltered. The same fast pass also writes extra AssetStorageSample / AssetIpsecTunnelSample rows for any mountPaths in Asset.monitoredStorage and any tunnel names in Asset.monitoredIpsecTunnels.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  timestamp     DateTime        @default(now())
  ifName        String
  adminStatus   String?         -- "up" | "down" | "testing" | ...
  operStatus    String?         -- ditto
  speedBps      BigInt?         -- Bits per second; from ifHighSpeed*1e6 or ifSpeed
  ipAddress     String?
  macAddress    String?
  inOctets      BigInt?         -- Cumulative counter; subtract consecutive samples for throughput
  outOctets     BigInt?
  inErrors      BigInt?         -- Cumulative IF-MIB ifInErrors / FortiOS errors_in
  outErrors     BigInt?         -- Cumulative IF-MIB ifOutErrors / FortiOS errors_out
  ifType        String?         -- "physical" | "aggregate" | "vlan" | "loopback" | "tunnel". FortiOS REST via `type` field; SNMP via ifType OID (1.3.6.1.2.1.2.2.1.3).
  ifParent      String?         -- Aggregate name for member ports; parent interface name for VLAN sub-interfaces. FortiOS REST only (back-filled from aggregate `member` array and VLAN `interface` field).
  vlanId        Int?            -- 802.1Q VLAN ID for vlan-type interfaces. FortiOS REST only (from `vlanid` field).
  alias         String?         -- Operator-set label that overrides ifName in the UI when present. FortiOS CMDB `alias`; SNMP IF-MIB ifAlias (1.3.6.1.2.1.31.1.1.1.18). The interface table on the System tab swaps `alias` for `ifName` when set (with the real ifName kept as a tooltip + small subtitle), and the interface slide-over title shows `<alias> (<ifName>)`.
  description   String?         -- Free-text comment as reported by the device. FortiOS CMDB `description`; SNMP has no equivalent so this stays null on SNMP-monitored hosts. Surfaced on the interface slide-over and shown as ghost text in the Interface Comments editor when no Polaris override is set; AssetInterfaceOverride.description (when present) takes priority for display.
  @@index([assetId, timestamp])
  @@index([assetId, ifName, timestamp])

AssetInterfaceOverride          -- Operator-typed "Interface Comments" override per (assetId, ifName). Polaris-local only — never pushed back to the device. Takes priority over the discovered AssetInterfaceSample.description for display. One row per (assetId, ifName); a null/empty `description` clears the override and the discovered comment shows through again. Edited from the interface slide-over on the asset details System tab; requires Assets Admin (or admin) to write.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  ifName        String
  description   String?         -- VARCHAR(255). Matches the FortiGate CMDB system.interface comments field size.
  updatedBy     String?
  createdAt     DateTime
  updatedAt     DateTime
  @@unique([assetId, ifName])

AssetTemperatureSample          -- Per-sensor temperature snapshot, written alongside telemetry. FortiOS via /api/v2/monitor/system/sensor-info (filtered to type "temperature"); SNMP via ENTITY-SENSOR-MIB (entPhySensorType=8 / celsius). Hosts that don't publish either get no rows; the System tab hides the section. Shares telemetry's retention setting.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  timestamp     DateTime        @default(now())
  sensorName    String
  celsius       Float?
  @@index([assetId, timestamp])
  @@index([assetId, sensorName, timestamp])

AssetStorageSample              -- System tab per-mountpoint storage snapshot. SNMP only — FortiOS doesn't expose mountable storage and WinRM is not yet supported.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  timestamp     DateTime        @default(now())
  mountPath     String          -- hrStorageDescr (e.g. "/", "C:")
  totalBytes    BigInt?
  usedBytes     BigInt?
  @@index([assetId, timestamp])
  @@index([assetId, mountPath, timestamp])

AssetLldpNeighbor               -- Current-state LLDP neighbor table per (asset, local interface). Refreshed on every system-info pass that successfully queried LLDP — FortiOS `/api/v2/monitor/system/interface/lldp-neighbors` for fortimanager/fortigate-monitored assets, SNMP LLDP-MIB walk (`lldpRemTable` + `lldpLocPortTable` + `lldpRemManAddrTable`) for SNMP-monitored assets. `firstSeen` survives across persists; `lastSeen` is bumped on every refresh. **Stickiness rule**: a row that's missing from a fresh scrape is dropped only when (a) the same local port just observed a DIFFERENT neighbor (real topology change — supersede immediately) or (b) the row's `lastSeen` is older than 48 hours (truly stale). Within 48h with no fresh neighbor on that port the row is preserved — LLDP advertisements get missed intermittently (packet drops, peer reboots, brief unplugs), and a hard "delete on every miss" rule made the Neighbor column flap empty for those gaps. `matchedAssetId` is resolved at persist time by joining each neighbor against the asset inventory by management IP, chassis MAC (subtype=macAddress), and system name (case-insensitive hostname); the FK uses `SetNull` on delete so removing the matched asset just clears the back-pointer. `source` is `"fortios"` or `"snmp"`. The collector signals "unsupported transport" by leaving `lldpNeighbors` undefined in the SystemInfoSample (so the persist layer leaves stored rows alone); an empty array signals "queried successfully, no neighbors" → wipe. Capabilities are decoded from LLDP-MIB `lldpRemSysCapEnabled` (8 defined IEEE 802.1AB capability bits) into tokens like `"bridge"` / `"router"` / `"wlan-access-point"` matching FortiOS naming. Read by `GET /assets/:id/system-info` (full set with matched-asset cross-link), `GET /assets/:id/interface-history?ifName=...` (just the neighbors on that interface), and `GET /map/sites/:id/topology` (drives the dashed orange "LLDP edges" + ghost neighbor nodes for non-Polaris devices in the Device Map graph). Pruned alongside the other system-info tables on the daily cycle, but retention rarely matters in practice — the per-scrape full-replace already removes neighbors that have gone away.
  id                UUID PK
  assetId           UUID FK → Asset (cascade delete)
  localIfName       String          -- local interface on the assetId asset that observed the neighbor
  chassisIdSubtype  String?         -- "macAddress" | "interfaceName" | "networkAddress" | ...
  chassisId         String?         -- normalized: macAddress subtype is formatted as colon-separated hex
  portIdSubtype    String?
  portId            String?         -- normalized same way as chassisId
  portDescription   String?
  systemName        String?
  systemDescription String?
  managementIp      String?
  capabilities      String[]
  matchedAssetId    UUID? FK → Asset (set null on delete) -- resolved at persist time; powers the topology graph
  source            String          -- "fortios" | "snmp"
  firstSeen         DateTime
  lastSeen          DateTime
  @@unique([assetId, localIfName, chassisId, portId])

AssetIpsecTunnelSample          -- System tab per-tunnel IPsec snapshot, written on the system-info cadence. FortiOS only — read from /api/v2/monitor/vpn/ipsec, plus a parallel /api/v2/cmdb/vpn.ipsec/phase1-interface lookup so each row carries `parentInterface` (the FortiOS CLI `set interface` value, e.g. "wan1") AND captures the phase-1 `type`. The System tab uses parentInterface to nest tunnel rows under their parent in the Interfaces table — there is no longer a standalone IPsec section. Tunnels whose parentInterface lookup fails (CMDB scope missing, parent filtered out, etc.) fall into an "IPsec Tunnels (unbound)" group at the bottom of the same table. One row per phase-1 tunnel; status rolls phase-2 selectors up to "up" (all up), "down" (all down), or "partial" (mix). Phase-1 entries with CMDB `type: "dynamic"` (dial-up server templates) report status "dynamic" regardless of the phase-2 rollup — these accept connections from dynamic peers, and active sessions appear as separate `parent`-bearing tunnels that are already filtered out, so an up/down/partial label on the template is misleading. Bytes are summed across every phase-2 selector under this phase-1 and are cumulative — FortiOS resets when phase-1 renegotiates, so the throughput derivation drops negative deltas as counter resets. ADVPN dynamic shortcut tunnels (those returning a non-empty `parent` field on the FortiOS response) are filtered out at the collector so spoke shortcut churn doesn't pollute the table. The full IPsec endpoint is skipped on the fast (per-minute) cadence by default; pinning a tunnel name in Asset.monitoredIpsecTunnels turns it back on for that one tunnel.
  id              UUID PK
  assetId         UUID FK → Asset (cascade delete)
  timestamp       DateTime        @default(now())
  tunnelName      String          -- phase-1 name
  parentInterface String?         -- FortiOS phase1-interface CMDB `interface` field (e.g. "wan1"); null when the CMDB lookup fails or returns no match
  remoteGateway   String?         -- rgwy / tun_id
  status          String          -- "up" | "down" | "partial" | "dynamic" (dial-up server templates — see header)
  incomingBytes   BigInt?
  outgoingBytes   BigInt?
  proxyIdCount    Int?            -- # of phase-2 selectors under this phase-1
  @@index([assetId, timestamp])
  @@index([assetId, tunnelName, timestamp])

Credential                      -- Named credentials for monitoring probes (SNMP / WinRM / SSH)
  id            UUID PK
  name          String @unique
  type          String          -- "snmp" | "winrm" | "ssh"
  config        Json            -- Type-specific:
                                --   snmp v2c: { version: "v2c", community, port? }
                                --   snmp v3:  { version: "v3", username, securityLevel, authProtocol?, authKey?, privProtocol?, privKey?, port? }
                                --             authProtocol: "MD5" | "SHA" (SHA-1) | "SHA224" | "SHA256" | "SHA384" | "SHA512"
                                --             privProtocol: "DES" | "AES" (AES-128) | "AES256B" (Blumenthal draft) | "AES256R" (Reeder draft / Cisco)
                                --   winrm:    { username, password, port?, useHttps? }
                                --   ssh:      { username, password? | privateKey?, port? }
  -- Sensitive fields (community, authKey, privKey, password, privateKey) are stored plaintext and masked
  -- on every GET; PUT preserves the stored value when the caller resubmits the mask sentinel.

User
  id            UUID PK
  username      String @unique
  passwordHash  String
  role          UserRole        @default(readonly)
  authProvider  String          -- "local" or "azure"
  azureOid      String? @unique -- Azure AD Object ID
  displayName   String?
  email         String?
  lastLogin     DateTime?
  totpSecret      String?       -- Base32 TOTP secret (null = not enrolled)
  totpEnabledAt   DateTime?     -- Null = not enabled; set on first valid confirm code
  totpBackupCodes String[]      -- argon2id-hashed single-use recovery codes

Event                           -- Audit log, 7-day rolling retention
  id            UUID PK
  timestamp     DateTime
  level         String          -- "info" | "warning" | "error"
  action        String          -- e.g. "block.created", "integration.discover.started"
  resourceType  String?
  resourceId    String?
  resourceName  String?
  actor         String?         -- username that triggered the event
  message       String
  details       Json?

Conflict                        -- Discovery conflict resolution (two variants)
  id                UUID PK
  entityType        String         -- "reservation" | "asset"
  reservationId     UUID? FK → Reservation (cascade delete; null for asset conflicts)
  assetId           UUID? FK → Asset (cascade delete; null for reservation conflicts)
  integrationId     UUID?
  -- Reservation-conflict proposed values (null for asset conflicts):
  proposedHostname  String?
  proposedOwner     String?
  proposedProjectRef String?
  proposedNotes     String?
  proposedSourceType String?       -- Required for reservations, null for assets
  -- Asset-conflict proposed values (null for reservation conflicts):
  proposedDeviceId  String?        -- Entra deviceId (dedupe key across discovery runs)
  proposedAssetFields Json?        -- Full snapshot: hostname, serial, mac, model, manufacturer, os, osVersion, assignedTo, chassisType, complianceState, trustType
  conflictFields    String[]       -- Field names that differ
  status            ConflictStatus @default(pending)
  resolvedBy        String?
  resolvedAt        DateTime?

Setting                         -- Key-value configuration store
  key           String PK
  value         Json

Tag
  id            UUID PK
  name          String @unique
  category      String @default("General")
  color         String @default("#4fc3f7")

MibFile                         -- Admin-uploaded SNMP MIB modules used to resolve vendor-specific OIDs during monitoring
  id            UUID PK
  filename      String           -- original upload filename
  moduleName    String           -- parsed from "<NAME> DEFINITIONS ::= BEGIN" (validated as a real SMI module on upload — non-MIB text or binaries are rejected)
  manufacturer  String?          -- null = generic/shared MIB (loaded for every probe). Normalized through the ManufacturerAlias map on every write via the Prisma extension in src/db.ts.
  model         String?          -- null = applies to all models from this manufacturer
  contents      String           -- raw MIB text, stored inline (MIBs are normally <100 KB; cap = 1 MB)
  imports       String[]         -- module names referenced via IMPORTS ... FROM (used to surface missing dependencies in the UI)
  size          Int              -- byte length of contents
  notes         String?
  uploadedBy    String?
  uploadedAt    DateTime
  @@unique([manufacturer, model, moduleName])  -- Postgres treats NULLs as distinct, so the service layer also rejects duplicate generic MIBs

ManufacturerAlias               -- Vendor name normalization map; collapses IEEE legal forms into a single canonical brand
  id            UUID PK
  alias         String @unique  -- input string to rewrite, stored lowercased + trimmed (e.g. "fortinet, inc.")
  canonical     String          -- canonical name the alias rewrites to (e.g. "Fortinet"), stored as-typed
  -- Loaded into an in-memory cache by manufacturerAliasService.refreshAliasCache() at startup and after every CRUD mutation. The Prisma extension in src/db.ts reads the cache to canonicalize Asset.manufacturer / MibFile.manufacturer on every create/update/updateMany/upsert. Mutations also run applyAliasesToExistingRows() in the background so admin edits propagate to historical data. Default seed (idempotent) ships ~25 common IEEE → marketing-name mappings (Fortinet, Inc. → Fortinet, Cisco Systems, Inc. → Cisco, etc.); admins extend the map from Server Settings → Identification → Manufacturer Aliases.
```

---

## API Endpoints

All routes are prefixed `/api/v1/`. Auth guards are applied in `src/api/router.ts`.

### Auth — public
- `POST   /auth/login`
- `POST   /auth/logout`
- `GET    /auth/me`                             — Session check
- `GET    /auth/azure/config`                   — Azure SSO feature flag
- `GET    /auth/azure/login`                    — Initiate Azure SAML login
- `POST   /auth/azure/callback`                 — SAML assertion callback
- `POST   /auth/login/totp`                     — Second step of two-phase login when TOTP is enabled. Body: `{ pendingToken, code, isBackupCode? }`. `pendingToken` is returned by `POST /auth/login` whenever the caller's account has `totpEnabledAt` set — until this endpoint consumes it, the session is not issued.

### TOTP self-management — `requireAuth`
- `GET    /auth/totp/status`                    — `{ authProvider, enabled, enrolling, backupCodesRemaining }`
- `POST   /auth/totp/enroll`                    — Starts enrollment for the current user. Returns `{ secret, otpauthUri, qrSvg }`. Only allowed on `authProvider = "local"` accounts that are not already fully enrolled.
- `POST   /auth/totp/confirm`                   — Finalize enrollment by verifying the first 6-digit code. Body: `{ code }`. Returns `{ ok, backupCodes: string[] }` — shown once.
- `DELETE /auth/totp`                           — Self-disable. Requires a current TOTP or backup code. Body: `{ code, isBackupCode? }`.

### IP Blocks — `requireAuth`
- `GET    /blocks`                              — List (filter by tag, ipVersion)
- `POST   /blocks`
- `GET    /blocks/:id`                          — Get + utilization summary
- `PUT    /blocks/:id`
- `DELETE /blocks/:id`                          — 409 if active reservations exist

### Subnets — `requireAuth`
- `GET    /subnets`                             — List (filter by blockId, status, tag, createdBy)
- `POST   /subnets`
- `GET    /subnets/:id`                         — Get + reservation list
- `PUT    /subnets/:id`
- `DELETE /subnets/:id`                         — 409 if active reservations exist
- `POST   /subnets/next-available`              — Auto-allocate next available subnet of given prefix length
- `POST   /subnets/bulk-allocate`                — Allocate multiple subnets in one call from a template. Body: `{ blockId, prefix, entries: [{name, prefixLength, vlan?} | {skip: true, prefixLength}], tags?, anchorPrefix? }`. Each non-skip entry becomes a subnet named `<prefix>_<entry.name>` (e.g. `Jefferson_Hardware`). **Skip entries** reserve address space inside the packed region without creating a subnet — used to leave gaps between allocations. **Anchor-based, all-or-nothing:** entries are packed into a single contiguous region aligned to `max(anchorPrefix, smallest-block-containing-the-group)`; `anchorPrefix` defaults to 24 if omitted. The whole call happens in one transaction — either every subnet is created or none are. Response: `{ created, anchorCidr, effectiveAnchorPrefix }`.
- `POST   /subnets/bulk-allocate/preview`        — Non-mutating preview of the above. Same body minus `prefix` and `tags`, with a lenient entry schema (no name required) so the modal can live-update footprint while the user is still filling rows. Response: `{ fits, anchorCidr, effectiveAnchorPrefix, assignments, totalAddresses, slashTwentyFourCount, blockCidr, error }`.

### Reservations — `requireAuth`
- `GET    /reservations`                        — List (filter by owner, projectRef, status, createdBy)
- `POST   /reservations`                        — Create. Body accepts an optional `macAddress` (12 hex with optional `:`, `-`, or `.` separators). When the target subnet was discovered by an FMG integration with `pushReservations=true`, MAC becomes **required** and the create is atomic with a write+verify against the FortiGate — see `reservationPushService.ts`. Push success returns the reservation with `pushStatus="synced"` and the device-side `pushedScopeId`/`pushedEntryId` stamped; any device-side failure aborts the create with a clear 4xx/5xx (no Polaris ghost). Writes `reservation.push.succeeded` (info) on success, `reservation.push.failed` (warning) on failure in addition to the usual `reservation.created` Event. The same MAC + push behavior applies to `POST /reservations/next-available`.
- `GET    /reservations/:id`
- `PUT    /reservations/:id`
- `DELETE /reservations/:id`                    — Release. Best-effort unpush from the FortiGate before flipping the row to `released`. Device-side failure does **not** block the release — Polaris release proceeds and writes `reservation.unpush.failed` (warning) so the orphan on the device is auditable. "Already absent" (operator deleted on the device) writes `reservation.unpush.succeeded` with `alreadyAbsent: true`. **Discovered `dhcp_lease` rows additionally fire a best-effort lease release** against the originating FortiGate (`POST /api/v2/monitor/system/dhcp/release-lease` with `{ip}`, routed through the same FMG-or-standalone-FortiGate transport as reservation push), gated on the originating integration's `pushReservations` toggle (the **DHCP Push** tab — both halves of the Polaris → FortiGate DHCP write path live under that single toggle). When the toggle is off, freeing a lease only flips the Polaris row and the FortiGate is not contacted. When it's on, FortiOS only forgets the *current* lease — the same client can DHCP-acquire the IP back on its next request, so this is "expire now" not a block. Success writes `reservation.lease_release.succeeded` (info); device-side failure writes `reservation.lease_release.failed` (warning) without blocking the Polaris release.

#### Stale-reservation alerts (mixed scoping)
- `GET    /reservations/stale-settings`         *(auth)* — `{ staleAfterDays }`. 0 = disabled.
- `PUT    /reservations/stale-settings`         *(admin)* — `{ staleAfterDays }`. Default 60. The setting feeds both the `flagStaleReservations` job and the alert lister; lowering it is reflected within ~6 hours (the next job tick).
- `GET    /reservations/alerts?show=active|ignored` — Default `active` returns non-ignored stale rows; `ignored` returns every row the operator has set `staleIgnored=true` regardless of threshold so admins can review and un-silence. Each entry: `{ id, ipAddress, hostname, macAddress, subnetId, subnetCidr, subnetName, createdAt, lastSeenLeased, staleNotifiedAt, daysSinceSeen, fortigateDevice, pushedToId, pushedToName }`.
- `GET    /reservations/alerts/count`           — Just `{ count }`. Always counts the **active** list — ignored rows don't drive the sidebar badge.
- `POST   /reservations/:id/snooze`             *(user-or-above)* — Sets `staleSnoozedUntil = now + staleAfterDays` so the row is suppressed from the active alert list. Cleared automatically when discovery sees the IP active again. Returns `{ reservationId, snoozedUntil, daysAdded }`. Writes `reservation.stale.snoozed` (info).
- `POST   /reservations/:id/stale-ignore`       *(networkadmin)* — Permanently ignore stale alerts on this row (`staleIgnored=true`). NOT cleared by discovery activity; operator's intent persists across online/offline cycles. Writes `reservation.stale.ignored` (info).
- `DELETE /reservations/:id/stale-ignore`       *(networkadmin)* — Un-ignore. Writes `reservation.stale.unignored` (info).

### Utilization — `requireAuth`
- `GET    /utilization`
- `GET    /utilization/blocks/:id`
- `GET    /utilization/subnets/:id`

### Users — `requireAdmin`
- `GET    /users`
- `POST   /users`
- `GET    /users/:id`
- `PUT    /users/:id`
- `DELETE /users/:id`
- `PUT    /users/:id/role`
- `DELETE /users/:id/totp`                      — Admin-initiated TOTP reset (for "lost device" recovery). Clears the secret and backup codes so the user can re-enroll on next login.

### Integrations — `requireNetworkAdmin`
- `GET    /integrations`
- `POST   /integrations`
- `GET    /integrations/:id`
- `PUT    /integrations/:id`
- `DELETE /integrations/:id`
- `POST   /integrations/:id/test-connection`
- `POST   /integrations/:id/discover`           — Trigger full discovery run
- `GET    /integrations/discoveries`            — List in-flight discoveries. Each entry: `{ id, name, type, startedAt, elapsedMs, activeDevices: string[], slow: boolean, slowDevices: string[] }`. `slow` flips true when the overall run exceeds its rolling-duration baseline; `slowDevices` lists FortiGates (FMG-only) whose per-device elapsed exceeds that device's baseline. This endpoint also calls the slow-run checker inline, so the UI sees amber within one 4 s poll cycle. See `discoveryDurationService` + the `discoverySlowCheck` job.
- `DELETE /integrations/:id/discover`            — Abort an in-flight discovery
- `POST   /integrations/:id/query`              — Manual API proxy. FortiManager: `{method, params}` (JSON-RPC). FortiGate: `{method, path, query?}` (REST). Entra ID: `{path, query?}` GET-only against `graph.microsoft.com`; path must begin with `/v1.0/` or `/beta/`. Active Directory: `{filter?, baseDn?, scope?, attributes?, sizeLimit?}` LDAP search; baseDn defaults to the integration's configured base DN.
- `GET    /integrations/:id/interface-aggregate?class=fortigate|fortiswitch|fortiap` — Auto-Monitor Interfaces "By name" data source. Returns `{ rows: [{ ifName, ifType, deviceCount, devices: [{assetId, hostname, ipAddress}] }] }`, sorted by deviceCount desc. Source: latest `AssetInterfaceSample` per `(assetId, ifName)` for assets where `discoveredByIntegrationId = :id` AND `assetType` matches the class (firewall / switch / access_point). Empty array on a fresh integration before any system-info pass has run.
- `POST   /integrations/:id/interface-aggregate/preview` — Live preview for the modal. Body: `{ class, selection: AutoMonitorInterfacesSchema | null }`. Returns `{ deviceCount, interfaceCount, perDeviceMax, sampleDevices: [{hostname, pinNames: string[]}] }`. Read-only: does not persist or write `monitoredInterfaces`. `interfaceCount` is the sum of pin lengths produced by `selection` alone (not unioned with operator-pinned interfaces).
- `POST   /integrations/:id/interface-aggregate/apply` — Apply-on-save trigger. Body: `{ class }`. Reads the current `selection` from `Integration.config.<klass>Monitor.autoMonitorInterfaces` (whatever was most recently saved) and runs the same apply pass that fires at the end of every discovery: union into each matching asset's `monitoredInterfaces` (additive only). Writes one `integration.auto_monitor_interfaces.applied` Event when something changed. Returns `{ devices, interfacesAdded, perDeviceMax, sampleDevices }`. Called by the integration edit modal's **Save Changes** button for each per-class block whose selection is non-null, so saving the modal pins interfaces immediately without waiting for the next discovery cycle.

### Assets — `requireAuth`
- `GET    /assets`                              — List (filter by status, type, department, search, createdBy)
- `POST   /assets`
- `GET    /assets/:id`
- `PUT    /assets/:id`
- `DELETE /assets/:id`
- `DELETE /assets`                              — Bulk delete
- `POST   /assets/export-pdf`
- `POST   /assets/export-csv`
- `GET    /assets/mac-lookup/:mac`              — OUI vendor lookup
- `POST   /assets/:id/dns-lookup`               — Reverse PTR lookup (IP → hostname); per-asset, user-triggered
- `POST   /assets/:id/forward-lookup`           — Forward A/AAAA lookup (hostname/dnsName → IP); fills ipAddress when missing
- `DELETE /assets/:id/macs/:mac`                — Remove one MAC from an asset's history (requires network admin)
- `GET    /assets/:id/ip-history`               — List IP history entries for an asset (filtered by retention days). Auto-populated by the Prisma query extension in `src/db.ts` whenever any `asset.create` / `asset.update` writes an `ipAddress`, so discovery-sourced IPs are captured without changes to integration services.
- `GET    /assets/ip-history-settings`          — `{ retentionDays }`; 0 = keep forever (default).
- `PUT    /assets/ip-history-settings`          *(assets admin)* — `{ retentionDays }`; saving immediately prunes any history rows with `lastSeen` older than the new cutoff.
- `GET    /assets/monitor-settings`             — Global monitor defaults: `{ intervalSeconds, failureThreshold, sampleRetentionDays, telemetryIntervalSeconds, systemInfoIntervalSeconds, telemetryRetentionDays, systemInfoRetentionDays, fortiswitch: {...same shape...}, fortiap: {...same shape...} }`. Top-level fields apply to every monitored asset that isn't a Fortinet switch/AP — Cisco SNMP, AD WinRM/SSH, ICMP, etc. The nested `fortiswitch` / `fortiap` groups apply to assets where `assetType="switch"` (or `"access_point"`) AND `manufacturer="Fortinet"`; on a fresh install they inherit from the top-level values. Defaults: 60s / 3 / 30d / 60s / 600s / 30d / 30d (per group). Editable from the **Monitoring** tab on any FMG/FortiGate integration's Add/Edit modal, which is split into three subtabs (FortiGates / FortiSwitches / FortiAPs) — settings are global, the tab is just a convenient editor surface.
- `PUT    /assets/monitor-settings`             *(assets admin)* — Update any of the above; the request body accepts the top-level fields and the `fortiswitch` / `fortiap` nested objects. Telemetry minimum 15s, systemInfo minimum 60s. Retention prune is per-class: every prune cycle deletes Fortinet switch samples per `fortiswitch.<retention>`, Fortinet AP samples per `fortiap.<retention>`, and everything else per the top-level retention.
- `POST   /assets/bulk-monitor`                 *(assets admin)* — `{ ids, monitored, monitorType?, monitorCredentialId?, monitorIntervalSec? }`. Applies one type+credential to every selected row, including integration-discovered firewalls and AD hosts (the type lock was removed; operators can bulk-flip a FortiGate fleet from FortiOS REST to SNMP from the toolbar). Returns `{ updated, errors: [{id, error}] }`.
- `GET    /assets/:id/monitor-history?range=1h|24h|7d|30d` *or* `?from=ISO&to=ISO`  — Sample stream for the chart. With `range`, the window ends at *now*; with `from`/`to`, both bounds come from the query (span capped at 1 year). Returns `{ range, since, until, samples, stats: { total, failed, successRate, packetLossRate, avgMs, minMs, maxMs } }`; `range` is `"custom"` when `from`/`to` was used. `responseTimeMs` is null on failed samples (the "packet loss" signal).
- `POST   /assets/:id/snmp-walk`                *(admin)* — Operator-driven SNMP walk for the asset details **SNMP Walk** tab. Body: `{ credentialId, oid?, maxRows? }`. `credentialId` is any stored SNMP credential (not necessarily the asset's monitor credential — admins can spot-check a host with a different community). `oid` defaults to `1.3.6.1.2.1.1` (system subtree); validated as a numeric dotted OID. `maxRows` defaults to 500, hard-capped at 5,000. Returns `{ rows: [{oid, type, value}], truncated, durationMs, oid, host }` — `type` is the symbolic ASN.1 type name (Counter32, OctetString, OID, IpAddress, ...) and `value` is a printable representation (UTF-8 OctetString when printable, hex otherwise; IpAddress is dotted-quad). Walks the asset's `ipAddress` directly — does not consult `monitorType`, so it works on any asset including unmonitored ones. Each call writes one `asset.snmp_walk` Event (`info` on success, `warning` on failure). 400 if the asset has no IP or the credential is not type `snmp`; 502 if the SNMP session itself fails.
- `POST   /assets/:id/probe-now`                *(user-or-above)* — Run an immediate response-time probe AND a telemetry + system-info pull; returns `{ success, responseTimeMs, error?, telemetry: { supported, collected, error? }, systemInfo: { supported, collected, error? } }`. Per-stream statuses let the System tab's **Refresh** button toast tell the operator which streams refreshed and which failed (`collected: false` with an `error` is the common case when, e.g., FortiManager-discovered assets in proxy mode have no direct `fortigateApiToken` configured — the SNMP-override probe succeeds but the FortiOS REST system-info call throws "FortiManager direct-mode API token not configured"). The endpoint first runs the originating integration's filter via `assetMatchesIntegrationFilter` in `src/utils/integrationFilter.ts` — FMG/FortiGate/Entra check `deviceInclude`/`deviceExclude` against the asset's hostname; AD checks `ouInclude`/`ouExclude` against the OU path. If the asset is out of scope the call returns `409` with the reason in `error` and on every stream's `error`, no probe traffic leaves the host, and one `asset.refresh` Event is written at level `warning` with message `Refresh blocked: <name> — <reason>`. The FMG/FortiGate `interfaceInclude` / `interfaceExclude` is applied a layer down inside `collectSystemInfoFortinet` so the System tab interface table mirrors discovery's scope — VLAN sub-interfaces are kept when their parent survives the filter (hiding the parent would orphan its children, so the filter walks the parent → child relationship before dropping rows). Otherwise each call writes one `asset.refresh` Event (level `info` on full success, `warning` on any partial failure) so manual refreshes are auditable — the periodic monitorAssets job only writes events on up/down transitions.
- `GET    /assets/:id/system-info`              — Asset details System tab: latest interface + storage + telemetry snapshot. Returns `{ monitored, monitorType, lastTelemetryAt, lastSystemInfoAt, telemetry: {...}|null, interfaces: [...], storage: [...], temperatures: [...], ipsecTunnels: [...], lldpNeighbors: [...] }`. `lldpNeighbors` is the full set of `AssetLldpNeighbor` rows for the asset (current state, not a time-series); each entry includes `localIfName`, full LLDP TLVs (chassisId/portId + subtypes, port description, system name/description, management IP, capabilities), `firstSeen` / `lastSeen`, the source transport (`"fortios"` | `"snmp"`), and a `matchedAsset: { id, hostname, ipAddress, assetType } | null` cross-link when the neighbor resolved to a Polaris asset by management IP, chassis MAC, or hostname. Empty arrays when no scrape has run yet.
- `GET    /assets/:id/telemetry-history?range=1h|24h|7d|30d` *or* `?from&to`  — CPU/memory time-series. Returns `{ range, since, until, samples, stats: { total, avgCpuPct, maxCpuPct, avgMemPct, maxMemPct } }`. memPct is computed from `memUsedBytes / memTotalBytes` if the source supplied bytes only.
- `GET    /assets/:id/interface-history?ifName=...&range=...`  — Per-interface counter samples; sized by interface (a 30-port switch with one row per 10 min ≈ 4,300 samples per 30-day range). Includes `inErrors` / `outErrors` (cumulative IF-MIB / FortiOS error counters) so the asset-detail interface slide-over can derive a per-interval error rate. The response also surfaces the latest sample's `alias` / `description` at the top level (FortiOS CMDB `alias` + `description`, SNMP `ifAlias`) so the slide-over header can show `<alias> (<ifName>)` and render the comment in the **Interface Comments** editor. `description` is the *resolved* value (override if set, else discovered); `discoveredDescription` and `overrideDescription` are also returned separately so the editor can label the source and show the device-reported value as ghost text when no override is set. The response also carries `lldpNeighbors`: the LLDP rows whose `localIfName === ifName` (usually 0 or 1, sometimes >1 on shared media); each row includes the same fields as the system-info endpoint plus a `matchedAsset` cross-link, so the slide-over can render an LLDP neighbor card with a clickable system name that opens the matched asset's view modal.
- `PUT    /assets/:id/interfaces/:ifName/comment` *(assets admin)* — Set or clear the Polaris-local Interface Comments override. Body: `{ description: string | null }` (max 255 chars; null or empty string deletes the override row so the discovered FortiOS CMDB description shows through again). Polaris never pushes this value back to the device. Writes one `asset.interface.comment_updated` Event.
- `GET    /assets/:id/temperature-history?range=...[&sensorName=...]`  — Per-sensor temperature time-series. Returns `{ samples, stats: { total, avgCelsius, minCelsius, maxCelsius } }`. Shared with telemetry retention.
- `GET    /assets/:id/storage-history?mountPath=...&range=...`  — Per-mountpoint usage samples. SNMP-monitored assets only.
- `GET    /assets/:id/ipsec-history?tunnelName=...&range=...`  — Per-tunnel IPsec samples (status timeline + cumulative bytes). FortiOS-monitored assets only.
The assets list and single-GET attach a synthesized `ipContext` field to each row: `{ subnetId, subnetCidr, reservation: { id, createdBy, sourceType } | null } | null` (null when the asset has no IP, or no non-deprecated subnet contains the IP). The Assets page reads it to render a **View Lease** button on rows whose IP lives in a known subnet — clicking it navigates to `/subnets.html#ip=<subnetId>@<ipAddress>`, where the network slide-over opens scrolled to that IP's row. To reserve or release IPs, operators use the network slide-over directly (no asset-row Reserve/Unreserve buttons).

#### Quarantine (admin + assetsadmin, or bearer token with `assets:quarantine` scope)
- `GET    /assets/sighting-settings`            *(auth)* — `{ sightingMaxAgeDays }` (default 180).
- `PUT    /assets/sighting-settings`            *(assetsadmin)* — `{ sightingMaxAgeDays }`. Max 3650.
- `GET    /assets/:id/sightings`                *(auth)* — DHCP sighting history for this asset (list of `{ fortigateDevice, source, ipAddress, lastSeen, integrationId, subnetName, vlan }`). `subnetName` + `vlan` are resolved at request time by matching the stored `ipAddress` against subnets discovered on the same `fortigateDevice` — both are null when the IP doesn't fall inside any known subnet on that device (e.g. the subnet has been deleted or the sighting predates the `ipAddress` column).
- `GET    /assets/:id/sources`                  *(auth)* — Per-discovery-source view of an asset (Phase 3a of the multi-source asset model). Returns every `AssetSource` row attached to this asset with the originating integration's name + type joined in, sorted in stable presentation order (`entra` → `intune` → `ad` → `fortigate-firewall` → `fortiswitch` → `fortiap` → `manual`). Each entry: `{ id, sourceKind, externalId, integration: { id, name, type } | null, observed, inferred, syncedAt, firstSeen, lastSeen }`. Powers the **Sources** tab on the asset details modal — operators can see what each integration independently said about the device.
- `POST   /assets/:id/sources/:sourceId/split`  *(admin)* — Recovery action. Detaches the chosen `AssetSource` row from this asset and binds it to a freshly-created Asset whose discovery-owned fields are seeded from the source's `observed` blob via `projectAssetFromSources([source])`. The new Asset gets a `split-from-asset` tag plus a source-kind hint (`entraid` / `activedirectory` / `fortigate` / etc.). **Phase 4d retired the `assetTag` write here** — the AssetSource row that just got re-bound is the canonical identity link; the legacy `entra:`/`ad:`/`fgt:` assetTag prefixes were back-compat markers that re-discovery already stopped consulting in Phase 2. Refusal rules: source not on this asset (404), source is the asset's only source (409 — would leave the original orphaned), source is `sourceKind="manual"` (409 — backfill marker, not a real discovery source). Returns `{ originalAssetId, newAssetId, movedSourceId, newAsset }`. Asset-row FKs (monitoring samples, IP history, sightings, quarantine, conflicts) all stay on the **original** asset; the new Asset starts clean. Writes one `asset.split` Event with details `{ originalAssetId, newAssetId, sourceId, sourceKind, externalId }`.
- `GET    /assets/:id/quarantine-status`        *(auth)* — `{ status, quarantineReason, quarantinedAt, quarantinedBy, quarantineTargets }`.
- `POST   /assets/:id/quarantine`               *(assetsadmin | token:assets:quarantine)* — Push MAC block to every FortiGate that has a sighting within `sightingMaxAgeDays`. Body: `{ reason? }`. Returns `{ message, succeededCount, failedCount, targets[] }`. On at least one push success the asset `status` is set to `quarantined` and `quarantineTargets` is stamped. actor is derived from session username or `req.apiToken.name`. **Infrastructure assets (`assetType` = `firewall` / `switch` / `access_point`) are rejected with 400** — quarantining the device that does the quarantining would lock the operator out of the network. Release endpoints don't enforce the type guard so a misclassified quarantine can still be undone.
- `DELETE /assets/:id/quarantine`               *(assetsadmin | token:assets:quarantine)* — Best-effort unpush from all synced targets, then restores `statusBeforeQuarantine` (defaults to `active`). Device-side failure does not block release.
- `POST   /assets/:id/quarantine/verify`        *(assetsadmin | token:assets:quarantine)* — Re-reads each target from the FortiGate and flips any missing ones to `drift`. Persists the updated `quarantineTargets` if drift was detected. Writes `asset.quarantine.drift_detected` Event.
- `POST   /assets/bulk-quarantine`              *(assetsadmin | token:assets:quarantine)* — Body `{ ids[], reason? }`. Per-asset errors are collected; partial success is still reported. Returns `{ results: [{ id, ok, message }] }`.
- `POST   /assets/bulk-quarantine/release`      *(assetsadmin | token:assets:quarantine)* — Body `{ ids[] }`. Best-effort release per asset.

### API Tokens — `requireAdmin`
- `GET    /api-tokens`                          — List all tokens (`{ tokens[], knownScopes[], quarantineIntegrations[] }`). `quarantineIntegrations` is the FMG/FortiGate roster (`{ id, name, type, enabled, pushQuarantineEnabled }`) so the UI can render the per-token integration picker and the "push disabled — integration off / pushQuarantine toggle off" alert without a second round-trip. Hashes are never returned.
- `POST   /api-tokens`                          — Create. Body: `{ name, scopes: string[], integrationIds?: string[], expiresAt? }`. `integrationIds` is REQUIRED + non-empty when `scopes` includes `assets:quarantine`; ignored for read-only tokens. Each id must reference a real integration of type `fortimanager` or `fortigate`. Returns `{ token: ApiTokenSummary, rawToken: string }` — `rawToken` is shown once and never recoverable.
- `POST   /api-tokens/:id/revoke`               — Mark as revoked (token stops working immediately); row is kept for audit.
- `DELETE /api-tokens/:id`                      — Hard-delete the token row.

### Credentials — mixed scoping
- `GET    /credentials`                         *(auth)* — List stored credentials with secrets masked. Read-open so any role's Asset Monitoring tab can render the credential picker.
- `GET    /credentials/:id`                     *(auth)* — Single credential, masked.
- `POST   /credentials`                         *(admin)* — Create. Body: `{ name, type: "snmp"|"winrm"|"ssh", config }`. Type-specific config is validated server-side.
- `PUT    /credentials/:id`                     *(admin)* — Update. Type cannot be changed after creation. Resubmitting the mask sentinel for a secret field preserves the stored value.
- `DELETE /credentials/:id`                     *(admin)* — 409 if any asset still references the credential as `monitorCredentialId`.
- `POST   /credentials/test`                    *(admin)* — Exercise a credential against a chosen asset's IP without persisting anything. Body: `{ assetId, type, config, id? }`. When `id` is present, masked secrets in `config` are merged from the stored credential via `mergeConfigPreservingSecrets()` so the operator can edit and test without retyping the password. Resolves the asset's host from `ipAddress || dnsName || hostname`, then dispatches to `monitoringService.probeCredentialAgainstHost()` (icmp/snmp/winrm/ssh — the same one-shot probe primitives used by the response-time monitor). Returns the standard probe shape `{ success, responseTimeMs, error?, host }`. Validation failures are returned in the same shape rather than 4xx so the modal renders them inline alongside probe failures. Drives the **Test Connection** button on the add/edit credential modal in Server Settings → Credentials, which opens a second modal with an asset autocomplete (powered by `GET /search`) and reports the result inline. Each call writes one `credential.tested` Event (info on success, warning on failure).

### Manufacturer Aliases — `requireAdmin`
- `GET    /manufacturer-aliases`                — List every alias row (`{ id, alias, canonical, createdAt, updatedAt }`).
- `POST   /manufacturer-aliases`                — Create. Body: `{ alias, canonical }`. `alias` is normalized to lowercase + trimmed before insert; uniqueness on the lowercased form. 409 on duplicate. Saving refreshes the in-memory cache and runs `applyAliasesToExistingRows()` in the background so existing Asset/MibFile rows pick up the new mapping.
- `PUT    /manufacturer-aliases/:id`            — Update. Either or both of `alias` / `canonical` can be supplied. Same cache-refresh + backfill on save.
- `DELETE /manufacturer-aliases/:id`            — Remove. Cache is refreshed; existing rows are not rewritten (they already hold the canonical value).

### Events — mixed scoping
- `GET    /events`                              *(auth)* — Audit log (filter by level, action, resourceType, message — message is case-insensitive substring)
- `GET    /events/archive-settings`             *(admin)* — reveals SSH host/user/path even with password masked
- `PUT    /events/archive-settings`             *(admin)*
- `POST   /events/archive-test`                 *(admin)*
- `GET    /events/syslog-settings`              *(admin)* — reveals host/port/TLS paths
- `PUT    /events/syslog-settings`              *(admin)*
- `POST   /events/syslog-test`                  *(admin)*
- `GET    /events/retention-settings`           *(auth)*
- `PUT    /events/retention-settings`           *(admin)*
- `GET    /events/asset-decommission-settings`  *(auth)*
- `PUT    /events/asset-decommission-settings`  *(admin)* — `{ inactivityMonths }`; 0 disables auto-decommission

### Conflicts — `requireAuth` (role-scoped list + resolve)
- `GET    /conflicts`                           — List. Role-filtered: admin sees all; networkadmin sees reservation conflicts only; assetsadmin sees asset conflicts only; others see empty list.
- `GET    /conflicts/count`                     — Badge count; same role scoping as the list.
- `POST   /conflicts/:id/accept`                — Reservation: apply discovered values. Asset: upsert an `AssetSource` row (`sourceKind` = `entra`/`ad`, `externalId` = `proposedDeviceId`) tying the existing asset to the proposed Entra/AD identity, plus overlay Entra/AD fields into empty existing fields. **Hostname has one extra rule:** when the conflict was raised via 15-char NetBIOS truncation (`proposedAssetFields.matchedVia === "netbios"`), the longer canonical hostname replaces the truncated one even when the existing field is non-empty — the truncated form is a NetBIOS quirk, not a deliberate choice. **Phase 4d retired the legacy `assetTag = entra:<id>` / `ad:<guid>` write and the `prev-{prefix}{id}` breadcrumb tag** — the AssetSource row is now the canonical identity link, and audit trail is captured by the auto-resolve syncLog event. **Ghost-sibling lookup** (when a different asset already owns the proposed source's externalId) now queries `AssetSource` by `(sourceKind, externalId)` instead of by `assetTag` — the ghost's non-empty fields are absorbed and the ghost is deleted so the unique-constraint upsert lands cleanly. 403 if caller's role doesn't cover this conflict's entityType.
- `POST   /conflicts/:id/reject`                — Reservation: keep existing, dismiss. Asset: create a separate new Asset for the Entra/AD snapshot, then upsert its `AssetSource` row (`sourceKind` = `entra`/`ad`, `externalId` = `proposedDeviceId`) so the next discovery run finds the new asset by source and doesn't re-fire the collision.

**Asset-conflict flavours.** `proposedAssetFields.collisionReason` distinguishes two pathways the discovery sync can raise an asset-collision conflict, in decreasing order of confidence:
- `"untagged-collision"` — incoming Entra/AD device's hostname matches an existing asset that has no source tag (DHCP-discovered, manually created, etc.).
- `"duplicate-registration"` — incoming hostname matches an existing asset already tagged by the same source with a *different* deviceId/objectGUID (Entra returned two distinct deviceIds for the same display name — re-enrol, re-image, dual-boot — or AD has two `objectGUID`s for what looks like the same physical computer). Accepting re-keys the existing asset's source row to the incoming externalId (the prior identity is captured in the auto-resolve syncLog Event for audit; Phase 4e retired the previously-written `prev-{prefix}{id}` breadcrumb tag).

`proposedAssetFields.matchedVia` indicates the matching mechanism: `"exact"` (full hostname equality) or `"netbios"` (matched only after truncating one side to 15 chars). NetBIOS-truncation matching pairs an AD `cn`-derived 15-char hostname with the full Entra `displayName` and vice versa, so neither side missing the FQDN-aware rename causes a phantom split.

**Note:** The legacy `"mac-collision"` flavour (Entra-only, raised when the incoming Intune Ethernet MAC matched a MAC ever recorded on another asset) was retired — the Entra sync now treats Ethernet MAC as a positive identity-match signal and silently cross-links, the same way SID does for hybrid-joined devices. See "Hybrid-join cross-link" below for the cascade. Existing `mac-collision` conflict rows in production databases keep rendering through the events.js compatibility branch; no new ones are created.

### Search — `requireAuth`
- `GET    /search?q=<query>`                    — Global typeahead. Classifies input (IP, CIDR, MAC, or text), runs parallel entity queries, returns grouped results (`blocks`, `subnets`, `reservations`, `assets`, `ips`, `sites`) capped at 8 per group. `sites` carries firewall assets that have lat/lng coordinates (i.e. pinned on the Device Map); these are filtered out of `assets` so the same FortiGate doesn't appear twice. The frontend dropdown labels the `sites` group "Device Map" and pan-to-marker on click via `window.polarisMapPanToAsset` (or navigates to `/map.html#site=<id>` from other pages). The `ips` hit resolves the containing subnet and any active reservation. **Page-aware section ordering**: when the operator is on `/map.html` the Device Map section is hoisted to the top of the dropdown; same logic for `/subnets.html` (Networks), `/assets.html` (Assets), `/blocks.html` (Blocks). All authenticated roles can search; front-end edit modals render in view-only mode for users without write permission.

### Device Map — `requireAuth`
- `GET    /map/sites`                           — Every firewall Asset with non-null lat/lng. Includes subnet count (via `Subnet.fortigateDevice` match), last-seen status, and a monitor health snapshot: `monitored`, `monitorHealth` (`"up" | "degraded" | "down" | "unknown"`, `null` when unmonitored), `monitorRecentSamples`, `monitorRecentFailures`. Health is computed from the last 10 `AssetMonitorSample` rows per asset — all 10 ok → `up` (green pin), any failed → `degraded` (amber, "packet loss"), 10/10 failed → `down` (red). The map intentionally uses this fixed 10-sample window rather than the global `monitor.failureThreshold`. Sidebar page entry: "Device Map" (below Dashboard).
- `GET    /map/sites/:id/topology/search?q=<query>` — Site-scoped endpoint search powering the topology modal's search box. Matches `q` as case-insensitive substring against `hostname` / `ipAddress` / `macAddress` / `assignedTo` / `dnsName`, scoped to endpoints whose `lastSeenSwitch` references one of THIS site's FortiSwitches. Returns up to 25 results: `{ id, hostname, ipAddress, macAddress, assetType, assignedTo, switchId, switchHostname, port, lastSeen }`. The frontend pulses the matching switch on the Cytoscape graph and navigates to the endpoint's asset details on click.
- `GET    /map/sites/:id/topology`              — Graph payload for the click-through modal. Returns `{ fortigate, switches[], aps[], subnets[], edges[], interfaceEdges[], lldpNodes[], remoteAssetNodes[], lldpEdges[] }`. Each entry in `switches[]` carries `endpointCount` (total endpoints learned on the switch's ports via Phase 7.5 of FMG/FortiGate discovery) and `endpoints[]` — top-25 by recency, each `{ id, hostname, ipAddress, macAddress, assetType, assignedTo, port, lastSeen }`. The right-hand info panel renders these as a collapsible "Endpoints (N)" section nested under each switch with click-through to asset details. The full set is reachable via the search endpoint above. The `fortigate` object carries the same `monitored` / `monitorHealth` / `monitorRecentSamples` / `monitorRecentFailures` fields as `/map/sites` so the modal's root node color matches the pin. Every edge id references a node in the same payload. FortiGate→Switch edges are derived from `Asset.fortinetTopology.uplinkInterface` (the FortiLink interface from `managed-switch/status.fgt_peer_intf_name`). AP→Switch edges come from `switch-controller/detected-device` MAC learnings matched against AP base_mac during discovery; APs with no peer switch fall back to a direct FortiGate→AP edge. FortiSwitch and FortiAP nodes are always rendered dark gray in the topology — Polaris can't independently probe devices behind the FortiGate, so no monitor color is reported for them. **`interfaceEdges`** carries CMDB-inferred peer links from FortiOS interface naming conventions, computed by `interfaceTopologyService.inferInterfaceTopology` against the latest `AssetInterfaceSample` per (assetId, ifName) for every site asset: aggregate names that encode a peer's serial fragment (auto-stamped FortiLink — e.g. `8FFTV23025884-0` ↔ `S108FFTV23025884`) AND operator-named hostname aggregates (custom MCLAG between non-stacked pairs — e.g. `METROR2-T1024E`). Each entry: `{ source, target, sourceIfName, label, via: "interface", matchVia: "serial" | "hostname" }`. Cross-site peers matched via this pathway are added to `remoteAssetNodes` alongside LLDP-matched cross-site assets. Authoritative — duplicates against `edges` (controller-derived) are dropped, and the LLDP dedupe set is seeded with `interfaceEdges` so a peer link confirmed by both signals only renders once. Rendered as solid teal lines (distinct from the muted gray controller-data edges and the dashed orange LLDP edges). **`lldpNodes` / `remoteAssetNodes` / `lldpEdges`** carry LLDP-derived topology that fortinetTopology can't see: every `AssetLldpNeighbor` row whose `assetId` is the FortiGate or any of its sibling switches/APs is examined, neighbors that resolve back to a sibling are skipped (the authoritative FortiLink/MAC edge already covers them), **neighbors matched to a Polaris asset OUTSIDE this site** are surfaced into `remoteAssetNodes` (separate from ghost LLDP nodes — they're real assets, just at another site; rendered with a solid blue border and a tap-handler that pivots to the asset details page), and unmatched neighbors get a synthesized **ghost** node in `lldpNodes` keyed on chassisId so multi-link aggregates collapse to one. Each LLDP edge carries `targetLabel` (hostname/IP/chassisId for the right-hand info panel) and `targetIsAsset` (true → the link in the panel pivots to the asset details page). The cytoscape graph styles LLDP edges as dashed orange lines, ghost nodes with a dashed orange border, and remote-asset nodes with a solid blue border — distinguishing observed-via-LLDP links from authoritative controller data and "real asset elsewhere" from "non-Polaris device."

### Allocation Templates — mixed scoping
- `GET    /allocation-templates`                *(auth)* — List saved multi-subnet templates used by the Networks "Auto-Allocate Next" modal.
- `POST   /allocation-templates`                *(networkadmin)* — Create a template. Body: `{ name, entries: [{name, prefixLength, vlan?} | {skip: true, prefixLength}] }`.
- `PUT    /allocation-templates/:id`            *(networkadmin)* — Update a template.
- `DELETE /allocation-templates/:id`            *(networkadmin)* — Delete a template.

### Server Settings — `requireAdmin`
- `GET    /server-settings`
- `PUT    /server-settings`
- `GET    /server-settings/branding`            — Public; used by login page
- `POST   /server-settings/https`
- `POST   /server-settings/database/backup`
- `POST   /server-settings/database/restore`
- `GET    /server-settings/pg-tuning`           — Capacity + tuning health check. Returns the legacy `{needed, triggered, counts, thresholds, settings, snoozedUntil, ramInsufficient, currentRamGb, recommendedRamGb}` payload **plus** `capacity: CapacitySnapshot` from `capacityService.getCapacitySnapshot()`. The capacity payload exposes overall `severity` (`ok` | `watch` | `amber` | `red`), an array of `reasons` ({severity, code, message, suggestion}), `appHost.volumes[]` (per-filesystem free/total bytes + the Polaris-named roles each volume serves: `app`/`state`/`backups`/`db`; pre-deduped by stat.dev so single-LV installs collapse cleanly and STIG-style multi-LV layouts surface each filesystem once), `appHost.dbColocated` flag, `database.sampleTables[]` (rows, bytes, deadTupRatio, lastAutovacuum), `database.dataDirectory` (PostgreSQL `SHOW data_directory` when co-located), `workload.monitoredAssetCount`, `workload.monitoredInterfaceCount` (sum of `Asset.monitoredInterfaces` array lengths across every monitored asset — the operator-pinned fast-poll subset), and `workload.steadyStateSizeBytes` — the projected DB size at current monitored-asset count × cadences × retention. Severity tiering: **red** (disk free <10% on any volume, DB > 50% of free disk on its volume, autovacuum stale >7d on a populated sample table, projected size > 8× host RAM) drives the non-dismissible sidebar alert; **amber** (disk 10–20%, dead-tup >20%, projected > 4× RAM, plus the legacy ramInsufficient/pgTuningNeeded signals) drives the existing snoozable PG-tuning + RAM-warning alerts; **watch** (disk 20–30% on any volume) emits the transition Event but does NOT drive the navbar banner — gives ops a "you have weeks, not minutes" early warning that flows out through eventArchiveService → syslog/SFTP. The route handler also calls `recordCapacityTransition()` (best-effort; void) so a flip into a more severe state writes a `capacity.severity_changed` Event in real time the moment an admin loads the Maintenance tab.
- `POST   /server-settings/pg-tuning/snooze`    — Snooze the **amber** PG-tuning recommendation banner for N days (1–30, default 7). Red capacity alerts are not snoozable from the UI.
- `GET    /server-settings/queue-mode`          — Returns `{ active, persisted, restartRequired, pgbossInstalled }`. `active` is what the running process is using (captured at boot); `persisted` is the current `Setting.monitor.queueMode` value (= what next restart will use). `restartRequired` is true when they differ. UI uses this for the "Pending: pg-boss on next restart" hint on the Maintenance tab Database card.
- `POST   /server-settings/queue-mode`          — Body `{ mode: "cursor" | "pgboss" }`. Writes `Setting.monitor.queueMode` and returns the same shape as GET. Driven by the [Enable on next restart] button on the `pgboss_recommended` capacity reason. 409 if mode is "pgboss" but the package isn't installed in this build. Writes one `monitor.queue_mode.set` Event.
- `GET    /server-settings/mibs?manufacturer=&model=&scope=all|device|generic` — List uploaded MIBs (filters: manufacturer + model exact match, scope filters generic vs device-specific).
- `GET    /server-settings/mibs/facets`         — `{ manufacturers: [], modelsByManufacturer: { mfr: [models] } }` — distinct values from already-uploaded MIBs **plus** the asset inventory, so the upload-form datalists aren't empty before the first vendor MIB is uploaded.
- `GET    /server-settings/mibs/:id`            — Full record including raw `contents`.
- `GET    /server-settings/mibs/:id/download`   — `text/plain` download with the original filename.
- `POST   /server-settings/mibs`                — `multipart/form-data` upload. Fields: `file` (required), `manufacturer?`, `model?`, `notes?`. The body is parsed by a minimal SMI validator (`mibService.parseMib`) before insert: rejects empty files, files containing NUL/control bytes, anything missing the `<NAME> DEFINITIONS ::= BEGIN ... END` envelope, or files exceeding 1 MB. `moduleName` and `imports` are extracted from the parse and stored on the row. Duplicate `(manufacturer, model, moduleName)` returns 409. Setting `model` without `manufacturer` is a 400 (generic MIBs can't be model-scoped).
- `DELETE /server-settings/mibs/:id`            — Remove a stored MIB.
- `GET    /server-settings/mibs/profile-status` — Returns one entry per built-in vendor telemetry profile (`{ vendor, matchPattern, example, symbols: [{metric, symbol, resolved, fromModuleName, fromScope}], ready, partial, modelOverrides: [{model, mibCount}] }`). The MIB Database card uses this to render the **Vendor Profile Status** pill. `fromScope` is `"device" | "vendor" | "generic" | "seed"` and reflects which layer of `oidRegistry`'s scoped resolver provided the symbol.

### Device Icons — mixed scoping
Operator-uploaded images that override generic node shapes on the Device Map's topology graph. Resolution priority at render time is most-specific-wins: `manufacturer/model` exact match → `model` alone → `assetType` fallback. Storage is bytes-in-DB (`DeviceIcon` model). Allowed formats: PNG / JPEG / WebP only (SVG excluded for v1 — embedded scripts are an attack surface and Cytoscape's raster rendering is fine for any zoom level). 256 KB hard cap. Magic-byte check at upload validates declared mimeType matches actual content.
- `GET    /device-icons`                         *(admin)* — List uploaded icons. Each row carries `{ id, scope, key, filename, mimeType, size, uploadedBy, uploadedAt, url }` where `url` points at the image-serve endpoint below for thumbnail previews.
- `POST   /device-icons`                         *(admin)* — `multipart/form-data` upload. Fields: `file` (required), `scope` ("type"|"model"), `key`. Re-uploading the same `(scope, key)` pair replaces the existing image atomically.
- `DELETE /device-icons/:id`                     *(admin)* — Remove an uploaded icon.
- `GET    /device-icons/:id/image`               *(auth)* — Serves raw bytes with the stored `Content-Type` and `Cache-Control: private, max-age=3600`. Topology endpoint embeds this URL in each node's `iconUrl` so Cytoscape's `background-image` renders the uploaded icon directly. Browser HTTP cache deduplicates fetches across re-renders.

---

## Authentication & RBAC

Sessions are PostgreSQL-backed (`connect-pg-simple`), 8-hour max age, HttpOnly/Secure/SameSite=Lax cookies.

| Role | Access |
|------|--------|
| `admin` | Full access to all routes |
| `networkadmin` | Integrations, conflicts, + full CRUD on any subnet/reservation |
| `assetsadmin` | Assets, asset conflicts, + create subnets/reservations and edit/delete their own |
| `user` | Create subnets/reservations and edit/delete their own; read-only on everything else |
| `readonly` | Read-only on all `requireAuth` routes |

**Ownership model for networks and reservations.** `user` and `assetsadmin` callers can create subnets (`POST /subnets`, `POST /subnets/next-available`, `POST /subnets/bulk-allocate` + `/preview`) and reservations, but can only edit/delete records where `createdBy` matches their own username. `admin` and `networkadmin` bypass the ownership check. Enforced via the `requireUserOrAbove` middleware + inline `isNetworkAdminOrAbove(req)` check on PUT/DELETE handlers. The `requireNetworkAdmin` guard still applies to block CRUD. Allocation **templates** are admin-only (`POST/PUT/DELETE /allocation-templates`); `GET /allocation-templates` is open to any authenticated caller so users can pre-fill the bulk-allocate modal from saved templates without being able to create or modify them — the modal hides the Save / Delete buttons for non-admins as a UX hint, but the backend is the source of truth.

Rate limiting: 10 login attempts / 15 min per IP.

Azure SAML SSO is optional; users are auto-provisioned on first login with a default role.

**FMG auth note:** FortiManager 7.4.7+ / 7.6.2+ removed `access_token` query string support. The service uses the Bearer `Authorization` header exclusively. The standalone FortiGate integration (`fortigateService.ts`) uses the same Bearer header pattern against a REST API Admin token.

**Stale-Secure-cookie gotcha (HTTPS → HTTP downgrade):** Modern browsers enforce the "Leave Secure Cookies Alone" rule — a `Set-Cookie` from a non-secure origin is silently rejected if a same-name `Secure`-flagged cookie already exists, *and* the rejection extends to `Max-Age=0` deletions. This bites operators who run Polaris over HTTPS, then later access it over plain HTTP (port change, reverse-proxy reshuffle, fresh-install on the same host:port that previously had a self-signed cert). The browser holds the prior `polaris_csrf` (and possibly `connect.sid`) but won't send it over HTTP and won't let the server overwrite it; every state-changing request fails the CSRF check. The middleware in `csrf.ts` detects the case (HTTP request with no `polaris_csrf` cookie sent at all) and returns a specific error message instructing the operator to clear cookies for the site. The frontend in `public/js/api.js` does a parallel pre-check before mutating requests and shows a one-shot `alert()` with the same instructions when `_readCookie("polaris_csrf")` returns null on an HTTP page. A best-effort `res.clearCookie(..., { secure: true })` is also emitted from HTTP — Firefox/Chrome ignore it per the same rule, but more lenient browsers (Safari, older builds) will honor it and auto-heal. There is no clean server-side fix on Firefox/Chrome; the operator-clears-cookies path is the only reliable recovery.

**Monitor-type override on integration-discovered assets.** Discovery stamps `discoveredByIntegrationId` and a default `monitorType` (`fortimanager` / `fortigate` / `activedirectory`) on each FortiGate firewall and realm-monitorable Windows/Linux host. The Monitoring tab on the asset edit modal exposes the integration default as one of several options — operators can switch to a generic `snmp` / `icmp` / `winrm` / `ssh` probe at any time and assign a stored Credential. This is the recommended path for small-branch FortiGates whose REST sensor endpoint 404s on FortiOS 7.4.x (60F/61F/91G class): switching to SNMP routes telemetry, temperatures, and interfaces over `FORTINET-FORTIGATE-MIB::fgHwSensors` + IF-MIB. Subsequent discovery runs preserve the override — they still stamp `discoveredByIntegrationId` but only re-stamp `monitorType` when it's null or already an integration default. The override detection lives inline in `integrations.ts` discovery sites; `validateMonitorConfig` in `assets.ts` no longer enforces a lock.

**Per-integration monitoring transport (per-stream REST ↔ SNMP toggles):** The FMG/FortiGate integration's `config` JSON carries an SNMP credential (`monitorCredentialId`, UUID of a stored SNMP credential) plus four per-stream toggles that decide which transport each stream uses for any firewall asset *still on the integration default* (`monitorType` = `fortimanager` or `fortigate`):

| Toggle | REST endpoint | SNMP path |
|---|---|---|
| `monitorResponseTimeSource` | `/api/v2/monitor/system/status` | `sysUpTime` |
| `monitorTelemetrySource` (CPU + memory + temperature) | `/api/v2/monitor/system/resource/usage` + `/system/sensor-info` | vendor profile → HOST-RESOURCES + ENTITY-SENSOR + `FORTINET-FORTIGATE-MIB::fgHwSensorTable` fallback |
| `monitorInterfacesSource` (interfaces + storage) | `/api/v2/monitor/system/interface` + CMDB merge | IF-MIB + HOST-RESOURCES |
| `monitorLldpSource` (LLDP neighbor discovery) | `/api/v2/monitor/system/interface/lldp-neighbors` | LLDP-MIB walk (`lldpRemTable` + `lldpLocPortTable` + `lldpRemManAddrTable`) |

All four default to `"rest"`. Setting any to `"snmp"` requires `monitorCredentialId` (validated at save time — POST/PUT both reject the integration save if any toggle is `"snmp"` and no credential is selected). **IPsec tunnels always stay on REST** regardless of toggle — the SNMP path has no equivalent and we don't want toggling "interfaces" off REST to silently kill IPsec history. The asset's own SNMP credential (`Asset.monitorCredentialId`) wins over the integration's when both are set.

LLDP is decoupled from "interfaces" because the FortiOS REST endpoint and SNMP LLDP-MIB don't always agree on coverage — branch-class FortiGates sometimes 404 the REST endpoint while still publishing LLDP-MIB, and vice-versa. The transport resolver dispatches LLDP independently in `collectSystemInfo`: when `monitorLldpSource` differs from `monitorInterfacesSource`, the system-info pass overlays a separate `collectLldpOnlySnmp` (or `collectLldpOnlyFortinet`) call onto the result.

Edited from the **FortiGates subtab** of the Monitoring tab on the integration's Add/Edit modal: a "SNMP credential" picker plus four checkboxes labeled "Use SNMP for: Response time / Telemetry / Interfaces / LLDP". The toggles have no effect on assets the operator has switched to a generic `monitorType` (snmp/winrm/ssh/icmp) — those follow `monitorType` end-to-end via the per-asset `monitorCredentialId`.

**Per-asset transport overrides:** `Asset.monitorResponseTimeSource` / `monitorTelemetrySource` / `monitorInterfacesSource` / `monitorLldpSource` (all `null | "rest" | "snmp"`) override the integration's matching toggle on a single asset. Default `null` = inherit. Edited from the **Monitoring tab** of the asset edit modal as four "Integration default / REST / SNMP" dropdowns that appear when `monitorType` is `fortimanager` or `fortigate`; hidden otherwise.

**Migration of existing setups:** Before this change, just setting `monitorCredentialId` on an FMG/FortiGate integration implicitly rerouted the response-time probe to SNMP. After upgrade, the explicit `monitorResponseTimeSource = "snmp"` toggle is the single source of truth — the one-shot startup job `src/jobs/migrateMonitorTransport.ts` back-fills the toggle to `"snmp"` for any integration that already had a credential configured, so existing deployments don't regress.

**Per-class FortiSwitch / FortiAP direct polling and auto-Monitor flag:** The FMG/FortiGate integration's `config` JSON accepts `fortiswitchMonitor` and `fortiapMonitor` blocks, each `{ enabled: boolean, snmpCredentialId: string | null, addAsMonitored: boolean, autoMonitorInterfaces: AutoMonitorSelection | null }`, plus a `fortigateMonitor: { addAsMonitored: boolean, autoMonitorInterfaces: AutoMonitorSelection | null }` block. The `autoMonitorInterfaces` field is the "Auto-Monitor Interfaces" selection — see the dedicated subsection below for its three modes. Edited from the **FortiSwitches** and **FortiAPs** subtabs (full block) and the **FortiGates** subtab (auto-Monitor checkbox only) of the Monitoring tab. The two switch/AP flags are independent and drive four discovery-time outcomes:

| `enabled` (direct polling) | `addAsMonitored` | Stamped on new switch/AP |
|---|---|---|
| false | false | nothing (operator configures monitoring later) |
| false | true | `monitored=true`, `monitorType="icmp"` (ICMP fallback) |
| true (with credential) | false | `monitorType="snmp"`, `monitorCredentialId=<id>`, `monitored=false` |
| true (with credential) | true | `monitored=true`, `monitorType="snmp"`, `monitorCredentialId=<id>` |

Discovery also stamps `discoveredByIntegrationId=<integration>` on any of the three "non-empty" rows. Existing switch/AP assets are *only* re-stamped when the operator hasn't changed the type — detected as `monitorType` is null OR matches one of the integration's two possible defaults (`snmp` with the integration's credential, or `icmp` with no credential). Anything else (winrm, ssh, a different SNMP credential, etc.) counts as an operator override and is preserved. The subtabs warn that managed FortiSwitches/FortiAPs in FortiLink mode usually keep their own management plane locked down — direct polling only works when SNMP has been explicitly enabled on the device itself, which is the operator's responsibility.

For **FortiGates**, the integration always stamps `monitorType="fortimanager"` or `"fortigate"` (its native default) on new assets, so `fortigateMonitor.addAsMonitored` is the only flag — checking it adds `monitored=true` to fresh creates only. Existing FortiGates are not touched.

**Auto-Monitor Interfaces (per-class):** Each `*Monitor` block above also carries an `autoMonitorInterfaces` field that pre-selects which interfaces on every discovered asset of that class are added to `Asset.monitoredInterfaces` (the "Poll 1m" pin-list scraped on the response-time cadence). Three discriminated-union modes:

```ts
autoMonitorInterfaces:
  | { mode: "names",    names:    string[] }                         // explicit ifNames
  | { mode: "wildcard", patterns: string[]; onlyUp: boolean }        // shell wildcards: * and ?
  | { mode: "type",     types:    Array<"physical"|"aggregate"|"vlan"|"loopback"|"tunnel">; onlyUp: boolean }
  | null                                                              // disabled (default)
```

Edited from a card on each Monitoring subtab (FortiGates / FortiSwitches / FortiAPs); UI defaults to *names* / *wildcard* / *type* respectively. `onlyUp` filters candidate interfaces to those with `operStatus === "up"` on their latest `AssetInterfaceSample`; available on wildcard + type, intentionally not on names (explicit names should pin even when the link is down — that's when history matters most). Default `onlyUp: true` for type, `false` for wildcard. Apply logic lives in `autoMonitorInterfacesService.ts` (pure resolver `resolvePinnedInterfaces` + DB-bound `applyAutoMonitorForClass`); the apply pass runs as Phase 2c at the end of every successful discovery (see "Auto-Monitor Interfaces apply pass" below) and from the integration edit modal's **Save Changes** button via `POST /integrations/:id/interface-aggregate/apply`, which runs once per per-class block whose selection is non-null so operators don't have to wait for the next discovery cycle. **Strictly additive**: never strips operator-pinned interfaces, only adds. Removing a name from the selection on subsequent saves doesn't unpin it on existing assets — operator-owned. The "By name" UI pulls its checklist from `GET /integrations/:id/interface-aggregate?class=...`, which aggregates latest-per-(asset,ifName) `AssetInterfaceSample` rows and returns one row per distinct ifName with a device count and the matching device list. The card's live preview block calls `POST /integrations/:id/interface-aggregate/preview` with the in-flight selection; results above the rough warn threshold (currently 500 pinned interfaces total across the three classes — defined as `AUTO_MONITOR_INTERFACE_WARN_THRESHOLD` in `public/js/integrations.js`) trigger a confirm modal on Save Changes to keep operators from overloading the database with a `type=physical` selection on a fleet of 48-port FortiSwitches.

**Decommission sweep for managed switches/APs.** Discovery tracks two new `DiscoveryResult` arrays — `switchInventoriedDevices` and `apInventoriedDevices` — listing the controller FortiGates whose `managed-switch/status` / `wifi/managed_ap` query returned successfully (including 404, which means the feature isn't licensed but the controller is reachable). At the end of the run, in the same pass that deprecates stale subnets (Phase 2), `syncDhcpSubnets` flips any switch/AP whose `discoveredByIntegrationId` matches this integration AND whose `fortinetTopology.controllerFortigate` is in the inventoried-devices set AND whose serial/hostname is no longer in the discovery's sighting set to `status="decommissioned"`. Switches/APs behind a controller whose inventory query *failed or timed out* are left alone (we didn't get a fresh answer). Re-discovery by serial number flips a decommissioned asset back to `active` (or `storage` for FortiSwitches reported as `Unauthorized`). Each decommission writes one `asset.fortiswitch.decommissioned` or `asset.fortiap.decommissioned` Event with the reason `missing-from-controller`.

**CMDB-vs-monitor query policy (proxy mode):** All CMDB-side data is queried natively from FMG (`/pm/config/device/<name>/...` or `/dvmdb/...`), NOT via `/sys/proxy/json`. Native FMG calls don't hit the per-device proxy throttle, so they parallelize freely even when `useProxy=true`. Only **live monitor** endpoints — DHCP leases, ARP, switch-controller detected-device, managed-switch/AP status, wireless-controller managed_ap, system resource usage — go through the proxy because they must be served fresh from the FortiGate. Currently native-from-FMG: device roster + per-device interface config + DHCP server CMDB + interface IPs + firewall VIPs + system/global (geo coords). Currently proxied (or direct): all `/api/v2/monitor/...` endpoints. The mgmt-IP resolver (`resolveDeviceMgmtIp`) reads from `/pm/config/device/<name>/global/system/interface` filtered by the integration's configured `mgmtInterface` — *not* the `ip` field on the FMG device DB record (that field can be a public/NAT IP and is not what Polaris should use to reach the device).

**Per-device transport (`useProxy` toggle):** The FMG integration has two per-device query transports, selectable in the integration edit modal. The UI checkbox is labeled "Query each FortiGate directly (bypass FortiManager proxy)" — *checked = direct, unchecked = proxy*. The on-disk field is still `useProxy` (true=proxy); the UI just inverts the semantics so the more aggressive option (direct) is the explicit affirmative action. The modal also surfaces a "more than 20 FortiGates → switch to direct" recommendation since proxy mode polls one device at a time.
- **Proxy mode** (default, `useProxy: true`): live `/api/v2/monitor/...` queries funnel through FMG's `/sys/proxy/json`. Parallelism is force-clamped to 1 because FMG drops parallel proxy connections past very low parallelism, surfacing as `fetch failed` on random calls. CMDB-side queries still run native-from-FMG and are NOT subject to this throttle (see "CMDB-vs-monitor query policy" above).
- **Direct mode** (`useProxy: false`): FMG is only used to enumerate the managed FortiGate roster + resolve mgmt IPs (still via the interface CMDB lookup, not the device-DB `ip` field — that one can be a NAT/public IP). Per-device live queries go direct to each FortiGate's management IP using shared REST API credentials stored in `config.fortigateApiUser` / `config.fortigateApiToken`. Each managed FortiGate must have the same REST API admin provisioned with a trusthost that includes Polaris. Delegates per-device work to `fortigateService.discoverDhcpSubnets` and remaps the device name back to FMG's label. Unlocks `discoveryParallelism` (up to 20).

**Reservation push (`pushReservations` toggle):** Both the **FortiManager** and **standalone FortiGate** integrations expose a `pushReservations: boolean` flag (default `false`) in their `config` JSON, edited from the **DHCP Push** tab on the integration's Add/Edit modal. When enabled, every manual reservation created on a subnet that this integration discovered is written to the FortiGate at create time, and the Polaris row only commits if the device write succeeds and verifies on read-back. A push or verify failure aborts the reservation create entirely — no Polaris ghost when the device write didn't land. Transport is dispatched by `buildTransportForIntegration()` in `reservationPushService.ts` based on integration type:
- **FMG, proxy realtime** (`type=fortimanager`, `useProxy: true`): the reserved-address row is written via FMG's `/sys/proxy/json` endpoint (`fmgProxyRest()` in `fortimanagerService.ts`) — FMG forwards the call to the FortiGate using its own stored device credentials. Lands on the FortiGate's running config in real time; FMG sees the change on its next config sync.
- **FMG, direct realtime** (`type=fortimanager`, `useProxy: false`): the device's management IP is resolved via FMG (`resolveDeviceMgmtIpViaFmg()`), then the write goes straight to the FortiGate's REST API using `config.fortigateApiUser` / `config.fortigateApiToken`.
- **Standalone FortiGate** (`type=fortigate`): the write goes directly to the FortiGate's REST API using the integration's own `apiUser` / `apiToken`. There is no FMG layer to choose, so `useProxy` doesn't apply.

Push scope resolution: `reservationPushService.findScopeIdForCidr` matches the subnet's CIDR against the FortiGate's `system.dhcp.server` table by reconstructing each scope's network from `default-gateway` + `netmask` (fall back: `ip-range[0].start-ip` inside the subnet). The matched `scopeId` and the new entry's `entryId` are stamped on the Reservation as `pushedScopeId` / `pushedEntryId` so unpush hits the exact device-side row without re-resolving. **Required FortiManager admin profile changes:** `Device Manager → Manage Device Configurations → Read-Write` is the only sub-permission that needs to flip from the existing read-only baseline; all other Device Manager and Policy & Objects sub-items can stay where they are. Importantly, `Install Policy Package or Device Configuration` should remain **None** — Polaris never triggers installs in this path. The blast radius warning surfaced in the modal is real: FMG profiles have no per-object DHCP-reservation knob, so granting Manage Device Configurations write enables write across every CMDB tree on every FortiGate in the ADOM. The modal also recommends direct mode + a per-FortiGate Custom profile (`Network → Custom → Configuration → Read/Write`) for shops that want least-privilege.

Description written to the FortiGate: `Polaris/<username>: <hostname>` (falls back to `Polaris: <hostname>` when no authenticated user is in scope, which currently never happens through the UI but covers system-initiated paths). Capped at 64 chars to fit comfortably in the FortiOS reserved-address `description` field across versions (older FortiOS 6.2 capped at 35; 7.x supports up to 255). The "Polaris/" prefix lets a FortiGate admin looking at the device immediately identify entries written by Polaris and who pushed them.

`sourceType` flip on push success: when the FortiGate write verifies, the Polaris row's `sourceType` is updated from `manual` to `dhcp_reservation`. Two reasons: (1) the entry really is a DHCP reservation on the device now, and the UI badges should reflect that; (2) the next discovery run sees a matching `dhcp_reservation` row and the existing conflict-detection gate at `integrations.ts:2402` (`if (existingRes.sourceType === "manual") upsertConflict(...)`) is bypassed cleanly — no spurious conflict raised against our own echo. `pushedToId` remains the audit-trail answer to "did Polaris push this?" (and the `reservation.push.succeeded` Event also pins the origin in the audit log).

Frontend MAC enforcement: the subnet IPs endpoint (`GET /subnets/:id/ips`) attaches a `pushEligible: boolean` field to its `subnet` payload, derived from `(integration.type === "fortimanager" || integration.type === "fortigate") && integration.config.pushReservations === true && fortigateDevice` (and IPv4 only — IPv6 reservations are not push-eligible in v1). The IP-panel reserve and auto-allocate modals read this and (a) re-label the MAC field as "MAC Address *" with a hint naming the target FortiGate, and (b) refuse to submit without a MAC. The backend `reservationService.createReservation` enforces the same rule server-side as the source of truth.

Release-time unpush is best-effort — a device-side failure logs `reservation.unpush.failed` (warning) but does not block the Polaris release, so an offline FortiGate doesn't stop operators from letting go of an IP. **Update of pushed reservations is not in scope for v1**: the reservation update endpoint only allows hostname/owner/projectRef/expiresAt/notes (none of which would change the device-side entry's MAC or IP), so re-push on update is a no-op. Operators who need to change the MAC/IP on a pushed reservation must release and recreate.

**Quarantine push (`pushQuarantine` toggle):** Both the **FortiManager** and **standalone FortiGate** integrations expose a `pushQuarantine: boolean` flag (default `false`) in their `config` JSON, edited from the **Quarantine Push** tab on the integration's Add/Edit modal (alongside the DHCP Push tab). When enabled, `quarantineAsset()` pushes MAC-based address-group entries to every FortiGate sighted by this integration within the `quarantine.sightingMaxAgeDays` window. If the toggle is `false` (or absent), quarantine push is skipped entirely for that integration's sightings — the asset's `quarantineTargets` array is left empty (or only populated from integrations that do have the toggle enabled). Release-time unpush iterates the recorded `quarantineTargets` directly (which only contain integrations that were enabled at push time) — toggling off `pushQuarantine` after quarantine has been pushed does not prevent unpush on release. Transport is dispatched by `buildTransportForIntegration()` in `assetQuarantineService.ts` and follows the same FMG-vs-standalone routing as reservation push.

---

## FMG Discovery Workflow

### Asset projection priority table

For each discovery-owned Asset field, the table below lists the ordered set of `AssetSource.sourceKind` rows that `projectAssetFromSources()` consults. First non-empty observed value wins. Inferred sources are skipped. Source kinds not listed for a field = the projection deliberately doesn't consult them. The actual rules live in `src/utils/assetProjection.ts` — keep this table in sync when editing them.

| Asset field         | Priority (high → low)                                                                                                                                                                        |
|---------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `hostname`          | `ad` (`dnsHostName` containing a dot — FQDN only) → `intune` (`deviceName`) → `entra` (`displayName`) → `ad` (`dnsHostName` short or `cn` fallback) → `fortigate-firewall` (`hostname`) → `fortiswitch` (`switchId`) → `fortiap` (`name`) → `fortigate-endpoint` (DHCP client id) |
| `serialNumber`      | `intune` → `fortigate-firewall` → `fortiswitch` → `fortiap`                                                                                                                                  |
| `manufacturer`      | `intune` (alias-normalized) → `fortigate-firewall` / `fortiswitch` / `fortiap` (always literal `"Fortinet"`) → `fortigate-endpoint` (`hardwareVendor`, alias-normalized)                       |
| `model`             | `intune` → `fortigate-firewall` → `fortiap` → `fortigate-endpoint`                                                                                                                            |
| `os`                | `ad` → `intune` → `entra` → `fortigate-endpoint`                                                                                                                                              |
| `osVersion`         | `intune` → `entra` → `ad` → `fortigate-firewall` → `fortiswitch` → `fortiap` → `fortigate-endpoint`                                                                                            |
| `learnedLocation`   | `ad` (`ouPath`) → `fortigate-endpoint` (FortiGate device name as site label) → `fortiswitch` (`controllerFortigate`) → `fortiap` (`controllerFortigate`)                                       |
| `ipAddress`         | `fortigate-endpoint` (live DHCP/ARP) → `fortigate-firewall` (`mgmtIp`) → `fortiswitch` (`mgmtIp`) → `fortiap` (`mgmtIp`)                                                                       |
| `latitude` / `longitude` | `fortigate-firewall`                                                                                                                                                                    |

**Fields the projection does NOT own** (and why):
- `macAddress` / `macAddresses[]` — DHCP discovery + Intune writes feed these directly to Asset; merge happens inline in the discovery sync.
- `status` / `quarantine*` — multi-actor (discovery / quarantine code / decommission job / manual operator) — too many writers for projection to arbitrate.
- `assetType` — usually inferred at create time from OS string and stable thereafter; manual recategorization is sticky.
- `location`, `department`, `assignedTo`, `notes`, `tags`, `monitor*`, `dnsName` — operator-owned or system-owned, not from discovery sources.

**FMG/FortiGate projection apply pass (slice 4f cutover):** The five FMG/FortiGate discovery pathways (DHCP-reservation / DHCP-lease / device-inventory / MAC-table / ARP) each still write Asset fields opportunistically inline (set-when-empty for OS / manufacturer / learnedLocation, set-always for osVersion, etc.). After Phase 10 stamps the `fortigate-endpoint` source rows, **Phase 11 of `syncDhcpSubnets` re-projects every touched asset** and writes back any field where projection priority disagrees with the inline-written value. Fixes the long-standing bug where Intune's verbose `osVersion = "10.0.19045"` gets overwritten by FortiOS's coarser `osVersion = "10.0"` on every device-inventory pass, plus mirror cases where AD's `"Windows 10 Pro"` should beat Intune's `"Windows"`. Only writes fields where the projected value is non-null AND differs from current Asset; quiet syncs skip the round-trip. `ipSource` is set to `<integrationType>:fortigate-endpoint` whenever the projected ipAddress wins, mirroring the existing inline ipSource convention. **Inline-only fields** (not subject to Phase 11): `lastSeenSwitch`, `lastSeenAp` (no source kind besides fortigate-endpoint observes them; "stamp inline, never project" is correct), `macAddresses[]` (multi-source merge happens inline at write time), `status` / `quarantine*` / `assetType` / operator-owned fields.

> **Multi-source asset model (Phase 2 cutover, infrastructure scope) and projection layer (Phase 3b.1 cutover):** Every discovered Fortinet infrastructure asset is on the new `AssetSource` model — firewalls (`sourceKind="fortigate-firewall"`), managed FortiSwitches (`sourceKind="fortiswitch"`), and managed FortiAPs (`sourceKind="fortiap"`) each get an explicit row keyed on `externalId = serialNumber` with a rich source-shaped `observed` blob. Discovery-owned Asset fields (hostname, model, osVersion, manufacturer, serialNumber, ipAddress, latitude, longitude, learnedLocation for switches/APs) come from `projectAssetFromSources()` instead of inline merge logic — every update path upserts the source first, fetches all sources, computes projection, then writes a single Asset.update; every create path projects from a synthetic single-source array (no DB roundtrip) and uses the result in the Asset.create payload. Firewall `learnedLocation` deliberately stays inline (set to the firewall's own hostname / site label) since the projection layer leaves it null for firewall sources by design. Firewall: serial, hostname, model, osVersion, mgmtIp, lat/long, managedBy: "fortimanager"|"fortigate". FortiSwitch: serial, switchId, model, osVersion, mgmtIp, controllerFortigate, uplinkInterface, state, connected, joinTime. FortiAP: serial, name, model, osVersion, mgmtIp, baseMac, status, controllerFortigate, parentSwitch, parentPort, parentVlan. Re-discovery keys on `Asset.serialNumber` via the in-memory `findBySerial` index — the source row exists for the per-source detail view rather than for primary lookup, so the discovery hot path is unchanged. **Endpoint scope (post-Phase-4d):** every endpoint asset the FMG/FortiGate sync touches gets a unified `sourceKind="fortigate-endpoint"` source row (externalId = MAC, normalized colon-uppercase) covering all five discovery pathways — DHCP reservations, DHCP leases, device-inventory (FortiOS `device/list` with hardware/OS/user fingerprinting), switch-port MAC table, ARP enrichment. Whichever pathway found the device contributes its observed fields (hostname, ipAddress, ipSource, os, osVersion, hardwareVendor, model, learnedLocation, lastSeenSwitch, lastSeenAp, discoveredVia); pathways that didn't run leave their fields null. Stamping happens at end-of-sync via a touched-asset-id Set populated as each pathway updates an asset; the upsert helper also sweeps any "manual" Phase-1 placeholder source on the same asset. Backfill startup job `backfillFortigateEndpointSources` covers existing endpoint rows that predated the cutover.

`fortimanagerService.ts` connects to FortiManager via JSON-RPC and discovers:

- **DHCP scopes** → Subnet records (`discoveredBy`, `fortigateDevice`)
- **DHCP reservations** → Reservations (`sourceType: dhcp_reservation`). Discovery walks two sources: the CMDB tree at `/pm/config/device/<name>/vdom/root/system/dhcp/server` (every configured static reservation, regardless of client state) and the live monitor at `/api/v2/monitor/system/dhcp` (currently-active leases plus reservations whose target is online). The two are **merged** — CMDB is the base set, monitor adds anything not already covered, and CMDB wins on overlap by IP. This is intentional: monitor only returns reservations whose target is currently leasing, so trusting only monitor would silently drop static reservations whose target device happens to be offline at discovery time.
- **DHCP leases** → Reservations (`sourceType: dhcp_lease`); captures `expire_time`, `access_point`, `ssid`
- **Interface IPs** → Reservations (`sourceType: interface_ip`) — note: discovery no longer mirrors these into `Asset.associatedIps`. The System tab's interface scrape (run on the monitoring cadence once monitoring is enabled on the firewall asset) is the single source for `Asset.associatedIps` per-interface entries.
- **Virtual IPs (VIPs)** → Reservations (`sourceType: vip`)
- **FortiSwitch devices** → Asset records (`assetType: switch`); via FMG proxy to `/api/v2/monitor/switch-controller/managed-switch/status`. `fortinetTopology` stamped with `{ role: "fortiswitch", controllerFortigate, uplinkInterface }` so the Device Map renders the FortiLink uplink as an edge.
- **FortiAP devices** → Asset records (`assetType: access_point`); via FMG proxy to `/api/v2/monitor/wifi/managed_ap`. `fortinetTopology` stamped with `{ role: "fortiap", controllerFortigate, parentSwitch, parentPort, parentVlan, peerSource, meshUplink, parentApSerial }`. **Switch-port attribution is LLDP-first**: the managed_ap response carries an `lldp[]` array per AP (FortiOS surfaces what the AP itself sees on its lan1 interface); the shared extractor in `src/utils/fortiapLldp.ts` picks the first row whose `system_description` starts with `"FortiSwitch-"`, taking `system_name` as parentSwitch and `port_id` as parentPort (NOT `port_description` — that's operator-set free text). LLDP is authoritative because the AP itself reports its uplink, and works even when FortiOS filters managed-AP MACs out of `detected-device` (which it does on many releases — the symptom is the legacy `Resolved 0/N` log line). `peerSource` records `"lldp"` when this path resolved the link. **The `detected-device` MAC table fallback** still runs but only for APs where LLDP gave nothing (gated on `peerSource !== "lldp"`); when it resolves, `peerSource` is stamped `"detected-device"`. APs that resolve via neither path render hanging off the FortiGate directly. **Mesh topology**: the same managed_ap response carries `mesh_uplink: "ethernet"|"mesh"` and `parent_wtp_id` (= the parent FortiAP's serial) when this AP is a wireless-mesh leaf — both are surfaced on `fortinetTopology` so the topology graph can render the mesh edge to the parent AP rather than just the wired uplink.
- **FortiGate geo coordinates** → `Asset.latitude` / `Asset.longitude` on the firewall Asset, pulled natively from FMG's CMDB at `/pm/config/device/<name>/global/system/global` (`gui-device-latitude` / `gui-device-longitude` — fall back to `latitude`/`longitude`). FMG keeps `config system global` in sync with each managed device, so this read happens **without** the `/sys/proxy/json` wrapper — bypasses the proxy-mode concurrency=1 throttle and saves one round-trip per device per discovery cycle. Existing coords are never blanked when the lookup fails.
- **FortiSwitch / FortiAP MACs** → Updates Asset `lastSeenSwitch` / `lastSeenAp`
- **CMDB roster (configured managed switches + APs per FortiGate)** → captured into `DiscoveryResult.cmdbSwitchSerials` / `cmdbApSerials` via native FMG CMDB reads at `/pm/config/device/<n>/global/switch-controller/managed-switch` and `/pm/config/device/<n>/vdom/root/wireless-controller/wtp` (no `/sys/proxy/json` wrapper — bypasses proxy-mode concurrency=1). Defensive: a switch/AP that's authorized at FMG but currently offline / in a brief post-config-push window may be missing from the live status query; the decommission sweep (`Phase 2b — Decommission stale FortiSwitches/FortiAPs`) treats serials surfaced via CMDB as "still known" so they aren't declared stale. Standalone FortiGate path leaves these arrays empty — its live `managed-switch/status` query already returns disconnected switches with status="Disconnected", so the CMDB cross-check is redundant.
- **Full FortiSwitch MAC table** → captured into `DiscoveryResult.switchMacTable` (one row per `(switchId, portName, mac)` pair). Format-string for `/api/v2/monitor/switch-controller/detected-device` widened to include `ipv4_address|ipv6_address|device_name|host_src|device_type|os_name|is_fortilink_peer`. Sync Phase 7.5 walks this table and stamps `Asset.lastSeenSwitch = "<switchId>/<portName>"` for every endpoint asset whose MAC is on a FortiSwitch port (skipping infrastructure assets and `is_fortilink_peer` rows). The legacy AP→switch attribution still consumes the same data internally for its detected-device fallback path.
- **FortiGate ARP table** → captured into `DiscoveryResult.arpTable` via `/api/v2/monitor/network/arp` per FortiGate. Authoritative IP↔MAC binding for any subnet the FortiGate routes. Sync Phase 7.5 fills `Asset.ipAddress` from ARP **only when the asset's IP is currently empty** — conservative rule that avoids IP-recycling churn (a different device taking over the same DHCP lease later); aggressive overwrite would need a freshness-aware policy.

### FMG proxy field filtering

FortiOS monitor endpoints support field selection via the `format` query parameter (pipe-separated):

```
/api/v2/monitor/switch-controller/managed-switch/status?format=connecting_from|fgt_peer_intf_name|join_time|os_version|serial|switch-id|state|status
```

**Do not use `?fields=`** — that is the CMDB filter syntax and does not work on monitor endpoints.

### FortiSwitch fields (managed-switch/status)

| API field | Meaning | Maps to |
|-----------|---------|---------|
| `switch-id` | Switch hostname | `hostname` |
| `serial` | Serial number | `serialNumber` |
| `connecting_from` | Management IP of the switch | `ipAddress` |
| `fgt_peer_intf_name` | FortiGate interface/FortiLink the switch is on | `learnedLocation` |
| `os_version` | Firmware version | `osVersion` |
| `join_time` | Unix timestamp when switch was first authorized | `acquiredAt` (only update if older) |
| `state` | `Authorized` / `Unauthorized` | `status: storage` if Unauthorized |
| `status` | `Connected` / `Disconnected` | informational |

When a discovered value conflicts with an existing manual reservation, a `Conflict` record is created instead of silently overwriting. Admins accept (apply discovered values) or reject (keep existing) via the conflict slide-over panel on the Events page.

### Stale-subnet deprecation (Phase 2)

After all per-device polling finishes, `syncDhcpSubnets` deprecates subnets whose `fortigateDevice` is no longer in `DiscoveryResult.knownDeviceNames` — the full roster of FortiGates configured in FortiManager, captured up front from `/dvmdb/adom/<adom>/device` with **no `conn_status` filter**. An offline FortiGate stays in `knownDeviceNames` and its subnets are left alone; only devices that have been *removed* from FMG are treated as stale. Devices filtered out by `deviceInclude`/`deviceExclude` also remain in the roster for the same reason — changing a filter shouldn't nuke previously-discovered subnets. Phase 2 is skipped entirely if the run was aborted.

### Auto-Monitor Interfaces apply pass (Phase 2c)

After Phase 2 + 2b finish, `syncDhcpSubnets` runs `applyAutoMonitorForClass` from `autoMonitorInterfacesService.ts` for each per-class block (`fortigate` / `fortiswitch` / `fortiap`) whose `Integration.config.<klass>Monitor.autoMonitorInterfaces` is non-null. Resolves the selection (names / wildcard / type) against each discovered asset's latest `AssetInterfaceSample` rows and unions the result into `Asset.monitoredInterfaces` — strictly additive, never strips operator pins. Idempotent: skips the per-asset write when nothing would change. Runs on `mode in {"full", "finalize"}`, so both standalone-FortiGate runs and FMG finalize hit it; per-device FMG syncs (`mode: "skip-deprecation"`) do not. Writes one `integration.auto_monitor_interfaces.applied` Event per class when something actually changed; silent otherwise. First-run edge case: when `onlyUp` is set but no system-info pass has run yet, the resolver finds no candidates and the apply pass quietly no-ops; the next discovery cycle catches up. The same logic is exposed via `POST /integrations/:id/interface-aggregate/apply` and is invoked by the integration edit modal's **Save Changes** button so saving immediately applies the selection to existing assets.

Discovery can be triggered manually or runs automatically on each integration's `pollInterval` via `discoveryScheduler.ts`.

---

## FortiGate Discovery Workflow (Standalone)

`fortigateService.ts` talks directly to a single standalone FortiGate (one not managed by FortiManager) via the FortiOS REST API. It consumes the same `DiscoveryResult` shape as `fortimanagerService` — the sync pipeline in `integrations.ts` handles both identically.

Scope is the same as FMG (DHCP scopes + reservations + leases, interface IPs, VIPs, managed FortiSwitches, managed FortiAPs, device inventory). Key differences from the FMG path:

- **Endpoint style** — requests go straight to `/api/v2/cmdb/...` and `/api/v2/monitor/...` on the FortiGate, no JSON-RPC wrapper
- **Scoping** — `vdom` query param (default `root`) instead of FMG `adom`
- **Device identity** — the FortiGate itself is the single entry in `result.devices`; its hostname is resolved from `/api/v2/monitor/system/status`
- **Auth** — Bearer API token from System > Administrators > REST API Admin (optional `access_user` header for parity with FMG; FortiOS ignores it)

---

## Entra ID / Intune Discovery Workflow

`entraIdService.ts` queries Microsoft Graph via OAuth2 client-credentials flow to sync registered devices as assets. **Produces assets only** — no subnets, reservations, or VIPs — so it uses a dedicated `syncEntraDevices` path in `integrations.ts` rather than the shared `syncDhcpSubnets` pipeline.

- **Auth** — `POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` with `grant_type=client_credentials`, scope `https://graph.microsoft.com/.default`. Tokens are cached in-memory by `tenantId:clientId` until expiry.
- **Endpoints** —
  - Always: `GET /v1.0/devices` (paged via `@odata.nextLink`, `$top=999`, hard cap 10,000). Requires `Device.Read.All` (application permission, admin consent).
  - When `enableIntune=true`: `GET /v1.0/deviceManagement/managedDevices`. Requires `DeviceManagementManagedDevices.Read.All`. Merged onto Entra devices via `azureADDeviceId ↔ deviceId`; Intune data wins on any shared field.
- **Device identity** — the Entra `deviceId` (GUID) is the stable key. Persisted as the `externalId` on per-source `AssetSource` rows (`sourceKind="entra"`/`"intune"`). Phase 4d retired the legacy `Asset.assetTag = entra:{deviceId}` mirror — re-discovery and search both query AssetSource directly. Existing assetTag values on rows discovered before Phase 4d are preserved (back-compat); new Entra-discovered assets have `assetTag = null`.
- **Multi-source asset model (Phase 2 cutover)** **and the projection layer** (Phase 3b.1 cutover) — the Entra/Intune sync is on the new `AssetSource` model. Each Graph endpoint that contributed to a discovered device produces its own row: `sourceKind="entra"` for the `/v1.0/devices` view (trustType, accountEnabled, SID, registration/sign-in timestamps, compliance flags, original entra `displayName`) and `sourceKind="intune"` for the `/v1.0/deviceManagement/managedDevices` view (serial, manufacturer, model, Ethernet+WiFi MACs, `userPrincipalName`, `chassisType`, `complianceState`, `lastSyncDateTime`, original intune `deviceName`). Both rows share the same `externalId = deviceId.toLowerCase()` but different `sourceKind`s. Hybrid devices have both rows; Entra-only and Intune-only devices have just one. **Discovery-owned Asset fields** (hostname, os, osVersion, learnedLocation, serialNumber, manufacturer, model) come from `projectAssetFromSources()` — every update path (primary existing-asset, SID-takeover, duplicate-Entra-registration "incoming wins" auto-resolve) upserts the entra/intune sources first, re-fetches all sources for the asset (which may include AD on hybrid devices so the projection's AD-FQDN-first hostname rule kicks in), computes projection, and writes a single Asset.update with projected + non-projected fields. The create path projects from a synthetic source array built directly from the new device's observed blobs (entra/intune as appropriate per `dev.sources`) — pure, no DB roundtrip needed for new assets. After upsert, `upsertEntraIntuneSources` **sweeps stale entra/intune rows on the same Asset whose externalId differs from this device's deviceId** — covers the duplicate-Entra-registration "incoming wins" auto-resolve path so the prior identity doesn't orphan-link a future discovery to the wrong asset. The `entraIdService` `DiscoveredEntraDevice` shape carries a `sources: ("entra"|"intune")[]` field plus original `entraDisplayName` / `intuneDeviceName` so the sync can split the merged record back into source-shaped blobs without lossy heuristics.
- **Re-discovery** — Assets are matched in this order: (1) any `AssetSource` row of `sourceKind in ("entra","intune")` with matching `externalId = deviceId.toLowerCase()`, (2) on-prem SID match — resolves through `entra.observed.onPremisesSecurityIdentifier` or `ad.observed.objectSid` (hybrid-joined devices the AD integration already created — Entra **takes over** in that case, signaled by the SID-matched asset having no entra/intune source yet), (3) hostname collision against an untagged asset → a `Conflict` (entityType `"asset"`, deduped on `proposedDeviceId`) is created for admin/assetsadmin review. "Untagged" under the new model means **the asset has no entra/intune source AND no AD source**. The slide-over panel renders a side-by-side comparison; **Accept** adopts the existing asset (writes the Entra assetTag + fills empty fields from the snapshot), **Reject** creates a separate asset with the Entra tag so future runs find it by tag.
- **Asset type** — inferred from Intune `chassisType` (`desktop/laptop/convertible/detachable` → `workstation`; `tablet/phone` → `other`); Entra-only devices default to `workstation`. Admins can recategorize via the asset edit UI; re-discovery only overwrites `assetType` if it is still `other`.
- **User** — Intune `userPrincipalName` → `Asset.assignedTo`. Entra-only runs do not populate this field.
- **MACs** — Intune supplies both `wiFiMacAddress` and `ethernetMacAddress` per managed device. Both are stored as separate entries in `Asset.macAddresses[]` with sources `"intune-wifi"` and `"intune-ethernet"`, and the asset's primary `macAddress` column is set to whichever was most recently updated (Ethernet preferred when both are reported on the same sync, since modern Windows / iOS / Android randomize the WiFi MAC per network and the Ethernet MAC is the more stable identity). The asset details panel renders both in the "All MACs" list with pretty source labels ("Intune — Ethernet" / "Intune — Wi-Fi"). The `mac-collision` conflict pathway only matches against the **Ethernet MAC** for the same randomization reason; WiFi MAC is informational and used by FortiGate DHCP-discovery's MAC-based asset matching to broaden the chance of an incoming DHCP lease landing on the right asset row.
- **Disabled devices** — `accountEnabled` is fetched for every Entra device. When `includeDisabled=true` (default), disabled devices are synced as `decommissioned` assets and get an `entra-disabled` tag. When `includeDisabled=false`, they are skipped entirely — matching the AD integration's `includeDisabled` behavior.
- **Filters** — `deviceInclude` / `deviceExclude` arrays match against `displayName` with wildcard support (`LAPTOP-*`, `*-lab`).

---

## Active Directory Discovery Workflow (On-premise)

`activeDirectoryService.ts` queries an on-premise domain controller via LDAP simple bind (over LDAP or LDAPS) and syncs computer objects as assets. **Produces assets only** — no subnets, reservations, or VIPs — so it uses a dedicated `syncActiveDirectoryDevices` path in `integrations.ts`.

- **Library** — `ldapts` (Promise-based LDAP client; TypeScript types bundled).
- **Auth** — simple bind using `bindDn` (full DN of a read-only domain user) and `bindPassword`. No Kerberos/GSSAPI. Default port 636 (LDAPS) or 389 (plain LDAP).
- **Query** — paged subtree search under `baseDn` with filter `(&(objectCategory=computer)(objectClass=computer))`, page size 1000, hard cap 10,000. Search scope `sub` (default) or `one`.
- **Device identity** — AD `objectGUID` (decoded as lowercase hex). Persisted on `Asset.assetTag` as `ad:{guid}` when the AD integration creates the asset.
- **Disabled accounts** — `userAccountControl & 0x2` (ACCOUNTDISABLE). When `includeDisabled=true` (default), these still sync but are created/updated with `status = decommissioned` and get an `ad-disabled` tag. When `includeDisabled=false`, they're skipped.
- **Attribute mapping** — `dNSHostName` (fall back to `cn`) → `hostname`+`dnsName`; `operatingSystem` → `os`; `operatingSystemVersion` → `osVersion`; `description` → `notes` (only if empty); `whenCreated` → `acquiredAt` (only if older); `lastLogonTimestamp` (Windows FILETIME) → `lastSeen` **only if newer than the existing value** — never regresses fresher data from Entra/Intune; `distinguishedName` OU path → `learnedLocation`; `operatingSystem` fed through `inferAssetTypeFromOs()` → `assetType` (only if still `other`).
- **Note on `lastLogonTimestamp`** — this attribute replicates approximately every 14 days by design. Use it as a coarse "last seen" signal; it will lag reality.
- **Filters** — `ouInclude` / `ouExclude` arrays match against the computer's full `distinguishedName` with wildcard support (e.g. `*OU=Workstations*`, `*OU=Servers,OU=HQ*`).
- **Monitor default for realm-monitorable hosts** — Computer objects whose `operatingSystem` contains "windows" or "linux" are stamped with `discoveredByIntegrationId` and `monitorType = "activedirectory"` *on first sight* (Windows assumes WinRM; Linux assumes a realm-joined host with SSH). The Asset Monitoring tab renders this as the default option in the type dropdown; probes on the default reuse the integration's `bindDn`/`bindPassword` — WinRM SOAP Identify against `https://<host>:5986` for Windows, SSH connect+auth on port 22 for Linux. No separate Credential row is needed for the default. The protocol is chosen at probe time from `Asset.os` via `getAdMonitorProtocol(os)` (exported from `monitoringService`), so the AD sync and the probe agree on default policy. **The bind DN must be in UPN form (`user@domain.com`) or down-level form (`DOMAIN\user`)** so WinRM/realmd accept it; raw LDAP DN form (`CN=svc,OU=...`) authenticates against LDAP bind but fails the probe. Operators can override `monitorType` on any AD-discovered host — subsequent re-syncs preserve the override (and the linked `monitorCredentialId`). Other OSes (BSD, macOS, ESXi) get no AD default — operators select ICMP/SNMP/SSH manually. Mirrors the FMG/FortiGate firewall default-and-override pattern.

### Hybrid-join cross-link (AD ↔ Entra ID)

Active Directory and Entra ID identify the same hybrid-joined device with two unrelated GUIDs (AD `objectGUID` vs Entra `deviceId`). The reliable cross-link is the on-prem **SID** — AD's `objectSid` equals Entra's `onPremisesSecurityIdentifier`.

- **AD discovery is on the multi-source asset model** (Phase 2 cutover) **and the projection layer** (Phase 3b.1 cutover): the AD sync writes an `AssetSource` row with `sourceKind="ad"`, `externalId=<objectGUID>`, and a rich source-shaped `observed` blob containing the raw LDAP fields (objectSid, cn, dnsHostName, distinguishedName, ouPath, OS+version, description, whenCreated, lastLogonTimestamp, accountDisabled). Lookups for re-discovery (GUID match), hybrid-cross-link (SID match), and hostname-collision detection all read from `AssetSource` (joining Entra rows for SID matches via `observed.onPremisesSecurityIdentifier`). The legacy `assetTag = "ad:{guid}"` and `tags = ["ad-guid:{guid}", "sid:{SID}", ...]` markers are still written for back-compat with the rest of the codebase; they're retired in Phase 4. **Discovery-owned Asset fields** (hostname, os, osVersion, learnedLocation, serialNumber, manufacturer, model) come from `projectAssetFromSources()` instead of inline merge logic — for the existing-asset path the AD source is upserted first, then all of the asset's sources are re-fetched and projected; for the create path the AD source's observed blob is projected synthetically (single-source array, no DB roundtrip needed). Operator-owned fields (status, lastSeen, acquiredAt, assetType, notes, tags, monitor stamps, dnsName) keep their inline logic — projection only owns what discovery owns. Single Asset write per device per cycle.
- Both services still stamp `sid:{SID}` (uppercase) in the asset's `tags` array.
- AD additionally stamps `ad-guid:{guid}` (lowercase hex) in `tags` so the AD GUID stays findable even after Entra takes over the primary `assetTag`.
- **Priority rule:** when both sources have the same device, Entra "takes over" the existing Asset row by upserting its own AssetSource entra/intune row keyed on `deviceId`. If AD created the asset first, the next Entra run finds it via the SID cross-link (entra.observed.onPremisesSecurityIdentifier ↔ ad.observed.objectSid) and stamps the entra source row alongside the existing ad source row — both AssetSource rows now live on the same Asset. If Entra created it first, the next AD run finds it via SID and stamps the ad source row in the same way. Phase 4d retired the assetTag mirror; AssetSource.externalId is the only canonical lookup key going forward.
- **MAC cross-link (Entra-only, tertiary).** When the Entra deviceId lookup misses AND the SID lookup misses (or the device has no SID — e.g. cloud-only Azure AD joined with no on-prem identity), the Entra sync falls through to a third match: incoming **Ethernet MAC** against `Asset.macAddress` and `Asset.macAddresses[]` history (any entry, any source). MAC matches are treated as positive identity confirmation — same physical box, just got a new Entra deviceId (re-enroll, re-image, NIC swap into a previously-known device) — and silently take over the matched asset the same way SID does. WiFi MAC is *not* used for this cascade because it randomizes per-network on modern Windows / iOS / Android. Every silent take-over writes one info-level `syncLog` event (`MAC cross-link: ...`) so the merge is auditable. This pathway replaced the noisy `mac-collision` conflict flavour, which was raising operator-review queues that almost always resolved as "yes, same device."
- **Integration filter** — `assetMatchesIntegrationFilter` for AD prefers the AD AssetSource's `observed.ouPath` over the merged `Asset.learnedLocation`. Source-side data is authoritative because the merged `learnedLocation` field can drift between integrations (a FortiGate sighting can overwrite AD's OU path), but the AD source's own observation is fixed by what LDAP returned at the last AD sync. Falls back to `learnedLocation` for callers that haven't loaded sources yet (back-compat).
- **Conflict records** — the asset-conflict schema now carries `proposedAssetFields.assetTagPrefix` (`"ad:"` or `"entra:"`) so the accept/reject route applies the correct tag. Entra-only conflicts predating this field still default to the Entra prefix for backward compatibility.

---

## Background Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `expireReservations` | Every 15 min | Mark reservations past `expiresAt` as `expired` |
| `discoveryScheduler` | Per-integration `pollInterval` | Auto-trigger FMG / FortiGate / Windows Server / Entra ID / Active Directory discovery |
| `ouiRefresh` | Periodic | Refresh IEEE OUI database for MAC vendor lookup |
| `pruneEvents` | Nightly | Delete Event records older than 7 days |
| `updateCheck` | Periodic | Check for software updates |
| `clampAssetAcquiredAt` | Once at startup | Clamp `acquiredAt` down to `lastSeen` on any Asset row where the invariant was violated |
| `normalizeManufacturers` | Once at startup | Idempotent: seed default manufacturer aliases on a fresh install, load the in-memory cache used by the Prisma extension in `src/db.ts`, and rewrite any existing `Asset.manufacturer` / `MibFile.manufacturer` values that the alias map canonicalizes to something different. Mutations to the alias map at runtime (`POST/PUT /manufacturer-aliases`) re-run `applyAliasesToExistingRows()` in the background so admin edits propagate to historical data without a restart. |
| `migrateMonitorTransport` | Once at startup | Idempotent back-fill of `Integration.config.monitorResponseTimeSource = "snmp"` for any FMG/FortiGate integration that has `monitorCredentialId` set but no explicit `monitorResponseTimeSource` toggle yet. Preserves the legacy implicit-SNMP-probe behaviour after upgrading to the explicit per-stream transport toggles. |
| `backfillAssetSources` | Once at startup | Idempotent. Phase 1 of the multi-source asset model. Walks every Asset row and upserts `AssetSource` rows derived from the legacy `assetTag` / `sid:` / `ad-guid:` tag conventions (entra → "entra:" assetTag; ad → "ad:" assetTag; fortigate firewall → "fgt:" assetTag) **plus a Fortinet-infrastructure fallback** keyed on `manufacturer="Fortinet" + non-empty serialNumber + assetType` — `firewall`/`switch`/`access_point` map to `fortigate-firewall`/`fortiswitch`/`fortiap` respectively. Catches pre-tag firewalls and the un-tagged switch/AP fleet in one pass. ad-guid breadcrumbs become `inferred=true` AD recovery rows; everything else falls through to a single "manual" row keyed on Asset.id. Pairs with the shadow-write Prisma extension in `src/db.ts` which keeps the table fresh between restarts whenever an asset's `assetTag`, `tags`, or `discoveredByIntegrationId` change. Phase 2 cuts discovery over progressively — Active Directory, Entra/Intune, FortiGate-firewall, FortiSwitch, and FortiAP are shipped; DHCP-discovered endpoints stay on the legacy path until a later phase. |
| `resolveStaleReservationConflicts` | Once at startup | Idempotent cleanup. Auto-rejects pending reservation Conflict rows whose stored proposed values now match the live Reservation values on every field listed in `conflictFields` — i.e. conflicts that were raised by an old discovery run but where the values have since come back into sync. Pairs with the inline fix in `upsertConflict` that prevents new lingering conflicts going forward. |
| `scrubLegacySidGuidTags` | Once at startup | Idempotent. Phase 4b cleanup of the multi-source asset model: strips legacy `sid:<SID>` and `ad-guid:<GUID>` entries from `Asset.tags`. Both signals now live on AssetSource and the tag mirroring is redundant. Pairs with discovery-side cuts in `syncEntraDevices` / `syncActiveDirectoryDevices` that stop writing the markers going forward. Leaves `Asset.assetTag` (entra:/ad:/fgt:) and `prev-*` breadcrumb tags untouched — those need parallel migration of searchService + conflict resolution before retirement. |
| `decommissionStaleAssets` | Every 24 hours | Move assets whose `lastSeen` is older than the configured inactivity threshold (months) to `decommissioned` status. Configured via Events → Settings → Assets tab; 0 disables. |
| `flagStaleReservations` | Every 6 hours (and 30 s after startup) | Scans active `dhcp_reservation` rows for ones whose target client hasn't been seen actively holding the IP within the configured threshold (`reservation.staleAfterDays`, default 60, 0 disables). For each fresh transition into "stale," writes one `reservation.stale` Event at warning level and stamps `staleNotifiedAt` so the alert doesn't refire. The discovery sync clears `staleNotifiedAt` (and `staleSnoozedUntil`) when the IP is seen active again, so a reservation that comes back online and goes silent later re-arms cleanly. Cold-start safety: a `reservationStaleDetectionStartedAt` Setting is stamped on first run and used as a per-row baseline floor (`max(createdAt, detectionStartedAt)`) so the first scan after migration doesn't flood every existing dhcp_reservation row before discovery has had time to populate `lastSeenLeased`. Rows with `staleIgnored=true` are excluded permanently until an admin un-ignores. |
| `discoverySlowCheck` | Every 30 s | Compares each in-flight discovery's elapsed time to its rolling-duration baseline (`discoveryDurationService`). Emits one `integration.discover.slow` event per run (and one per FortiGate inside an FMG run) when elapsed exceeds `max(avg + 2σ, avg × 1.5, avg + 60 s)`; baseline requires ≥3 prior successful runs. The `/integrations/discoveries` endpoint also calls the same checker inline so the sidebar and Integrations page flip amber within one 4 s poll cycle. |
| `capacityWatch` | Every 10 minutes (and 60 s after startup) | Builds a capacity snapshot via `getCapacitySnapshot` and calls `recordCapacityTransition` so a flip into watch/amber/red writes one `capacity.severity_changed` Event independent of whether anyone has the Maintenance tab open. The route handler in `serverSettings.ts` also calls `recordCapacityTransition` on every `/pg-tuning` fetch so the audit trail lands in real time when an admin is actively viewing — the periodic job is the out-of-band safety net for "the DB is moments from dying and the UI is about to be unreachable." Best-effort: failures are logged at debug and never thrown. The first run on each fresh install also stamps the baseline `capacity.lastSeverity` Setting. |
| `monitorAssets` | Light loop every 5 s, heavy loop every 30 s (independent `running` guards) | Handles four independent cadences per monitored asset: **(1) response-time probe** when `lastMonitorAt + (Asset.monitorIntervalSec ?? monitor.intervalSeconds)` has elapsed (FortiOS REST, SNMP `sysUpTime`, WinRM SOAP Identify, SSH connect+auth, ICMP ping). The `activedirectory` monitor type dispatches to WinRM for Windows or SSH for realm-joined Linux, both reusing the AD integration's bind credentials. Writes one `AssetMonitorSample` per probe (`responseTimeMs` null = packet loss), updates `Asset.monitorStatus` / `lastResponseTimeMs` / `consecutiveFailures`, and emits one `monitor.status_changed` Event on `up ↔ down` transitions (threshold is `monitor.failureThreshold`). **(2) Telemetry pull** when `lastTelemetryAt + (telemetryIntervalSec ?? monitor.telemetryIntervalSeconds)` has elapsed — CPU% + memory snapshot via FortiOS `/api/v2/monitor/system/resource/usage` or SNMP. The SNMP path consults `vendorTelemetryProfiles` for the asset's `manufacturer + os` and queries vendor-specific OIDs first when the profile resolves through `oidRegistry` (i.e. the relevant MIB has been uploaded to Server Settings → Identification → MIB Database). Built-in profiles cover Cisco IOS/IOS-XE/NX-OS (`cpmCPUTotal5secRev`, `ciscoMemoryPoolUsed`+`ciscoMemoryPoolFree`), Juniper Junos (`jnxOperatingCPU`, `jnxOperatingBuffer` %), Mikrotik (`mtxrSystemUserCPULoad`), Fortinet SNMP path (`fgSysCpuUsage`, `fgSysMemUsage`), HP/Aruba ProCurve (`hpSwitchCpuStat`), and Dell (`rlCpuUtilDuringLastMinute`). When a vendor query yields nothing — no profile match, MIB not uploaded, or the device doesn't expose the OID — each metric independently falls back to standard HOST-RESOURCES-MIB (`hrProcessorLoad`, `hrStorageRam`). Also collects temperatures from FortiOS `/api/v2/monitor/system/sensor-info` (filtered to type=temperature) and SNMP ENTITY-SENSOR-MIB (entPhySensorType=8/celsius). Writes one `AssetTelemetrySample` plus N `AssetTemperatureSample` rows. **(3) System info pull** when `lastSystemInfoAt + (systemInfoIntervalSec ?? monitor.systemInfoIntervalSeconds)` has elapsed — interfaces (FortiOS `/monitor/system/interface` + CMDB merge for `alias`/`description`, or SNMP IF-MIB including `ifAlias` for the operator-set label; both paths capture ifInErrors/ifOutErrors and FortiOS errors_in/out) + storage (SNMP HOST-RESOURCES-MIB only) + IPsec tunnels (FortiOS `/monitor/vpn/ipsec` plus a parallel `/cmdb/vpn.ipsec/phase1-interface` lookup that resolves each tunnel's `parentInterface` — the FortiOS CLI `set interface` value used by the System tab to nest tunnel rows under their parent in the Interfaces table; phase-2 selectors are rolled up to a single up/down/partial state per phase-1 with summed byte counters; ADVPN dynamic shortcuts are filtered out by their `parent` field) + LLDP neighbors (FortiOS `/monitor/system/interface/lldp-neighbors` for fortinet probes, SNMP LLDP-MIB walk for SNMP probes — `lldpRemTable` joined to `lldpLocPortTable` for the localPortNum→ifName mapping plus `lldpRemManAddrTable` for management IPs). Writes N `AssetInterfaceSample` rows + M `AssetStorageSample` rows + K `AssetIpsecTunnelSample` rows + L `AssetLldpNeighbor` rows (replaced in full per asset on each successful pass — neighbors that aren't in the latest scrape are deleted in the same transaction; matchedAssetId is resolved at persist time by joining management IP / chassis MAC / system name against the asset inventory); also mirrors per-interface IP+MAC into `Asset.associatedIps` (preserving manual entries). **(4) Fast filtered scrape** rides the response-time cadence when the asset has any `monitoredInterfaces`, `monitoredStorage`, or `monitoredIpsecTunnels` pinned (and the full systemInfo pass didn't already run this tick). Calls `collectFastFiltered` which performs one collector round-trip — interfaces + storage on SNMP, interfaces + (conditionally) IPsec on FortiOS — and only writes sample rows for the pinned subset. Storage and IPsec rows ride the same monitorInterval setting (default 60s) so the operator gets sub-minute disk-usage and tunnel-state history for chosen mountpoints / tunnels without re-walking the full tables. ICMP/SSH cannot deliver telemetry/system-info; WinRM/AD return supported=false until WMI Enumerate-over-WS-Management lands. **Worker scheduling**: cadences are split across two independent ticking loops. The **light loop** (probe + fastFiltered) ticks every 5 s with concurrency `cpus().length * 2` (clamped 8..64, env-overridable via `POLARIS_PROBE_CONCURRENCY`); the **heavy loop** (telemetry + systemInfo) ticks every 30 s with concurrency `cpus().length` (clamped 4..32, env-overridable via `POLARIS_HEAVY_CONCURRENCY`). Each loop has its own `running` guard, so a 75-second wedged systemInfo on a dead host blocks ONLY the next heavy tick — the light loop keeps firing on its own clock and probes stay close to their configured cadence regardless. Within a pass, workers don't reserve assets; they just pull the next item from the cadence queue. `runMonitorPass({cadences})` selects which cadences a given call owns; the default (no `cadences` arg) covers all four for legacy callers like `POST /assets/:id/probe-now`. **Down-asset suppression**: while `Asset.monitorStatus="down"` (i.e. probe failures past `monitor.failureThreshold`), the heavy cadences (telemetry / systemInfo / fastFiltered) are suppressed entirely; only the response-time probe runs. Assets routinely stay offline for weeks/months and doing full SNMP walks against each on every pass burns worker time on a host that's just going to time out. Recovery is automatic: the moment one probe succeeds the status flips back to "up" and the next pass picks up the heavy cadences again. **Probe-cadence backoff for confirmed-down hosts** (`probeIntervalWithBackoff` in monitoringService): once an asset is `down`, the probe interval is bucketed by `consecutiveFailures` — `≤10`: max(base, 5 min), `≤30`: max(base, 15 min), `>30`: max(base, 30 min). `max(base, ...)` ensures operators with deliberately long base intervals don't get probes accelerated by backoff. The first successful probe resets `consecutiveFailures` to 0 and the asset returns to its base cadence; recovery is detected within at most the current bucket's window (worst case 30 min for a chronically-decommissioned host nobody marked decommissioned). Saves probe budget on dead hosts without hiding recoveries for unreasonable durations. `lastSystemInfoAt` doesn't advance during the outage (only bumps when a scrape returned data), so systemInfo is due immediately on recovery and the System tab refreshes naturally. The same "only on data" rule also stops a transport failure from silently emptying the System tab Interfaces table — the GET endpoint anchors interface display to `lastSystemInfoAt`, and bumping it without inserting any rows would point the query at a moment with zero samples. Once a day the job prunes the sample tables (`monitor.sampleRetentionDays` for monitor, `telemetryRetentionDays` for telemetry **and temperatures**, `systemInfoRetentionDays` for interface + storage + IPsec tunnels **and LLDP neighbors** — LLDP rides system-info retention because it's collected on the same cadence; the per-scrape full-replace already drops gone-away neighbors so the prune mostly catches rows for assets that have stopped scraping entirely). |

---

## Business Rules & Constraints

1. **No overlapping subnets** within the same block. Use `cidrContains()` / `cidrOverlaps()` from `src/utils/cidr.ts` before any subnet creation.
2. **Subnet must be contained within its parent block** — enforced at service layer.
3. **No duplicate IP reservations** — one `active` reservation per IP per subnet (`@@unique([subnetId, ipAddress, status])`).
4. **Block/subnet deletion protection** — HTTP 409 if any `active` reservations exist.
5. **CIDR normalization** — Host bits zeroed on write (e.g., `10.1.1.5/24` → `10.1.1.0/24`).
6. **sourceType tracking** — All discovered reservations carry a `sourceType`; manual entries default to `manual`.
7. **Conflict detection** — Discovery values differing from an existing manual reservation create a `Conflict` record rather than overwriting.
8. **Event archival** — Events older than 7 days are pruned; syslog (CEF) and SFTP/SCP archival are configurable.
9. **Asset `acquiredAt` ≤ `lastSeen`** — Enforced on every write via `clampAcquiredToLastSeen` in `src/utils/assetInvariants.ts`. If a write would leave `acquiredAt` later than `lastSeen`, `acquiredAt` is clamped down to match. Existing rows are repaired by the `clampAssetAcquiredAt` startup job.

---

## Frontend

Vanilla JavaScript SPA served from `/public/`. No build step — plain ES modules.

- Multi-page layout with client-side navigation (`app.js`)
- Light/dark theme toggle
- Real-time discovery progress polling (`integrations.js`)
- Bulk operations (delete, release)
- PDF and CSV asset export
- Conflict resolution slide-over panel (Events page)
- First-run setup wizard (`setup.html`) backed by `src/setup/`
- Asset list shows a Monitor pill column (Monitored / Pending / Down / Unmonitored). The bulk-action toolbar opens a Monitoring modal that applies one type + credential to every selected row. The Acquired date is intentionally omitted from the list — it lives only on the asset details slide-in (General tab) to keep the row narrow.
- Each asset row's Actions cell renders a **View Lease** button when the asset has an `ipAddress` and the row's `ipContext` resolves a non-deprecated containing subnet. Clicking it navigates to `/subnets.html#ip=<subnetId>@<ipAddress>`, where the network slide-over opens with the asset's IP scrolled into view and visually highlighted; reserve / release / edit happens in that panel directly. The Networks slide-over is also where the **View Asset** button (per-IP, on rows where the IP resolves to a Polaris asset) lives — clicking it navigates to `/assets.html#view=asset:<id>` so the asset details slide-in opens on the assets page.
- Asset edit modal is tab-based (General + Monitoring). The details modal has three tabs by default (General + System + **Sources**) and adds a fourth **SNMP Walk** tab for admins (admin-only on both the frontend and the backend) — a Base OID input (default `1.3.6.1.2.1.1`), an SNMP credential picker (any stored SNMP credential, not just the asset's monitor credential), a Max-rows input (default 500, capped at 5,000), and a Walk button that posts to `POST /assets/:id/snmp-walk` and renders the returned varbinds in a scrollable OID/Type/Value table with a "Copy results" button. Each walk is audited as an `asset.snmp_walk` Event. The Monitoring tab on the edit modal renders an editable type dropdown for every asset; integration-discovered assets (FMG/FortiGate-discovered firewalls and AD-discovered Windows/Linux hosts) get an extra option representing the integration default (e.g. "FortiManager: \<name\> (default)") plus a hint pointing operators to SNMP for small-branch FortiGates whose REST sensor endpoint 404s. The **System** details tab leads with the monitoring section — status pill, source, last RTT/poll/consecutive failures, and an SVG response-time chart (24h / 7d / 30d / Custom) plus a "Refresh" button for user-or-above (kicks off all three streams — response-time probe, telemetry, system-info — and the toast names exactly which streams refreshed and which failed, e.g. `Refresh partial (probe 12 ms · telemetry) — interfaces: FortiManager direct-mode API token not configured`) — then a horizontal divider, then a single combined CPU+Memory chart (both lines on a shared 0–100% y-axis with one hover tooltip naming both values) over 1h / 24h / 7d / 30d, a Temperatures section (current sensor table — hidden when the device exposes no sensors — with each sensor name clickable to open a per-sensor slide-over chart), an Interfaces table with a "Poll 1m" checkbox column + clickable interface name + cumulative errors column + LLDP **Neighbor** column (rightmost; shows the first neighbor's `systemName` plus its remote `portId` as `<sysName> / <portId>` — the system name links to that asset's view modal when the neighbor matched a Polaris asset; a `+N` badge appears when the local port saw multiple neighbors and the slide-over enumerates all of them) (FortiOS-monitored phase-1 IPsec tunnels are nested under their parent interface as child rows here — orange "IPsec" badge, status pill, remote gateway in the IP column, cumulative in/out bytes; tunnels whose `parentInterface` lookup fails fall into a final "IPsec Tunnels (unbound)" group at the bottom of the same table), and a Storage table (Poll 1m checkbox, mount, used, total, %); empty-state messages render for unmonitored assets, ICMP/SSH-monitored assets, and WinRM/AD-monitored assets (the last is a placeholder until WMI Enumerate-over-WS-Management lands). The Interface column shows the operator-set **alias** as the primary label when present (FortiOS CMDB `alias` / SNMP `ifAlias`), with the real `ifName` rendered as a small subtitle and as the cell tooltip so the operator can still correlate to switch port labels. The Poll 1m checkboxes — interface, storage, and nested tunnel — write to `Asset.monitoredInterfaces` / `monitoredStorage` / `monitoredIpsecTunnels` respectively and pin the row for sub-minute polling on the response-time cadence. Clicking an interface name opens a **nested slide-over** whose header reads `<alias> (<ifName>)` when an alias is set, followed by an **Interface Comments** editor — a 255-char textarea + Save/Revert buttons (assets admin and admin only; everyone else gets a disabled box). Save writes to `AssetInterfaceOverride.description` via `PUT /assets/:id/interfaces/:ifName/comment` and is **Polaris-local only — never pushed to the device**. When no override is set, the device-reported FortiOS CMDB `description` is shown as the textarea placeholder ("Device says: …") so operators can see what's currently surfaced before deciding to type over it. Saving an empty box clears the override and the discovered description shows through again. Auto-refresh ticks don't clobber in-progress edits — the editor tracks a dirty flag and skips repopulation while the user is typing. Below the comment editor the body renders an **LLDP Neighbor card** (one card per neighbor on this interface; shows system name as a clickable link when matched to a Polaris asset, plus chassis ID + management IP + capabilities + system description; an "unmatched" badge when no Polaris asset resolved by mgmt IP / chassis MAC / hostname) followed by **two charts**: one combined Throughput chart (input + output on a shared bps axis, single tooltip naming both) and an in/out errors-per-interval chart. Clicking a mountpoint name opens a slide-over with a Used vs Total bytes chart and a Used % chart (1h / 24h / 7d / 30d); clicking a tunnel name opens a similar nested slide-over with a status timeline (24h / 7d / 30d) and per-interval throughput charts; clicking a sensor name opens a per-sensor temperature slide-over (24h / 7d / 30d) with axis labels and a chart title. Closing only that panel returns to the asset details panel underneath. All charts share `_wireChartTooltip` for hover behaviour.
- The **Sources** tab on the asset details modal renders one card per `AssetSource` row attached to this asset, in stable presentation order (`entra` → `intune` → `ad` → `fortigate-firewall` → `fortiswitch` → `fortiap` → `manual`). Each card shows the source's friendly label (e.g. "Microsoft Entra ID"), the originating integration as a badge, an **Inferred** badge for phase-1-backfilled rows that haven't been replaced by real discovery yet, the `syncedAt` / `firstSeen` / `lastSeen` timestamps + the source's natural `externalId` as a metadata strip, and the source's `observed` blob rendered as a humanized key-value table (camelCase keys → "Title Case", ISO timestamps → human dates, booleans → Yes/No, complex values → JSON). Loaded once per modal open via `GET /assets/:id/sources`; failures fall through to an empty-state message so the rest of the modal still works. This is the operator-visible payoff of the Phase 1+2 multi-source foundation — see what each integration independently said about the device, side-by-side. **Admins** see a **Split** button per card (hidden when the asset only has one source, and on `manual` source rows): clicking detaches the chosen source onto a freshly-created Asset via `POST /assets/:id/sources/:sourceId/split`, after a confirm dialog. The current modal closes and the new asset's view modal opens so the operator can verify the move.
- Asset list status-column filter includes **Quarantined**. Per-row Actions cell shows a **Quarantine** button (deep-red) for assets-admin+ on assets that have at least one MAC on record; quarantined assets get a **Release Quarantine** button instead. Bulk bar has matching **Quarantine** / **Release Quarantine** buttons that appear only when the selection mix makes them relevant. Asset details panel adds a **Quarantine** tab for assets-admin+ (shown whenever the asset has MACs or is quarantined): displays quarantine status, per-FortiGate push targets table (FortiGate name, status badge, pushed MACs, pushed-at timestamp), DHCP sightings history, and Quarantine / Release / Verify Push action buttons.
- Server Settings → **Credentials** tab manages the stored SNMP / WinRM / SSH credentials (admin-only). Secrets are masked in every GET; resubmitting the mask preserves the stored value on PUT.
- Server Settings → **API Tokens** tab (admin-only, lazy-loaded) lists all bearer tokens with status badges (Active/Revoked/Expired), last-used IP, scopes, **per-token integration scope** (the list of FMG/FortiGate names this token can quarantine via, with inline red/amber alerts when an integration is disabled or has `pushQuarantine: false` so the operator sees at-a-glance that pushes will be skipped), and Revoke/Delete actions. Create-token form has name, scope checkboxes (from `knownScopes`), an integration multi-picker that appears only when `assets:quarantine` is checked (REQUIRED — at least one integration; each row is decorated with the same disabled / pushQuarantine-off alert text as the table), and optional expiry. The picker source is the `quarantineIntegrations` array on `GET /api-tokens` so admins don't need a separate `/integrations` round-trip. On creation a modal shows the raw token value with a Copy button — the only time it is visible.
- Server Settings → **Identification** tab has a **MIB Database** card (admin-only) for managing SNMP MIB modules. Uploads are validated by `mibService.parseMib` (rejects anything that isn't a real ASN.1/SMI module — including binaries and arbitrary text). The form has a three-tier **Scope** selector: **Manufacturer-wide** (the most common case — covers every model from one vendor), **Device-specific** (overrides the manufacturer-wide MIB for one model only), or **Generic** (shared across all vendors, e.g. SNMPv2-SMI). Resolution priority at probe time is *device → vendor → generic → built-in seed*. The card also renders a **Vendor Profile Status** pill that shows, per built-in profile, whether each profile symbol resolves at the universal (manufacturer-only) scope and which MIB provided it; any model-specific MIBs uploaded under that manufacturer are listed beneath as "Model overrides". Uploads are wired into the SNMP telemetry probe via `oidRegistry` + `vendorTelemetryProfiles`: dropping in CISCO-PROCESS-MIB / CISCO-MEMORY-POOL-MIB / JUNIPER-MIB / MIKROTIK-MIB / FORTINET-FORTIGATE-MIB / etc. immediately starts populating CPU/memory on assets whose `manufacturer` matches the profile's regex. Until the MIB is uploaded the probe falls back to HOST-RESOURCES-MIB (which is null on most network gear).
- Server Settings → **Identification** also has a **Manufacturer Aliases** card (admin-only) — sits between OUI Overrides and the OUI Database card. Lists every alias grouped by canonical name (table columns: Alias, Canonical, Edit/Del). Add form is a two-input row: Alias (the input string to rewrite) + Canonical (the stored value) + Add button. Edit opens a small `openModal` dialog; delete uses `showConfirm`. Every save refreshes the in-memory cache and runs the existing-row backfill in the background, so the change propagates to historical Asset/MibFile rows without a restart. The card also handles the underlying problem the OUI database creates: IEEE registers vendors under their legal name (`Fortinet, Inc.`) while discovery code stamps the marketing name (`Fortinet`), and without normalization they show up as two distinct values in every manufacturer dropdown, MIB scope picker, and vendor profile match.
- Server Settings → **Maintenance** tab (formerly "Database") groups everything operational: capacity grading, in-app updates, database engine info, storage breakdown, backups, restore, and backup history. The first card on the tab is **Database** — a status pill (`Healthy` / `Action recommended` / `Critical`) plus a list of reasons with suggestions, then four side-by-side stat cards inside the same card: App host (cpu/ram/disk + DB co-located flag), Database (current size, steady-state size, sample-table breakdown with dead-tuple % per table), Database engine + connection pool (combined: type/version/host/database/SSL above active/max connections + uptime, separated by sub-headings within the same stat card), and Monitoring workload (monitored asset count, monitored interface count, cadences, retention). When `capacity` is unavailable (e.g. statfs unsupported), the card degrades to a plain "Database" header with just the engine+pool sub-card so operators don't lose connection visibility. Driven by `GET /server-settings/pg-tuning`'s `capacity` payload. Back-compat: `?tab=database` deep links automatically map to `?tab=maintenance`. The sidebar on every page shows a non-dismissible **red** alert when capacity severity is critical (replaces no existing alert — sits above the existing snoozable PG-tuning + RAM-warning alerts).

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/polaris

# pg pool size for the Prisma driver adapter (default 25). Raise when running
# with many monitored assets so worker writes don't queue inside the adapter.
DATABASE_POOL_SIZE=25

# App
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Session — required in production; server refuses to boot without it
SESSION_SECRET=changeme

# Reverse-proxy trust — leave unset on direct-to-internet deployments; set
# to a hop count ("1"), "loopback", or CIDR only when behind a real proxy.
# Setting it without a proxy lets clients spoof X-Forwarded-For and bypass
# the login rate limiter.
TRUST_PROXY=

# Health check bearer token — optional. When set, /health requires
# `Authorization: Bearer <token>`. Leave unset on private deployments.
HEALTH_TOKEN=

# Prometheus metrics bearer token — optional. When set, /metrics requires
# `Authorization: Bearer <token>`. Leave unset on private deployments.
METRICS_TOKEN=

# TimescaleDB compression window (days). Default 7. Only consulted when the
# timescaledb extension is installed; chunks older than this are compressed
# (~10-30× storage reduction). Set 0 to disable compression entirely.
TIMESCALE_COMPRESS_AFTER_DAYS=7

# Persistent-state directory — optional. When set, the four runtime-mutable
# state items (.env, .setup-complete, data/backups, public/uploads) all live
# under this single directory. Leaving it unset keeps the legacy layout where
# each item lives at its historical path under the project root, so RHEL prod
# and dev installs see no behavior change. Resolved by `src/utils/paths.ts`;
# the Docker image pins this to /app/state so Unraid can persist state with
# one bind mount.
POLARIS_STATE_DIR=

# HTTPS (optional)
HTTPS_CERT_PATH=
HTTPS_KEY_PATH=
HTTPS_REDIRECT=false

# Azure SAML (optional)
AZURE_TENANT_ID=
AZURE_APP_ID=
AZURE_SAML_CALLBACK_URL=

# Syslog (optional)
SYSLOG_HOST=
SYSLOG_PORT=514
SYSLOG_PROTOCOL=udp

# SFTP archival (optional)
ARCHIVE_SFTP_HOST=
ARCHIVE_SFTP_PORT=22
ARCHIVE_SFTP_USER=
ARCHIVE_SFTP_PASSWORD=
ARCHIVE_SFTP_PATH=
```

Copy `.env.example` to `.env` before running.

---

## Deployment & Updates

The production instance is updated via the **in-app update mechanism** in **Server Settings → Maintenance**. When pushing changes, the user applies the update through that UI rather than manually redeploying. Keep this in mind when giving deployment advice — do not suggest `git pull` or manual restart steps unless asked.

Fresh installs are documented in `docs/INSTALL.md` with three platform sections (RHEL/Rocky/AlmaLinux 9, Ubuntu/Debian, Windows Server). The disk-sizing table at the top of that file is the single source of truth for DB-volume / app-volume / `/var/log` minimums and recommendations — keep it in sync whenever the runtime workload (sample-table cadences, retention defaults, update-staging cost) changes meaningfully. The setup wizard's preflight check uses `RECOMMENDED_DB_FREE_GB = 50` as the threshold for the warning banner; bump that constant in `src/setup/setupRoutes.ts` if the recommended minimum changes and update the docs table to match.

### Disk-space monitoring (post-install)

Three layers catch a filling DB volume before it crashes Postgres:

1. **Boot-time diagnostic** — `runStartupDiskCheck` in `src/utils/startupDiskCheck.ts` statfs's the app/state/backups dirs plus conventional PostgreSQL data directory candidates per platform. Emits an info/warn/error log line per volume. Non-fatal — never blocks boot. Catches the "polaris flapping with cryptic Prisma error because /var is full" symptom by turning it into a clear log line.
2. **Periodic capacityWatch job** — every 10 minutes, builds a capacity snapshot and calls `recordCapacityTransition` to write a `capacity.severity_changed` Event when severity flips (ok ↔ watch ↔ amber ↔ red). Events flow out through eventArchiveService → syslog/SFTP archival, so the alert reaches on-call independent of whether the UI is reachable.
3. **Maintenance tab volume bars** — Server Settings → Maintenance → Database card renders one bar per distinct filesystem (deduped by stat.dev) with severity-colored fill and the Polaris-named role(s) each volume serves. Severity tiering: **watch** at 20–30% free (Event-only), **amber** at 10–20%, **red** below 10% (drives the non-dismissible sidebar banner).

### First-run setup lock

The setup wizard is unauthenticated by design (the operator needs to reach it from a browser to provision the host). To stop a network attacker from re-running the wizard against an already-configured host whose `.env` got deleted/corrupted, finalize writes a `.setup-complete` marker at the project root. On every boot:

- `DATABASE_URL` set → app boots normally; marker is back-filled if missing (covers existing installs).
- `DATABASE_URL` missing AND no marker → wizard runs (fresh install).
- `DATABASE_URL` missing AND marker present → process logs a recovery message and exits 1; the wizard never starts.

To intentionally re-provision from scratch, an admin with shell access deletes both `.env` and `.setup-complete`.

---

## Getting Started

```bash
# Install dependencies
npm install

# Setup database
npx prisma migrate dev --name init

# Seed example data
npm run db:seed

# Start dev server (with hot reload)
npm run dev

# Run tests
npm test

# Build for production
npm run build && npm start

# Test FortiManager connectivity
npm run test:fmg

# Type check / lint
npm run typecheck
npm run lint
```

---

## Key Coding Conventions

- All IP math lives in `src/utils/cidr.ts`. **Never** do string manipulation on IPs elsewhere.
- Services (`src/services/`) contain **all business logic**. Route handlers are thin — validate input, call a service, return a response.
- All Zod schemas live co-located with their route file (top of file).
- Database calls go through service functions only — never raw Prisma in route handlers.
- All errors thrown by services must be instances of `AppError` (`src/utils/errors.ts`) with an `httpStatus` property.
- Use `async/await` throughout; avoid `.then()` chains.
- Write a unit test for every public function in `src/utils/` and `src/services/`.
- All audit-worthy actions (creates, updates, deletes, discovery events) must write an `Event` record.
- **Keep CLAUDE.md current.** When you add a model, field, route, service, job, or env var — update the relevant section of this file in the same commit.
- **Keep demo.mjs current.** When you add a significant new entity, field, or feature, update `demo.mjs` so it exercises the new capability.
- **Commit after every change.** Each logical change (feature, fix, update) gets its own commit immediately — don't batch unrelated work.
- **Version is automatic.** The patch is computed by `src/utils/version.ts` (Docker: baked-in `POLARIS_BUILD_COMMIT_COUNT`, otherwise `git rev-list --count HEAD`). Do not touch `package.json` version for patch increments — it stays `<major>.<minor>.0`. Bump the minor (e.g. `0.9.0` → `0.10.0`) only when cutting a named release.
- **FortiManager ↔ standalone FortiGate parity.** Treat the FortiManager and standalone FortiGate integrations as paired surfaces. Whenever you add or change a FortiManager-side feature — new tab, config field, toggle, push pathway, monitoring stream, filter, etc. — evaluate whether the same change applies to the standalone FortiGate path and, if so, ship both in the same change. The two integrations talk to the same FortiOS device fleet via different transports (FMG proxy/direct vs. direct REST), so most user-visible features make sense on both. Only skip parity when the feature is structurally FMG-only (multi-FortiGate device filter, ADOM scoping, FMG-proxy concurrency tuning). UI: the Add/Edit modal tab layouts (`General` / `Filters` / `Monitoring` / `DHCP Push` / `Quarantine Push`) should look identical between the two types — diverge only on the tab content where the integrations genuinely differ. Backend: prefer `buildTransportForIntegration()`-style helpers that dispatch on integration type so push/quarantine/lease-release pathways stay generic instead of hardcoding `type === "fortimanager"` checks.

---

## Observability

- `GET /health` — open by default, gated by `HEALTH_TOKEN` when set. Returns `{status: "ok"}` once the app has booted; the first-run setup wizard polls it (from localhost) to detect when the main app has come up after finalize.
- `GET /metrics` — Prometheus text-format endpoint, open by default, gated by `METRICS_TOKEN` when set. Exposes default Node.js process / GC / event-loop metrics (un-prefixed so standard Grafana dashboards work) plus Polaris-specific gauges, histograms, and counters defined in `src/metrics.ts`. Polaris-specific metric names are prefixed `polaris_`. Currently exported:
  - `polaris_monitor_pass_duration_seconds` (histogram) — wall-clock of one `runMonitorPass`. Watch this rise toward the configured cadence as a saturation signal.
  - `polaris_monitor_work_duration_seconds{cadence}` (histogram) — per-work-item wall-clock; `cadence` is `probe | telemetry | systemInfo | fastFiltered`.
  - `polaris_monitor_work_total{cadence,outcome}` (counter) — `outcome` is `success | failure | crash`.
  - `polaris_monitor_queue_depth{cadence}` (gauge) — queued items at start of pass.
  - `polaris_probe_duration_seconds{transport}` (histogram) — per-probe RTT; `transport` is the asset's `monitorType`.
  - `polaris_probe_total{transport,outcome}` (counter) — `outcome` is `success | failure`.
  - `polaris_monitored_assets` (gauge) — total assets with `monitored=true` and a `monitorType` set.
  - `polaris_monitored_assets_by_status{status}` (gauge) — `status` is `up | down | unknown`.

  These mirror the structure that pg-boss / TimescaleDB / discovery instrumentation will plug into in later phases.

---

## Common Claude Code Tasks

- **Add a field to an entity** — Update `prisma/schema.prisma`, generate migration, update Zod schema in the route file, update the service type.
- **Add a new integration type** — New service in `src/services/`, register in `integrations.ts` route, add discovery hook in `discoveryScheduler.ts`.
- **Add a new asset field** — Schema + migration, update `assets.ts` Zod schema, update `assets.js` frontend table/form.
- **Add a new role permission** — Update or add middleware in `src/api/middleware/auth.ts`, apply in `router.ts`.
- **Add bulk reservation import via CSV** — Route `POST /api/v1/reservations/import`, service function handles row validation and upsert.
- **Write integration tests** — Vitest + Supertest against a test database (Docker Compose).

---

## Out of Scope

- DNS record management
- DHCP server configuration push
- Network device provisioning
- Cloud provider VPC/subnet creation (AWS, GCP, Azure)
- Authentication identity provider (use local users or Azure SAML configured externally)
