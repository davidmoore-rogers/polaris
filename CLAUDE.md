# Shelob — Claude Code Project

## Project Overview

**Shelob** is an IP management tool that allows users to reserve and manage IP address space (IPv4 and IPv6) for use across other infrastructure projects. Named after Tolkien's great spider — because subnets are webs, and Shelob spins them. It provides a central registry for subnets, individual IPs, and reservations — preventing conflicts and giving teams visibility into IP utilization.

Current version: **0.9.x** (pre-release; patch = git commit count, minor per release). Version is shown in the sidebar and embedded in backup filenames. The patch is derived automatically at startup from `git rev-list --count HEAD` — never bump it manually.

---

## Architecture

```
shelob/
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
│   ├── map.html                     # Fortinet Map page (Leaflet basemap + Cytoscape topology modal)
│   ├── css/
│   │   ├── styles.css
│   │   ├── map.css                  # Fortinet Map styles (marker icons, topology modal grid)
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
│       ├── map.js                   # Fortinet Map: Leaflet markers, autocomplete search, Cytoscape topology modal
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
│   │       ├── map.ts               # Fortinet Map: site list, search, per-FortiGate topology graph
│   │       ├── events.ts            # Audit log, syslog, SFTP archival
│   │       ├── conflicts.ts         # Discovery conflict review & resolution
│   │       ├── search.ts            # Global typeahead search across all entity types
│   │       ├── allocationTemplates.ts # CRUD for saved multi-subnet allocation templates
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
│   │   └── updateService.ts         # Software update checking
│   ├── jobs/
│   │   ├── expireReservations.ts    # Mark past-TTL reservations as expired (every 15 min)
│   │   ├── discoveryScheduler.ts    # FMG/Windows Server auto-discovery polling
│   │   ├── discoverySlowCheck.ts    # 30s tick: flag in-flight discoveries that exceed their rolling-duration baseline
│   │   ├── ouiRefresh.ts            # Refresh IEEE OUI database
│   │   ├── pruneEvents.ts           # 7-day event log retention (nightly)
│   │   ├── updateCheck.ts           # Software update notifications
│   │   ├── clampAssetAcquiredAt.ts  # One-shot startup fix: clamp acquiredAt to lastSeen
│   │   └── decommissionStaleAssets.ts # Every 24h: decommission assets not seen in N months
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
| Graph layout | Cytoscape.js + dagre + cytoscape-dagre (bundled under `public/js/vendor/`) for the Fortinet Map topology modal |
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
  latitude        Float?          -- FortiGate geo coord from `config system global` (decimal degrees); drives Fortinet Map pins
  longitude       Float?
  fortinetTopology Json?           -- { role: "fortigate" | "fortiswitch" | "fortiap", controllerFortigate?, uplinkInterface?, parentSwitch?, parentPort?, parentVlan? } — real connection graph from FMG/FortiGate discovery
  acquiredAt      DateTime?
  warrantyExpiry  DateTime?
  purchaseOrder   String?
  notes           String?
  tags            String[]
  createdBy       String?

AssetIpHistory                  -- Auto-populated log of every IP each asset has held
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  ip            String
  source        String          -- "manual", "fortimanager", "fortigate", "dns", etc.
  firstSeen     DateTime
  lastSeen      DateTime
  @@unique([assetId, ip])       -- one row per (asset, ip); lastSeen and source update on re-sighting

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

### Fortinet Map — `requireAuth`
- `GET    /map/sites`                           — Every firewall Asset with non-null lat/lng. Includes subnet count (via `Subnet.fortigateDevice` match) and last-seen status. Sidebar page entry: "Fortinet Map" (below Dashboard).
- `GET    /map/search?q=<query>`                — Autocomplete over firewall hostnames + serials, capped at 12. Only returns sites that have coordinates (a pinless FortiGate can't be navigated to).
- `GET    /map/sites/:id/topology`              — Graph payload for the click-through modal. Returns `{ fortigate, switches[], aps[], subnets[], edges[] }`. Every edge id references a node in the same payload. FortiGate→Switch edges are derived from `Asset.fortinetTopology.uplinkInterface` (the FortiLink interface from `managed-switch/status.fgt_peer_intf_name`). AP→Switch edges come from `switch-controller/detected-device` MAC learnings matched against AP base_mac during discovery; APs with no peer switch fall back to a direct FortiGate→AP edge.

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

**Per-device transport (`useProxy` toggle):** The FMG integration has two per-device query transports, selectable in the integration edit modal:
- **Proxy mode** (default, `useProxy: true`): all per-device queries funnel through FMG's `/sys/proxy/json` (monitor endpoints) and `/pm/config/device/<name>/...` (CMDB). Parallelism is force-clamped to 1 because FMG drops parallel connections past very low parallelism, surfacing as `fetch failed` on random calls.
- **Direct mode** (`useProxy: false`): FMG is only used to enumerate the managed FortiGate roster; per-device calls go direct to each FortiGate's management IP (the `ip` field on the FMG `/dvmdb/adom/<adom>/device` response) using shared REST API credentials stored in `config.fortigateApiUser` / `config.fortigateApiToken`. Each managed FortiGate must have the same REST API admin provisioned with a trusthost that includes Shelob. Delegates per-device work to `fortigateService.discoverDhcpSubnets` and remaps the device name back to FMG's label. Unlocks `discoveryParallelism` (up to 20).

---

## FMG Discovery Workflow

`fortimanagerService.ts` connects to FortiManager via JSON-RPC and discovers:

- **DHCP scopes** → Subnet records (`discoveredBy`, `fortigateDevice`)
- **DHCP reservations** → Reservations (`sourceType: dhcp_reservation`)
- **DHCP leases** → Reservations (`sourceType: dhcp_lease`); captures `expire_time`, `access_point`, `ssid`
- **Interface IPs** → Reservations (`sourceType: interface_ip`)
- **Virtual IPs (VIPs)** → Reservations (`sourceType: vip`)
- **FortiSwitch devices** → Asset records (`assetType: switch`); via FMG proxy to `/api/v2/monitor/switch-controller/managed-switch/status`. `fortinetTopology` stamped with `{ role: "fortiswitch", controllerFortigate, uplinkInterface }` so the Fortinet Map renders the FortiLink uplink as an edge.
- **FortiAP devices** → Asset records (`assetType: access_point`); via FMG proxy to `/api/v2/monitor/wifi/managed_ap`. `fortinetTopology` stamped with `{ role: "fortiap", controllerFortigate, parentSwitch, parentPort, parentVlan }`; the switch-port attribution comes from matching AP `base_mac` against `/api/v2/monitor/switch-controller/detected-device` during discovery (falls back to a direct FortiGate edge if the AP's MAC is not on any managed switch port).
- **FortiGate geo coordinates** → `Asset.latitude` / `Asset.longitude` on the firewall Asset, pulled from `/api/v2/cmdb/system/global` (`longitude`, `latitude` fields of `config system global`). Feeds the Fortinet Map. Discovery silently skips this step on FortiOS versions that don't expose the fields — existing coords are never blanked.
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
| `decommissionStaleAssets` | Every 24 hours | Move assets whose `lastSeen` is older than the configured inactivity threshold (months) to `decommissioned` status. Configured via Events → Settings → Assets tab; 0 disables. |
| `discoverySlowCheck` | Every 30 s | Compares each in-flight discovery's elapsed time to its rolling-duration baseline (`discoveryDurationService`). Emits one `integration.discover.slow` event per run (and one per FortiGate inside an FMG run) when elapsed exceeds `max(avg + 2σ, avg × 1.5, avg + 60 s)`; baseline requires ≥3 prior successful runs. The `/integrations/discoveries` endpoint also calls the same checker inline so the sidebar and Integrations page flip amber within one 4 s poll cycle. |

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
