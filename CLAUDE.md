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
│   └── audit-multi-mac-assets.mjs   # One-off: unstitch assets cross-stapled by old IP-fallback bug
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
│   ├── css/styles.css
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
│       ├── table-sf.js
│       └── vendor/
├── src/
│   ├── index.ts                     # Entry point
│   ├── config.ts                    # App config / env vars
│   ├── db.ts                        # Prisma client singleton
│   ├── httpsManager.ts              # TLS certificate management
│   ├── api/
│   │   ├── router.ts                # Express router aggregator + auth guards
│   │   ├── middleware/
│   │   │   ├── auth.ts              # Session auth + RBAC middleware
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
│   │       ├── events.ts            # Audit log, syslog, SFTP archival
│   │       ├── conflicts.ts         # Discovery conflict review & resolution
│   │       ├── search.ts            # Global typeahead search across all entity types
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
│   │   ├── searchService.ts         # Global typeahead search (classifies IP/CIDR/MAC/text; parallel entity queries)
│   │   ├── azureAuthService.ts      # Azure AD/Entra SAML SSO, user provisioning
│   │   ├── dnsService.ts            # Reverse DNS lookup for assets
│   │   ├── ouiService.ts            # MAC OUI lookup with admin overrides
│   │   ├── eventArchiveService.ts   # Syslog (CEF) + SFTP/SCP event archival
│   │   ├── serverSettingsService.ts # HTTPS, branding, backup/restore
│   │   └── updateService.ts         # Software update checking
│   ├── jobs/
│   │   ├── expireReservations.ts    # Mark past-TTL reservations as expired (every 15 min)
│   │   ├── discoveryScheduler.ts    # FMG/Windows Server auto-discovery polling
│   │   ├── ouiRefresh.ts            # Refresh IEEE OUI database
│   │   ├── pruneEvents.ts           # 7-day event log retention (nightly)
│   │   ├── updateCheck.ts           # Software update notifications
│   │   ├── clampAssetAcquiredAt.ts  # One-shot startup fix: clamp acquiredAt to lastSeen
│   │   └── decommissionStaleAssets.ts # Every 24h: decommission assets not seen in N months
│   ├── setup/
│   │   ├── setupRoutes.ts           # First-run setup wizard routes
│   │   ├── setupServer.ts           # Setup server initialization
│   │   └── detectSetup.ts           # Detects if initial setup is complete
│   ├── models/
│   │   └── types.ts                 # Shared TypeScript interfaces
│   └── utils/
│       ├── cidr.ts                  # CIDR parsing, contains(), overlap()
│       ├── errors.ts                # AppError class with httpStatus
│       ├── logger.ts                # Structured logging (pino)
│       └── assetInvariants.ts       # Write-time clamp: acquiredAt <= lastSeen
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
| Auth | bcrypt (local), @node-saml/node-saml (Azure SAML SSO) |
| IP Math | ip-cidr + netmask + cidr-tools |
| Security | helmet, express-rate-limit |
| File uploads | multer |
| PDF export | jspdf + jspdf-autotable |
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
AssetStatus:             active | maintenance | decommissioned | storage
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
  macAddress      String?         -- Most recently seen MAC
  macAddresses    Json            -- [{mac, lastSeen, source?}] — full MAC history
  hostname        String?
  dnsName         String?         -- FQDN
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
  associatedIps   Json            -- [{ip, interfaceName?, source?, lastSeen?}] — additional IPs; source="manual" preserved across discovery
  associatedUsers Json            -- [{user, domain?, lastSeen, source?}]
  acquiredAt      DateTime?
  warrantyExpiry  DateTime?
  purchaseOrder   String?
  notes           String?
  tags            String[]
  createdBy       String?

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

### Integrations — `requireNetworkAdmin`
- `GET    /integrations`
- `POST   /integrations`
- `GET    /integrations/:id`
- `PUT    /integrations/:id`
- `DELETE /integrations/:id`
- `POST   /integrations/:id/test-connection`
- `POST   /integrations/:id/discover`           — Trigger full discovery run
- `GET    /integrations/:id/discovery-status`   — Poll in-progress discovery
- `POST   /integrations/:id/abort-discovery`

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
- `DELETE /assets/:id/macs/:mac`                — Remove one MAC from an asset's history (requires network admin)

### Events — `requireAuth`
- `GET    /events`                              — Audit log (filter by level, action, resourceType)
- `GET    /events/archive-settings`
- `PUT    /events/archive-settings`
- `POST   /events/archive-test`
- `GET    /events/syslog-settings`
- `PUT    /events/syslog-settings`
- `POST   /events/syslog-test`
- `GET    /events/asset-decommission-settings`
- `PUT    /events/asset-decommission-settings` — `{ inactivityMonths }`; 0 disables auto-decommission

### Conflicts — `requireAuth` (role-scoped list + resolve)
- `GET    /conflicts`                           — List. Role-filtered: admin sees all; networkadmin sees reservation conflicts only; assetsadmin sees asset conflicts only; others see empty list.
- `GET    /conflicts/count`                     — Badge count; same role scoping as the list.
- `POST   /conflicts/:id/accept`                — Reservation: apply discovered values. Asset: set existing asset's `assetTag` to `entra:{deviceId}` and overlay Entra/Intune fields (only into empty existing fields). 403 if caller's role doesn't cover this conflict's entityType.
- `POST   /conflicts/:id/reject`                — Reservation: keep existing, dismiss. Asset: create a separate new Asset with the Entra snapshot + assetTag `entra:{deviceId}` so the next discovery run finds it by tag and doesn't re-fire the collision.

### Search — `requireAuth`
- `GET    /search?q=<query>`                    — Global typeahead. Classifies input (IP, CIDR, MAC, or text), runs 4 parallel entity queries, returns grouped results (`blocks`, `subnets`, `reservations`, `assets`, `ips`) capped at 8 per group. The `ips` hit resolves the containing subnet and any active reservation. All authenticated roles can search; front-end edit modals render in view-only mode for users without write permission.

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
| `networkadmin` | Integrations, conflicts + all `requireAuth` routes |
| `assetsadmin` | Assets + all `requireAuth` routes |
| `user` | All `requireAuth` routes |
| `readonly` | Read-only on `requireAuth` routes |

Rate limiting: 10 login attempts / 15 min per IP.

Azure SAML SSO is optional; users are auto-provisioned on first login with a default role.

**FMG auth note:** FortiManager 7.4.7+ / 7.6.2+ removed `access_token` query string support. The service uses the Bearer `Authorization` header exclusively. The standalone FortiGate integration (`fortigateService.ts`) uses the same Bearer header pattern against a REST API Admin token.

---

## FMG Discovery Workflow

`fortimanagerService.ts` connects to FortiManager via JSON-RPC and discovers:

- **DHCP scopes** → Subnet records (`discoveredBy`, `fortigateDevice`)
- **DHCP reservations** → Reservations (`sourceType: dhcp_reservation`)
- **DHCP leases** → Reservations (`sourceType: dhcp_lease`); captures `expire_time`, `access_point`, `ssid`
- **Interface IPs** → Reservations (`sourceType: interface_ip`)
- **Virtual IPs (VIPs)** → Reservations (`sourceType: vip`)
- **FortiSwitch devices** → Asset records (`assetType: switch`); via FMG proxy to `/api/v2/monitor/switch-controller/managed-switch/status`
- **FortiAP devices** → Asset records (`assetType: access_point`); via FMG proxy to `/api/v2/monitor/wifi/managed_ap`
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
- **Re-discovery** — Assets are matched first by that prefixed assetTag. If no match but the hostname collides with an existing asset that has no assetTag, a `Conflict` (entityType `"asset"`, deduped on `proposedDeviceId`) is created for admin/assetsadmin review. The slide-over panel on the Events page renders a side-by-side comparison; **Accept** adopts the existing asset (writes the Entra assetTag + fills empty fields from the snapshot), **Reject** creates a separate asset with the Entra tag so future runs find it by tag.
- **Asset type** — inferred from Intune `chassisType` (`desktop/laptop/convertible/detachable` → `workstation`; `tablet/phone` → `other`); Entra-only devices default to `workstation`. Admins can recategorize via the asset edit UI; re-discovery only overwrites `assetType` if it is still `other`.
- **User** — Intune `userPrincipalName` → `Asset.assignedTo`. Entra-only runs do not populate this field.
- **Filters** — `deviceInclude` / `deviceExclude` arrays match against `displayName` with wildcard support (`LAPTOP-*`, `*-lab`).

---

## Background Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `expireReservations` | Every 15 min | Mark reservations past `expiresAt` as `expired` |
| `discoveryScheduler` | Per-integration `pollInterval` | Auto-trigger FMG / FortiGate / Windows Server / Entra ID discovery |
| `ouiRefresh` | Periodic | Refresh IEEE OUI database for MAC vendor lookup |
| `pruneEvents` | Nightly | Delete Event records older than 7 days |
| `updateCheck` | Periodic | Check for software updates |
| `clampAssetAcquiredAt` | Once at startup | Clamp `acquiredAt` down to `lastSeen` on any Asset row where the invariant was violated |
| `decommissionStaleAssets` | Every 24 hours | Move assets whose `lastSeen` is older than the configured inactivity threshold (months) to `decommissioned` status. Configured via Events → Settings → Assets tab; 0 disables. |

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

# Session
SESSION_SECRET=changeme

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
