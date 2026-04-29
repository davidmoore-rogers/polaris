# Polaris — Claude Code Project

## Project Overview

**Polaris** is an IP management tool that allows users to reserve and manage IP address space (IPv4 and IPv6) for use across other infrastructure projects. Named after the North Star — a fixed reference point operators can navigate by when wiring up everything else. It provides a central registry for subnets, individual IPs, and reservations — preventing conflicts and giving teams visibility into IP utilization.

> **Legacy identifiers:** several internal names (`shelob_csrf` cookie, `shelob-*` localStorage keys, `SHELOB1\0` backup magic bytes, `deploy/shelob.service`, `/opt/shelob` install path, the `shelob` Postgres database/user, the `__shelob_timing_dummy__` argon2 constant) are intentionally kept under the project's previous name to avoid logging users out, invalidating preferences, breaking encrypted backup restores, or requiring host-level migrations. Treat them as fixed identifiers, not branding.

Current version: **0.9.x** (pre-release; patch = git commit count, minor per release). Version is shown in the sidebar and embedded in backup filenames. The patch is derived automatically at startup from `git rev-list --count HEAD` — never bump it manually.

---

## Architecture

```
polaris/
├── CLAUDE.md
├── README.md
├── .env.example
├── package.json
├── tsconfig.json
├── demo.mjs                         # Demo/seed script
├── prisma/
│   ├── schema.prisma                # Database schema
│   └── seed.ts
├── scripts/
│   ├── test-fmg.mjs                 # FortiManager integration test harness
│   ├── audit-multi-mac-assets.mjs   # One-off: unstitch assets cross-stapled by old IP-fallback bug
│   └── check-fmg-tokens.mjs         # One-off: print stored FMG/FortiGate token length/prefix to diagnose token corruption
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
│   ├── css/
│   │   ├── styles.css
│   │   ├── map.css                  # Device Map styles (marker icons, topology modal grid)
│   │   └── vendor/leaflet/          # Leaflet + markercluster CSS + marker PNGs (bundled; CSP blocks external CDN)
│   └── js/
│       ├── api.js                   # HTTP client with auth/error handling
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
│   │   │   ├── csrf.ts              # Synchronizer-token CSRF protection (`shelob_csrf` cookie + `X-CSRF-Token` header)
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
│   │   ├── utilizationService.ts    # Utilization reporting
│   │   ├── fortimanagerService.ts   # FMG JSON-RPC client & discovery orchestration
│   │   ├── fortigateService.ts      # Standalone FortiGate REST API client & discovery
│   │   ├── windowsServerService.ts  # Windows Server WinRM DHCP discovery
│   │   ├── entraIdService.ts        # Microsoft Entra ID + Intune device discovery via Graph
│   │   ├── activeDirectoryService.ts # On-premise Active Directory computer discovery via LDAP/LDAPS
│   │   ├── searchService.ts         # Global typeahead search (classifies IP/CIDR/MAC/text; parallel entity queries)
│   │   ├── allocationTemplateService.ts # Saved multi-subnet allocation templates (Setting-backed)
│   │   ├── assetIpHistoryService.ts # Asset IP history reads, retention settings, pruning (Setting-backed)
│   │   ├── discoveryDurationService.ts # Rolling discovery-duration samples + "slow-run" threshold (Setting-backed)
│   │   ├── azureAuthService.ts      # Azure AD/Entra SAML SSO, user provisioning
│   │   ├── totpService.ts           # RFC 6238 TOTP secret / code / backup-code helpers
│   │   ├── dnsService.ts            # Reverse DNS lookup for assets
│   │   ├── ouiService.ts            # MAC OUI lookup with admin overrides
│   │   ├── eventArchiveService.ts   # Syslog (CEF) + SFTP/SCP event archival
│   │   ├── serverSettingsService.ts # HTTPS, branding, backup/restore
│   │   ├── credentialService.ts     # Named credential store (SNMP / WinRM / SSH) with masking + secret-preservation merge
│   │   ├── manufacturerAliasService.ts # Manufacturer alias map: CRUD + cache + idempotent default seed + backfill of existing Asset/MibFile rows
│   │   ├── mibService.ts            # SNMP MIB module storage + minimal SMI parser (validates uploads, extracts moduleName + IMPORTS)
│   │   ├── oidRegistry.ts           # Symbolic name → numeric OID resolver. Per-asset **scoped** resolution: device-specific MIBs override vendor-wide MIBs override generic MIBs override the built-in SMI seed. Each scope is computed lazily and cached; cache + parsed entries refresh on MIB upload/delete and at app startup. Tracks per-symbol provenance so the UI can show which MIB provided each resolved name.
│   │   ├── vendorTelemetryProfiles.ts # Per-vendor SNMP CPU/memory profile registry. Maps `manufacturer + os` regex → symbolic OID names; resolved through oidRegistry at probe time. Built-ins for Cisco / Juniper / Mikrotik / Fortinet (SNMP path) / HP-Aruba / Dell.
│   │   ├── monitoringService.ts     # Authenticated response-time probes (fortimanager/fortigate/snmp/winrm/ssh/icmp) + System tab telemetry (CPU/memory) + system-info (interfaces/storage) collection. runMonitorPass dispatches all three cadences; per-stream retention prune helpers.
│   │   ├── capacityService.ts       # Capacity snapshot: host (cpu/ram/disk), DB sample-table breakdown, monitoring workload + steady-state size projection, severity grading (ok/amber/red). Feeds the Maintenance tab Capacity card and the sidebar critical alert via the /server-settings/pg-tuning endpoint.
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
│   │   ├── monitorAssets.ts          # 5s tick: probe due assets via runMonitorPass; daily sample-retention prune
│   │   └── normalizeManufacturers.ts # One-shot startup: seed default aliases, load cache, backfill existing Asset/MibFile rows
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
│       ├── mfaPending.ts            # Short-lived pending-MFA tokens for two-phase login
│       └── password.ts              # argon2id hash/verify helpers (with legacy bcrypt detection off)
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
| ORM | Prisma 5 |
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
AssetStatus:             active | maintenance | decommissioned | storage | disabled
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
  macAddress      String?         -- Most recently seen MAC
  macAddresses    Json            -- [{mac, lastSeen, source?}] — full MAC history
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
  associatedIps   Json            -- [{ip, interfaceName?, source?, lastSeen?, ptrName?}] — additional IPs; source="manual" preserved across discovery
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

AssetIpHistory                  -- Auto-populated log of every IP each asset has held
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  ip            String
  source        String          -- "manual", "fortimanager", "fortigate", "dns", etc.
  firstSeen     DateTime
  lastSeen      DateTime
  @@unique([assetId, ip])       -- one row per (asset, ip); lastSeen and source update on re-sighting

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

AssetIpsecTunnelSample          -- System tab per-tunnel IPsec snapshot, written on the system-info cadence. FortiOS only — read from /api/v2/monitor/vpn/ipsec, plus a parallel /api/v2/cmdb/vpn.ipsec/phase1-interface lookup so each row carries `parentInterface` (the FortiOS CLI `set interface` value, e.g. "wan1"). The System tab uses parentInterface to nest tunnel rows under their parent in the Interfaces table — there is no longer a standalone IPsec section. Tunnels whose parentInterface lookup fails (CMDB scope missing, parent filtered out, etc.) fall into an "IPsec Tunnels (unbound)" group at the bottom of the same table. One row per phase-1 tunnel; status rolls phase-2 selectors up to "up" (all up), "down" (all down), or "partial" (mix). Bytes are summed across every phase-2 selector under this phase-1 and are cumulative — FortiOS resets when phase-1 renegotiates, so the throughput derivation drops negative deltas as counter resets. ADVPN dynamic shortcut tunnels (those returning a non-empty `parent` field on the FortiOS response) are filtered out at the collector so spoke shortcut churn doesn't pollute the table. The full IPsec endpoint is skipped on the fast (per-minute) cadence by default; pinning a tunnel name in Asset.monitoredIpsecTunnels turns it back on for that one tunnel.
  id              UUID PK
  assetId         UUID FK → Asset (cascade delete)
  timestamp       DateTime        @default(now())
  tunnelName      String          -- phase-1 name
  parentInterface String?         -- FortiOS phase1-interface CMDB `interface` field (e.g. "wan1"); null when the CMDB lookup fails or returns no match
  remoteGateway   String?         -- rgwy / tun_id
  status          String          -- "up" | "down" | "partial"
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
- `POST   /reservations`
- `GET    /reservations/:id`
- `PUT    /reservations/:id`
- `DELETE /reservations/:id`                    — Release

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
- `GET    /assets/:id/system-info`              — Asset details System tab: latest interface + storage + telemetry snapshot. Returns `{ monitored, monitorType, lastTelemetryAt, lastSystemInfoAt, telemetry: {...}|null, interfaces: [...], storage: [...] }`. Empty arrays when no scrape has run yet.
- `GET    /assets/:id/telemetry-history?range=1h|24h|7d|30d` *or* `?from&to`  — CPU/memory time-series. Returns `{ range, since, until, samples, stats: { total, avgCpuPct, maxCpuPct, avgMemPct, maxMemPct } }`. memPct is computed from `memUsedBytes / memTotalBytes` if the source supplied bytes only.
- `GET    /assets/:id/interface-history?ifName=...&range=...`  — Per-interface counter samples; sized by interface (a 30-port switch with one row per 10 min ≈ 4,300 samples per 30-day range). Includes `inErrors` / `outErrors` (cumulative IF-MIB / FortiOS error counters) so the asset-detail interface slide-over can derive a per-interval error rate. The response also surfaces the latest sample's `alias` / `description` at the top level (FortiOS CMDB `alias` + `description`, SNMP `ifAlias`) so the slide-over header can show `<alias> (<ifName>)` and render the comment in the **Interface Comments** editor. `description` is the *resolved* value (override if set, else discovered); `discoveredDescription` and `overrideDescription` are also returned separately so the editor can label the source and show the device-reported value as ghost text when no override is set.
- `PUT    /assets/:id/interfaces/:ifName/comment` *(assets admin)* — Set or clear the Polaris-local Interface Comments override. Body: `{ description: string | null }` (max 255 chars; null or empty string deletes the override row so the discovered FortiOS CMDB description shows through again). Polaris never pushes this value back to the device. Writes one `asset.interface.comment_updated` Event.
- `GET    /assets/:id/temperature-history?range=...[&sensorName=...]`  — Per-sensor temperature time-series. Returns `{ samples, stats: { total, avgCelsius, minCelsius, maxCelsius } }`. Shared with telemetry retention.
- `GET    /assets/:id/storage-history?mountPath=...&range=...`  — Per-mountpoint usage samples. SNMP-monitored assets only.
- `GET    /assets/:id/ipsec-history?tunnelName=...&range=...`  — Per-tunnel IPsec samples (status timeline + cumulative bytes). FortiOS-monitored assets only.
- `POST   /assets/:id/reserve`                  *(user-or-above)* — Reserve the asset's `ipAddress` in the non-deprecated subnet that contains it. Hostname source order: `asset.hostname` → `asset.assetTag` → `asset.ipAddress`. `createdBy` is stamped with the caller's username so the unreserve permission check below can authorize releases. If a `dhcp_lease` reservation is currently holding the IP it is auto-released first so the manual reservation can take its place — leases roll over with DHCP, so the UI treats them as "no real reservation" and surfaces the Reserve button anyway. 400 if the asset has no IP, 409 if no containing subnet exists or the IP is already actively reserved by something other than a lease.
- `POST   /assets/:id/unreserve`                *(user-or-above)* — Release the active reservation matching the asset's IP. Network admins can release any; everyone else can only release reservations they themselves created (`reservation.createdBy === session.username`) — discovery-created reservations (`createdBy = null`) can therefore only be released by a network admin.

Both endpoints rely on the synthesized `ipContext` field that the assets list and single-GET attach to each row: `{ subnetId, subnetCidr, reservation: { id, createdBy, sourceType } | null } | null` (null when the asset has no IP, or no non-deprecated subnet contains the IP). The Assets page reads this to decide whether to render Reserve / Unreserve / nothing, and to disable the Unreserve button for users who don't own the reservation. Rows whose only active reservation is a `dhcp_lease` render Reserve (not Unreserve) so the operator can promote the lease into a real reservation.

### Credentials — mixed scoping
- `GET    /credentials`                         *(auth)* — List stored credentials with secrets masked. Read-open so any role's Asset Monitoring tab can render the credential picker.
- `GET    /credentials/:id`                     *(auth)* — Single credential, masked.
- `POST   /credentials`                         *(admin)* — Create. Body: `{ name, type: "snmp"|"winrm"|"ssh", config }`. Type-specific config is validated server-side.
- `PUT    /credentials/:id`                     *(admin)* — Update. Type cannot be changed after creation. Resubmitting the mask sentinel for a secret field preserves the stored value.
- `DELETE /credentials/:id`                     *(admin)* — 409 if any asset still references the credential as `monitorCredentialId`.

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
- `POST   /conflicts/:id/accept`                — Reservation: apply discovered values. Asset: set existing asset's `assetTag` to `entra:{deviceId}` and overlay Entra/Intune fields (only into empty existing fields). 403 if caller's role doesn't cover this conflict's entityType.
- `POST   /conflicts/:id/reject`                — Reservation: keep existing, dismiss. Asset: create a separate new Asset with the Entra snapshot + assetTag `entra:{deviceId}` so the next discovery run finds it by tag and doesn't re-fire the collision.

### Search — `requireAuth`
- `GET    /search?q=<query>`                    — Global typeahead. Classifies input (IP, CIDR, MAC, or text), runs 4 parallel entity queries, returns grouped results (`blocks`, `subnets`, `reservations`, `assets`, `ips`) capped at 8 per group. The `ips` hit resolves the containing subnet and any active reservation. All authenticated roles can search; front-end edit modals render in view-only mode for users without write permission.

### Device Map — `requireAuth`
- `GET    /map/sites`                           — Every firewall Asset with non-null lat/lng. Includes subnet count (via `Subnet.fortigateDevice` match), last-seen status, and a monitor health snapshot: `monitored`, `monitorHealth` (`"up" | "degraded" | "down" | "unknown"`, `null` when unmonitored), `monitorRecentSamples`, `monitorRecentFailures`. Health is computed from the last 10 `AssetMonitorSample` rows per asset — all 10 ok → `up` (green pin), any failed → `degraded` (amber, "packet loss"), 10/10 failed → `down` (red). The map intentionally uses this fixed 10-sample window rather than the global `monitor.failureThreshold`. Sidebar page entry: "Device Map" (below Dashboard).
- `GET    /map/search?q=<query>`                — Autocomplete over firewall hostnames + serials, capped at 12. Only returns sites that have coordinates (a pinless FortiGate can't be navigated to).
- `GET    /map/sites/:id/topology`              — Graph payload for the click-through modal. Returns `{ fortigate, switches[], aps[], subnets[], edges[] }`. The `fortigate` object carries the same `monitored` / `monitorHealth` / `monitorRecentSamples` / `monitorRecentFailures` fields as `/map/sites` so the modal's root node color matches the pin. Every edge id references a node in the same payload. FortiGate→Switch edges are derived from `Asset.fortinetTopology.uplinkInterface` (the FortiLink interface from `managed-switch/status.fgt_peer_intf_name`). AP→Switch edges come from `switch-controller/detected-device` MAC learnings matched against AP base_mac during discovery; APs with no peer switch fall back to a direct FortiGate→AP edge. FortiSwitch and FortiAP nodes are always rendered dark gray in the topology — Polaris can't independently probe devices behind the FortiGate, so no monitor color is reported for them.

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
- `GET    /server-settings/pg-tuning`           — Capacity + tuning health check. Returns the legacy `{needed, triggered, counts, thresholds, settings, snoozedUntil, ramInsufficient, currentRamGb, recommendedRamGb}` payload **plus** `capacity: CapacitySnapshot` from `capacityService.getCapacitySnapshot()`. The capacity payload exposes overall `severity` (`ok` | `amber` | `red`), an array of `reasons` ({severity, code, message, suggestion}), `appHost` (cpu/ram/disk), `database.sampleTables[]` (rows, bytes, deadTupRatio, lastAutovacuum), and `workload.steadyStateSizeBytes` — the projected DB size at current monitored-asset count × cadences × retention. Severity tiering: **red** (disk free <10%, DB > 50% of free disk, autovacuum stale >7d on a populated sample table, projected size > 8× host RAM) drives the non-dismissible sidebar alert; **amber** (disk 10–20%, dead-tup >20%, projected > 4× RAM, plus the legacy ramInsufficient/pgTuningNeeded signals) drives the existing snoozable PG-tuning + RAM-warning alerts.
- `POST   /server-settings/pg-tuning/snooze`    — Snooze the **amber** PG-tuning recommendation banner for N days (1–30, default 7). Red capacity alerts are not snoozable from the UI.
- `GET    /server-settings/mibs?manufacturer=&model=&scope=all|device|generic` — List uploaded MIBs (filters: manufacturer + model exact match, scope filters generic vs device-specific).
- `GET    /server-settings/mibs/facets`         — `{ manufacturers: [], modelsByManufacturer: { mfr: [models] } }` — distinct values from already-uploaded MIBs **plus** the asset inventory, so the upload-form datalists aren't empty before the first vendor MIB is uploaded.
- `GET    /server-settings/mibs/:id`            — Full record including raw `contents`.
- `GET    /server-settings/mibs/:id/download`   — `text/plain` download with the original filename.
- `POST   /server-settings/mibs`                — `multipart/form-data` upload. Fields: `file` (required), `manufacturer?`, `model?`, `notes?`. The body is parsed by a minimal SMI validator (`mibService.parseMib`) before insert: rejects empty files, files containing NUL/control bytes, anything missing the `<NAME> DEFINITIONS ::= BEGIN ... END` envelope, or files exceeding 1 MB. `moduleName` and `imports` are extracted from the parse and stored on the row. Duplicate `(manufacturer, model, moduleName)` returns 409. Setting `model` without `manufacturer` is a 400 (generic MIBs can't be model-scoped).
- `DELETE /server-settings/mibs/:id`            — Remove a stored MIB.
- `GET    /server-settings/mibs/profile-status` — Returns one entry per built-in vendor telemetry profile (`{ vendor, matchPattern, example, symbols: [{metric, symbol, resolved, fromModuleName, fromScope}], ready, partial, modelOverrides: [{model, mibCount}] }`). The MIB Database card uses this to render the **Vendor Profile Status** pill. `fromScope` is `"device" | "vendor" | "generic" | "seed"` and reflects which layer of `oidRegistry`'s scoped resolver provided the symbol.

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

**Ownership model for networks and reservations.** `user` and `assetsadmin` callers can create subnets (`POST /subnets`, `POST /subnets/next-available`) and reservations, but can only edit/delete records where `createdBy` matches their own username. `admin` and `networkadmin` bypass the ownership check. Enforced via the `requireUserOrAbove` middleware + inline `isNetworkAdminOrAbove(req)` check on PUT/DELETE handlers. The `requireNetworkAdmin` guard still applies to block CRUD and bulk subnet allocation.

Rate limiting: 10 login attempts / 15 min per IP.

Azure SAML SSO is optional; users are auto-provisioned on first login with a default role.

**FMG auth note:** FortiManager 7.4.7+ / 7.6.2+ removed `access_token` query string support. The service uses the Bearer `Authorization` header exclusively. The standalone FortiGate integration (`fortigateService.ts`) uses the same Bearer header pattern against a REST API Admin token.

**Monitor-type override on integration-discovered assets.** Discovery stamps `discoveredByIntegrationId` and a default `monitorType` (`fortimanager` / `fortigate` / `activedirectory`) on each FortiGate firewall and realm-monitorable Windows/Linux host. The Monitoring tab on the asset edit modal exposes the integration default as one of several options — operators can switch to a generic `snmp` / `icmp` / `winrm` / `ssh` probe at any time and assign a stored Credential. This is the recommended path for small-branch FortiGates whose REST sensor endpoint 404s on FortiOS 7.4.x (60F/61F/91G class): switching to SNMP routes telemetry, temperatures, and interfaces over `FORTINET-FORTIGATE-MIB::fgHwSensors` + IF-MIB. Subsequent discovery runs preserve the override — they still stamp `discoveredByIntegrationId` but only re-stamp `monitorType` when it's null or already an integration default. The override detection lives inline in `integrations.ts` discovery sites; `validateMonitorConfig` in `assets.ts` no longer enforces a lock.

**Per-integration response-time probe override:** The FMG/FortiGate integration's `config` JSON accepts an optional `monitorCredentialId` (UUID of a stored SNMP credential). When set, the response-time probe for any firewall asset *still on the integration default* runs SNMP `sysUpTime` against the asset's IP using that credential, instead of FortiOS REST `/api/v2/monitor/system/status`. SNMP is typically much faster than the API, so this is the recommended setup when the API path is contributing to slow `lastResponseTimeMs` on the chart. Telemetry, system-info, and discovery still flow over the FortiOS API — only the up/down probe is rerouted. Edited from the **FortiGates subtab** of the Monitoring tab on the integration's Add/Edit modal; cleared by selecting "FortiOS REST API (default)". The picker only lists credentials with `type = "snmp"`. Validated server-side: a non-existent or non-SNMP credential id is rejected. Has no effect on assets the operator has switched to a generic `monitorType` — those follow the per-asset `monitorCredentialId` instead.

**Per-class FortiSwitch / FortiAP direct polling and auto-Monitor flag:** The FMG/FortiGate integration's `config` JSON accepts `fortiswitchMonitor` and `fortiapMonitor` blocks, each `{ enabled: boolean, snmpCredentialId: string | null, addAsMonitored: boolean }`, plus a `fortigateMonitor: { addAsMonitored: boolean }` block. Edited from the **FortiSwitches** and **FortiAPs** subtabs (full block) and the **FortiGates** subtab (auto-Monitor checkbox only) of the Monitoring tab. The two switch/AP flags are independent and drive four discovery-time outcomes:

| `enabled` (direct polling) | `addAsMonitored` | Stamped on new switch/AP |
|---|---|---|
| false | false | nothing (operator configures monitoring later) |
| false | true | `monitored=true`, `monitorType="icmp"` (ICMP fallback) |
| true (with credential) | false | `monitorType="snmp"`, `monitorCredentialId=<id>`, `monitored=false` |
| true (with credential) | true | `monitored=true`, `monitorType="snmp"`, `monitorCredentialId=<id>` |

Discovery also stamps `discoveredByIntegrationId=<integration>` on any of the three "non-empty" rows. Existing switch/AP assets are *only* re-stamped when the operator hasn't changed the type — detected as `monitorType` is null OR matches one of the integration's two possible defaults (`snmp` with the integration's credential, or `icmp` with no credential). Anything else (winrm, ssh, a different SNMP credential, etc.) counts as an operator override and is preserved. The subtabs warn that managed FortiSwitches/FortiAPs in FortiLink mode usually keep their own management plane locked down — direct polling only works when SNMP has been explicitly enabled on the device itself, which is the operator's responsibility.

For **FortiGates**, the integration always stamps `monitorType="fortimanager"` or `"fortigate"` (its native default) on new assets, so `fortigateMonitor.addAsMonitored` is the only flag — checking it adds `monitored=true` to fresh creates only. Existing FortiGates are not touched.

**Decommission sweep for managed switches/APs.** Discovery tracks two new `DiscoveryResult` arrays — `switchInventoriedDevices` and `apInventoriedDevices` — listing the controller FortiGates whose `managed-switch/status` / `wifi/managed_ap` query returned successfully (including 404, which means the feature isn't licensed but the controller is reachable). At the end of the run, in the same pass that deprecates stale subnets (Phase 2), `syncDhcpSubnets` flips any switch/AP whose `discoveredByIntegrationId` matches this integration AND whose `fortinetTopology.controllerFortigate` is in the inventoried-devices set AND whose serial/hostname is no longer in the discovery's sighting set to `status="decommissioned"`. Switches/APs behind a controller whose inventory query *failed or timed out* are left alone (we didn't get a fresh answer). Re-discovery by serial number flips a decommissioned asset back to `active` (or `storage` for FortiSwitches reported as `Unauthorized`). Each decommission writes one `asset.fortiswitch.decommissioned` or `asset.fortiap.decommissioned` Event with the reason `missing-from-controller`.

**Per-device transport (`useProxy` toggle):** The FMG integration has two per-device query transports, selectable in the integration edit modal. The UI checkbox is labeled "Query each FortiGate directly (bypass FortiManager proxy)" — *checked = direct, unchecked = proxy*. The on-disk field is still `useProxy` (true=proxy); the UI just inverts the semantics so the more aggressive option (direct) is the explicit affirmative action. The modal also surfaces a "more than 20 FortiGates → switch to direct" recommendation since proxy mode polls one device at a time.
- **Proxy mode** (default, `useProxy: true`): all per-device queries funnel through FMG's `/sys/proxy/json` (monitor endpoints) and `/pm/config/device/<name>/...` (CMDB). Parallelism is force-clamped to 1 because FMG drops parallel connections past very low parallelism, surfacing as `fetch failed` on random calls.
- **Direct mode** (`useProxy: false`): FMG is only used to enumerate the managed FortiGate roster; per-device calls go direct to each FortiGate's management IP (the `ip` field on the FMG `/dvmdb/adom/<adom>/device` response) using shared REST API credentials stored in `config.fortigateApiUser` / `config.fortigateApiToken`. Each managed FortiGate must have the same REST API admin provisioned with a trusthost that includes Polaris. Delegates per-device work to `fortigateService.discoverDhcpSubnets` and remaps the device name back to FMG's label. Unlocks `discoveryParallelism` (up to 20).

---

## FMG Discovery Workflow

`fortimanagerService.ts` connects to FortiManager via JSON-RPC and discovers:

- **DHCP scopes** → Subnet records (`discoveredBy`, `fortigateDevice`)
- **DHCP reservations** → Reservations (`sourceType: dhcp_reservation`)
- **DHCP leases** → Reservations (`sourceType: dhcp_lease`); captures `expire_time`, `access_point`, `ssid`
- **Interface IPs** → Reservations (`sourceType: interface_ip`) — note: discovery no longer mirrors these into `Asset.associatedIps`. The System tab's interface scrape (run on the monitoring cadence once monitoring is enabled on the firewall asset) is the single source for `Asset.associatedIps` per-interface entries.
- **Virtual IPs (VIPs)** → Reservations (`sourceType: vip`)
- **FortiSwitch devices** → Asset records (`assetType: switch`); via FMG proxy to `/api/v2/monitor/switch-controller/managed-switch/status`. `fortinetTopology` stamped with `{ role: "fortiswitch", controllerFortigate, uplinkInterface }` so the Device Map renders the FortiLink uplink as an edge.
- **FortiAP devices** → Asset records (`assetType: access_point`); via FMG proxy to `/api/v2/monitor/wifi/managed_ap`. `fortinetTopology` stamped with `{ role: "fortiap", controllerFortigate, parentSwitch, parentPort, parentVlan }`; the switch-port attribution comes from matching AP `base_mac` against `/api/v2/monitor/switch-controller/detected-device` during discovery (falls back to a direct FortiGate edge if the AP's MAC is not on any managed switch port).
- **FortiGate geo coordinates** → `Asset.latitude` / `Asset.longitude` on the firewall Asset, pulled from `/api/v2/cmdb/system/global` (`longitude`, `latitude` fields of `config system global`). Feeds the Device Map. Discovery silently skips this step on FortiOS versions that don't expose the fields — existing coords are never blanked.
- **FortiSwitch / FortiAP MACs** → Updates Asset `lastSeenSwitch` / `lastSeenAp`

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
- **Device identity** — the Entra `deviceId` (GUID) is the stable key. Persisted on `Asset.assetTag` as `entra:{deviceId}`.
- **Re-discovery** — Assets are matched in this order: (1) `assetTag = "entra:{deviceId}"`, (2) `sid:{SID}` tag match against `onPremisesSecurityIdentifier` (hybrid-joined devices the AD integration already created — Entra **takes over** the assetTag in that case; the AD GUID stays findable via the `ad-guid:{guid}` tag), (3) hostname collision against an untagged asset → a `Conflict` (entityType `"asset"`, deduped on `proposedDeviceId`) is created for admin/assetsadmin review. The slide-over panel renders a side-by-side comparison; **Accept** adopts the existing asset (writes the Entra assetTag + fills empty fields from the snapshot), **Reject** creates a separate asset with the Entra tag so future runs find it by tag.
- **Asset type** — inferred from Intune `chassisType` (`desktop/laptop/convertible/detachable` → `workstation`; `tablet/phone` → `other`); Entra-only devices default to `workstation`. Admins can recategorize via the asset edit UI; re-discovery only overwrites `assetType` if it is still `other`.
- **User** — Intune `userPrincipalName` → `Asset.assignedTo`. Entra-only runs do not populate this field.
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

- Both services stamp `sid:{SID}` (uppercase) in the asset's `tags` array.
- AD additionally stamps `ad-guid:{guid}` (lowercase hex) in `tags` so the AD GUID stays findable even after Entra takes over the primary `assetTag`.
- **Priority rule:** Entra's `assetTag = "entra:{deviceId}"` always wins when both sources have the device. If AD created the asset first, the next Entra run finds it via the SID tag and replaces the `assetTag` (the `ad-guid:{guid}` tag preserves AD's lookup key). If Entra created it first, the next AD run finds it via SID and updates in place without touching the Entra `assetTag`.
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
| `decommissionStaleAssets` | Every 24 hours | Move assets whose `lastSeen` is older than the configured inactivity threshold (months) to `decommissioned` status. Configured via Events → Settings → Assets tab; 0 disables. |
| `discoverySlowCheck` | Every 30 s | Compares each in-flight discovery's elapsed time to its rolling-duration baseline (`discoveryDurationService`). Emits one `integration.discover.slow` event per run (and one per FortiGate inside an FMG run) when elapsed exceeds `max(avg + 2σ, avg × 1.5, avg + 60 s)`; baseline requires ≥3 prior successful runs. The `/integrations/discoveries` endpoint also calls the same checker inline so the sidebar and Integrations page flip amber within one 4 s poll cycle. |
| `monitorAssets` | Every 5 s | Handles four independent cadences per monitored asset: **(1) response-time probe** when `lastMonitorAt + (Asset.monitorIntervalSec ?? monitor.intervalSeconds)` has elapsed (FortiOS REST, SNMP `sysUpTime`, WinRM SOAP Identify, SSH connect+auth, ICMP ping). The `activedirectory` monitor type dispatches to WinRM for Windows or SSH for realm-joined Linux, both reusing the AD integration's bind credentials. Writes one `AssetMonitorSample` per probe (`responseTimeMs` null = packet loss), updates `Asset.monitorStatus` / `lastResponseTimeMs` / `consecutiveFailures`, and emits one `monitor.status_changed` Event on `up ↔ down` transitions (threshold is `monitor.failureThreshold`). **(2) Telemetry pull** when `lastTelemetryAt + (telemetryIntervalSec ?? monitor.telemetryIntervalSeconds)` has elapsed — CPU% + memory snapshot via FortiOS `/api/v2/monitor/system/resource/usage` or SNMP. The SNMP path consults `vendorTelemetryProfiles` for the asset's `manufacturer + os` and queries vendor-specific OIDs first when the profile resolves through `oidRegistry` (i.e. the relevant MIB has been uploaded to Server Settings → Identification → MIB Database). Built-in profiles cover Cisco IOS/IOS-XE/NX-OS (`cpmCPUTotal5secRev`, `ciscoMemoryPoolUsed`+`ciscoMemoryPoolFree`), Juniper Junos (`jnxOperatingCPU`, `jnxOperatingBuffer` %), Mikrotik (`mtxrSystemUserCPULoad`), Fortinet SNMP path (`fgSysCpuUsage`, `fgSysMemUsage`), HP/Aruba ProCurve (`hpSwitchCpuStat`), and Dell (`rlCpuUtilDuringLastMinute`). When a vendor query yields nothing — no profile match, MIB not uploaded, or the device doesn't expose the OID — each metric independently falls back to standard HOST-RESOURCES-MIB (`hrProcessorLoad`, `hrStorageRam`). Also collects temperatures from FortiOS `/api/v2/monitor/system/sensor-info` (filtered to type=temperature) and SNMP ENTITY-SENSOR-MIB (entPhySensorType=8/celsius). Writes one `AssetTelemetrySample` plus N `AssetTemperatureSample` rows. **(3) System info pull** when `lastSystemInfoAt + (systemInfoIntervalSec ?? monitor.systemInfoIntervalSeconds)` has elapsed — interfaces (FortiOS `/monitor/system/interface` + CMDB merge for `alias`/`description`, or SNMP IF-MIB including `ifAlias` for the operator-set label; both paths capture ifInErrors/ifOutErrors and FortiOS errors_in/out) + storage (SNMP HOST-RESOURCES-MIB only) + IPsec tunnels (FortiOS `/monitor/vpn/ipsec` plus a parallel `/cmdb/vpn.ipsec/phase1-interface` lookup that resolves each tunnel's `parentInterface` — the FortiOS CLI `set interface` value used by the System tab to nest tunnel rows under their parent in the Interfaces table; phase-2 selectors are rolled up to a single up/down/partial state per phase-1 with summed byte counters; ADVPN dynamic shortcuts are filtered out by their `parent` field). Writes N `AssetInterfaceSample` rows + M `AssetStorageSample` rows + K `AssetIpsecTunnelSample` rows; also mirrors per-interface IP+MAC into `Asset.associatedIps` (preserving manual entries). **(4) Fast filtered scrape** rides the response-time cadence when the asset has any `monitoredInterfaces`, `monitoredStorage`, or `monitoredIpsecTunnels` pinned (and the full systemInfo pass didn't already run this tick). Calls `collectFastFiltered` which performs one collector round-trip — interfaces + storage on SNMP, interfaces + (conditionally) IPsec on FortiOS — and only writes sample rows for the pinned subset. Storage and IPsec rows ride the same monitorInterval setting (default 60s) so the operator gets sub-minute disk-usage and tunnel-state history for chosen mountpoints / tunnels without re-walking the full tables. ICMP/SSH cannot deliver telemetry/system-info; WinRM/AD return supported=false until WMI Enumerate-over-WS-Management lands. Once a day the job prunes the sample tables (`monitor.sampleRetentionDays` for monitor, `telemetryRetentionDays` for telemetry **and temperatures**, `systemInfoRetentionDays` for interface + storage **and IPsec tunnels**). |

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
- Each asset row's Actions cell renders a per-IP Reserve / Unreserve button (visible to any user-or-above) when the asset has an `ipAddress` and the row's `ipContext` resolves a non-deprecated containing subnet. If `ipContext.reservation` is non-null the button is **Unreserve** — disabled for non-network-admins whose username doesn't match `reservation.createdBy` (with a tooltip naming the owner). If null the button is **Reserve**. The backend re-checks the same rules in `POST /assets/:id/{reserve,unreserve}`; the frontend disable is purely a UX hint.
- Asset edit modal is tab-based (General + Monitoring). The details modal has two tabs by default (General + System) and adds a third **SNMP Walk** tab for admins (admin-only on both the frontend and the backend) — a Base OID input (default `1.3.6.1.2.1.1`), an SNMP credential picker (any stored SNMP credential, not just the asset's monitor credential), a Max-rows input (default 500, capped at 5,000), and a Walk button that posts to `POST /assets/:id/snmp-walk` and renders the returned varbinds in a scrollable OID/Type/Value table with a "Copy results" button. Each walk is audited as an `asset.snmp_walk` Event. The Monitoring tab on the edit modal renders an editable type dropdown for every asset; integration-discovered assets (FMG/FortiGate-discovered firewalls and AD-discovered Windows/Linux hosts) get an extra option representing the integration default (e.g. "FortiManager: \<name\> (default)") plus a hint pointing operators to SNMP for small-branch FortiGates whose REST sensor endpoint 404s. The **System** details tab leads with the monitoring section — status pill, source, last RTT/poll/consecutive failures, and an SVG response-time chart (24h / 7d / 30d / Custom) plus a "Refresh" button for user-or-above (kicks off all three streams — response-time probe, telemetry, system-info — and the toast names exactly which streams refreshed and which failed, e.g. `Refresh partial (probe 12 ms · telemetry) — interfaces: FortiManager direct-mode API token not configured`) — then a horizontal divider, then a single combined CPU+Memory chart (both lines on a shared 0–100% y-axis with one hover tooltip naming both values) over 1h / 24h / 7d / 30d, a Temperatures section (current sensor table — hidden when the device exposes no sensors — with each sensor name clickable to open a per-sensor slide-over chart), an Interfaces table with a "Poll 1m" checkbox column + clickable interface name + cumulative errors column (FortiOS-monitored phase-1 IPsec tunnels are nested under their parent interface as child rows here — orange "IPsec" badge, status pill, remote gateway in the IP column, cumulative in/out bytes; tunnels whose `parentInterface` lookup fails fall into a final "IPsec Tunnels (unbound)" group at the bottom of the same table), and a Storage table (Poll 1m checkbox, mount, used, total, %); empty-state messages render for unmonitored assets, ICMP/SSH-monitored assets, and WinRM/AD-monitored assets (the last is a placeholder until WMI Enumerate-over-WS-Management lands). The Interface column shows the operator-set **alias** as the primary label when present (FortiOS CMDB `alias` / SNMP `ifAlias`), with the real `ifName` rendered as a small subtitle and as the cell tooltip so the operator can still correlate to switch port labels. The Poll 1m checkboxes — interface, storage, and nested tunnel — write to `Asset.monitoredInterfaces` / `monitoredStorage` / `monitoredIpsecTunnels` respectively and pin the row for sub-minute polling on the response-time cadence. Clicking an interface name opens a **nested slide-over** whose header reads `<alias> (<ifName>)` when an alias is set, followed by an **Interface Comments** editor — a 255-char textarea + Save/Revert buttons (assets admin and admin only; everyone else gets a disabled box). Save writes to `AssetInterfaceOverride.description` via `PUT /assets/:id/interfaces/:ifName/comment` and is **Polaris-local only — never pushed to the device**. When no override is set, the device-reported FortiOS CMDB `description` is shown as the textarea placeholder ("Device says: …") so operators can see what's currently surfaced before deciding to type over it. Saving an empty box clears the override and the discovered description shows through again. Auto-refresh ticks don't clobber in-progress edits — the editor tracks a dirty flag and skips repopulation while the user is typing. Below the comment editor the body renders **two charts**: one combined Throughput chart (input + output on a shared bps axis, single tooltip naming both) and an in/out errors-per-interval chart. Clicking a mountpoint name opens a slide-over with a Used vs Total bytes chart and a Used % chart (1h / 24h / 7d / 30d); clicking a tunnel name opens a similar nested slide-over with a status timeline (24h / 7d / 30d) and per-interval throughput charts; clicking a sensor name opens a per-sensor temperature slide-over (24h / 7d / 30d) with axis labels and a chart title. Closing only that panel returns to the asset details panel underneath. All charts share `_wireChartTooltip` for hover behaviour.
- Server Settings → **Credentials** tab manages the stored SNMP / WinRM / SSH credentials (admin-only). Secrets are masked in every GET; resubmitting the mask preserves the stored value on PUT.
- Server Settings → **Identification** tab has a **MIB Database** card (admin-only) for managing SNMP MIB modules. Uploads are validated by `mibService.parseMib` (rejects anything that isn't a real ASN.1/SMI module — including binaries and arbitrary text). The form has a three-tier **Scope** selector: **Manufacturer-wide** (the most common case — covers every model from one vendor), **Device-specific** (overrides the manufacturer-wide MIB for one model only), or **Generic** (shared across all vendors, e.g. SNMPv2-SMI). Resolution priority at probe time is *device → vendor → generic → built-in seed*. The card also renders a **Vendor Profile Status** pill that shows, per built-in profile, whether each profile symbol resolves at the universal (manufacturer-only) scope and which MIB provided it; any model-specific MIBs uploaded under that manufacturer are listed beneath as "Model overrides". Uploads are wired into the SNMP telemetry probe via `oidRegistry` + `vendorTelemetryProfiles`: dropping in CISCO-PROCESS-MIB / CISCO-MEMORY-POOL-MIB / JUNIPER-MIB / MIKROTIK-MIB / FORTINET-FORTIGATE-MIB / etc. immediately starts populating CPU/memory on assets whose `manufacturer` matches the profile's regex. Until the MIB is uploaded the probe falls back to HOST-RESOURCES-MIB (which is null on most network gear).
- Server Settings → **Identification** also has a **Manufacturer Aliases** card (admin-only) — sits between OUI Overrides and the OUI Database card. Lists every alias grouped by canonical name (table columns: Alias, Canonical, Edit/Del). Add form is a two-input row: Alias (the input string to rewrite) + Canonical (the stored value) + Add button. Edit opens a small `openModal` dialog; delete uses `showConfirm`. Every save refreshes the in-memory cache and runs the existing-row backfill in the background, so the change propagates to historical Asset/MibFile rows without a restart. The card also handles the underlying problem the OUI database creates: IEEE registers vendors under their legal name (`Fortinet, Inc.`) while discovery code stamps the marketing name (`Fortinet`), and without normalization they show up as two distinct values in every manufacturer dropdown, MIB scope picker, and vendor profile match.
- Server Settings → **Maintenance** tab (formerly "Database") groups everything operational: capacity grading, in-app updates, database engine info, storage breakdown, backups, restore, and backup history. The first card on the tab is **Capacity** — a status pill (`Healthy` / `Action recommended` / `Critical`) plus a list of reasons with suggestions, then three side-by-side cards for App host (cpu/ram/disk + DB co-located flag), Database (current size, steady-state size, sample-table breakdown with dead-tuple % per table), and Workload (monitored asset count, cadences, retention). Driven by `GET /server-settings/pg-tuning`'s `capacity` payload. Back-compat: `?tab=database` deep links automatically map to `?tab=maintenance`. The sidebar on every page shows a non-dismissible **red** alert when capacity severity is critical (replaces no existing alert — sits above the existing snoozable PG-tuning + RAM-warning alerts).

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/shelob

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

The production instance is updated via the **in-app update mechanism** in **Server Settings → Database**. When pushing changes, the user applies the update through that UI rather than manually redeploying. Keep this in mind when giving deployment advice — do not suggest `git pull` or manual restart steps unless asked.

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
- **Version is automatic.** The patch number is derived at runtime from `git rev-list --count HEAD`. Do not touch `package.json` version for patch increments. Only bump the minor (e.g. `0.9.0` → `0.10.0`) when cutting a named release.

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
