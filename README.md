# Polaris

A network management tool. Auto-discovery from FortiManager / FortiGate / Windows DHCP / Entra ID / Active Directory / VMware vCenter / Azure Arc, to build out IPv4/IPv6 networks, asset inventories and device maps. Made specifically with Fortinet network devices in mind, monitors devices over FortiOS REST and SNMP (response time, telemetry, system info, LLDP topology), maps managed FortiGates with their FortiSwitch/FortiAP/LLDP topology, push DHCP reservations and DHCP lease revocation as well as pushes asset quarantine to FortiGates.

## Features

### IP management
- **Blocks, subnets, reservations** with conflict detection, VLAN tagging, next-available allocation, and per-block / per-subnet utilization.
- **Bulk site allocation** — save a multi-subnet template (e.g. `Hardware /25`, `Users /25`, `Voice /26`, plus `skip` entries to leave gaps) and stamp it out for each site. Allocations are anchor-aligned (default `/24`, per-user) and all-or-nothing inside one transaction.
- **Stale reservation alerts** — DHCP reservations whose target client hasn't actively held the IP within a configurable window surface in a sidebar badge with snooze / permanent-ignore controls.
- **Global typeahead search** — the header search classifies IP / CIDR / MAC / text and returns blocks, subnets, reservations, assets, and individual IPs in one dropdown. Scope prefixes (`block:` / `b:`, `network:` / `n:`, `asset:` / `a:`, `reservation:` / `r:`, `map:` / `m:`) constrain the search to one group and lift the default 8-per-group cap to 200 results.

### Asset inventory & discovery
- **Assets** — servers, switches, firewalls, APs, workstations with full MAC history, serials, warranty/procurement info, OS, IP source tracking, location, and status changes attributed to who set them and when.
- **FortiManager / FortiGate** — DHCP scopes, static reservations, live leases, interface IPs, VIPs (including load-balance virtual servers with their realserver pools), managed FortiSwitches, managed FortiAPs, and FortiGate inventory. Per-device transport is selectable: query each FortiGate directly (parallel, scalable) or proxy every call through FortiManager (serial, simpler firewall posture). Optional location geocoding auto-resolves Device Map pin locations — from the FortiGate's SNMP sysLocation (via FortiOS REST) or a FortiManager per-device address metavariable — and can write the resolved coords back to the FortiGate's `gui-device-*` CMDB fields and FMG coordinate metavars (metavar names are configurable; default `Latitude` / `Longitude`). The learned street address is surfaced on the asset's General tab.
- **Windows Server** — DHCP scopes via WinRM.
- **Microsoft Entra ID / Intune** — registered devices via Microsoft Graph, optionally enriched with Intune managed-device data (serial, MAC, manufacturer, model, primary user, compliance).
- **Active Directory** — on-prem computer objects via LDAP/LDAPS simple bind. Hybrid-joined devices are cross-linked to Entra by SID so the same machine never appears twice.
- **VMware vCenter** — virtual machines, ESXi hosts and datastores via the vSphere Automation REST API. VMs link to the host they run on and gain a vMotion-safe host dependency; per-VM CPU/RAM comes from the hypervisor with no in-guest agent.
- **Azure Arc** — Arc-enabled servers via Azure Resource Manager. The Connected Machine agent runs inside the guest, so hostname, running OS edition and SMBIOS serial come from the machine itself rather than from a directory record that can lag months. Optional extras: Arc-enabled VMware/SCVMM placement (which also matches machines against an existing vCenter integration so they don't appear twice), Arc-enabled SQL Server instances, and Arc-enabled Kubernetes clusters.
- **Conflict resolution** — discovery values that differ from an existing manual record become `Conflict` records for admin review. Asset conflicts cover hostname matches, NetBIOS-truncated matches, MAC collisions, and duplicate Entra/AD registrations; reservation conflicts cover sourceType/owner/notes drift.
- **Per-source asset view** — every integration that observes a device writes its own `AssetSource` row (Entra, Intune, AD, Azure Arc, fortigate-firewall, fortiswitch, fortiap, fortigate-endpoint, vcenter-vm, vcenter-host). The asset details modal has a **Sources** tab that renders each source's raw observation side-by-side, so operators can see what each integration independently said about the device. Admins can **Split** a source onto a freshly-created Asset when matching went wrong — useful when Entra and AD got correlated through a stale SID or a hostname collision auto-resolved badly.
- **Saved filters & view tabs** — any combination of column filters + sort on the assets table can be saved as a named preset, kept **private** or published **public** for everyone who can view assets. The page also carries per-user **tabs**, each holding its own filters, so several views stay open side by side; tabs are renameable, a preset can be opened straight into a new tab, and both presets and tabs are stored server-side so they follow the operator across browsers.
- **Discovery filters** — wildcard device-name include/exclude on FortiGate inventory, OU include/exclude on AD, name patterns on Entra, VM-name patterns on vCenter, and subscription / resource-group / machine-name / Azure-tag filters on Arc.
- **DNS resolution** — per-asset reverse PTR and forward A/AAAA lookups using the configured resolver (system, DoH, or DoT). Results are TTL-cached so repeated discovery doesn't hammer DNS.

### Monitoring
Asset monitoring runs on three independent collection cadences (sample retention is configured separately, per data entity, on the Server Settings → Retention card):

- **Response-time probe** (default 60 s) — FortiOS REST, SNMP `sysUpTime`, WinRM SOAP, SSH connect+auth, an **HTTP check** (one GET against a path you choose, judged on the status code and optionally on a string the response body must contain), ICMP, or **Polaris Agent**. Records round-trip time on success and `null` on failure ("packet loss"). The first miss puts the asset in `warning`; it is declared **down** once `failureThreshold` consecutive probes have missed (default 3). There is no separate confirmation cadence — every miss after the first waits a full poll interval, so time-to-down is `interval × (threshold − 1)` plus the probe timeout, and lengthening the interval lengthens detection in step with it. The monitor-settings cards state that outright as a derived **"Declare Down after (seconds)"** field, so you can set the figure you actually care about and let Polaris solve for the threshold. Recovery is symmetric: the asset sits in `recovering` until the same number of consecutive successes lands. An asset whose dependency parent is down is polled at half rate rather than harder. Down/up transitions emit audit events and drive the sidebar status pill.
- **Telemetry** (default 60 s) — CPU, memory, and the full hardware-sensor table (temperature, fan, voltage, transceiver bias current and optical power, PSU). Vendor-specific SNMP profiles ship for Cisco, Juniper, Mikrotik, Fortinet, HP/Aruba, and Dell, falling back to HOST-RESOURCES-MIB and ENTITY-SENSOR-MIB.
- **System info** (default 600 s) — interfaces (with `ifAlias` / FortiOS CMDB description, error counters, IP/MAC), storage mountpoints, IPsec phase-1 tunnels (with phase-2 rollup and parent-interface nesting), and LLDP neighbors. LLDP rows are matched back to Polaris assets by management IP, chassis MAC, or system name, so the topology graph can show a clickable cross-link.

Operators can pin specific interfaces, mountpoints, or IPsec tunnels for **sub-minute polling** without re-walking the full table, and pinned entities keep full tiered history. Unpinned mountpoints and IPsec tunnels are still sampled on the slow tier and retained 24 h; an **unpinned interface is not sampled at all** — its current state (status, speed, counters, IP/MAC, VLAN) is kept in a live inventory table instead, so it has no chart until you pin it. Pinning is therefore also what makes an interface alertable. Each FMG/FortiGate integration carries per-stream **REST ↔ SNMP toggles** (response time, telemetry, interfaces, LLDP) so branch-class FortiGates whose REST sensor endpoints 404 on FortiOS 7.4.x can be moved to SNMP one stream at a time. Per-asset overrides take precedence when set.

The asset details panel renders charts for response time, CPU/memory, temperature per sensor, per-interface throughput + errors, mountpoint usage, and IPsec status timeline + bytes. Admin operators also get an **SNMP Walk** tab for ad-hoc OID exploration on assets with SNMP configured for at least one monitoring stream.

**Polaris Agent (optional)** — a small Go binary you can install on Linux / macOS / Windows hosts (amd64 + arm64) via stored SSH or WinRM credentials. The agent pushes monitoring samples back to Polaris over HTTPS with a pinned-leaf TLS handshake; an outbound WebSocket also stays open for on-demand probe-now. Useful for hosts behind NAT, hosts without a working SNMP/WinRM probe surface, and generic Windows/Linux endpoints. Install + uninstall + force-remove are all driven from the asset details modal. See `docs/INSTALL.md` → "Optional: Polaris Agent."

**Publishing the onboarding script (optional).** Rather than downloading the script and pushing it yourself, Polaris can deliver it through the two Azure vehicles it already holds credentials for. Both are **off by default** behind a checkbox on their own integration's *Script Publishing* tab, because each needs an additional vendor-side grant that the read-only discovery credential deliberately lacks.

- **Intune** (Windows) — uploads the remediation + detection pair as a Remediation. Needs the Graph application permission `DeviceManagementConfiguration.ReadWrite.All` with admin consent. **Polaris never assigns the policy**: it arrives targeting nothing, and you pick the device groups in Intune after reading the script.
- **Azure Arc** (Windows *and* Linux, including Windows Server — neither of which Intune reaches) — runs the script on machines you select, via Run Command. Needs an Azure **RBAC role assignment** carrying `Microsoft.HybridCompute/machines/runCommands/write` (e.g. Azure Connected Machine Resource Administrator), not a Graph permission. A run command **executes immediately** — there is no unassigned state, so your selection is the review step; Polaris only ever targets machines you explicitly tick, caps a run at 200, and skips any machine whose OS Arc doesn't report rather than guessing which script to send.

**SSH deployment with key auth** — Integrations → Polaris Agent → **SSH Deployment** generates the deployment keypair, keeps the private half sealed (never displayed or downloadable), and emits the onboarding script that authorizes the public half across a Windows or Linux fleet. That takes a reusable administrator password off the wire, and gets right the details that otherwise fail *silently*: on Windows the `administrators_authorized_keys` path and its ACL, on Linux the `~/.ssh` ownership, SELinux context, and the passwordless-sudo drop-in the agent installer requires. The scripts carry no machine-specific values, so the same file runs unchanged under Intune, GPO, Configuration Manager, Arc, Ansible, an RMM tool, or by hand; a paired detection script makes the rollout self-healing. SSH credentials also gain opt-in **host-key verification** (trust-on-first-use pinning) and support for passphrase-protected keys.

### Device Map
A Leaflet basemap pinned with every FortiGate that has geo coordinates configured on the device. Pin color reflects monitor health (green / amber / red / gray). Clicking a pin opens a Cytoscape topology modal showing the FortiGate, its managed FortiSwitches and FortiAPs, its discovered subnets, and any LLDP-observed neighbors that aren't part of the managed fleet. Header search autocompletes hostnames and serials; site-scoped search inside the modal pulses the matched switch and pivots to endpoint asset details on click.

The graph stitches edges from three independent signals: controller-derived FortiLink/AP→switch edges (authoritative from the FortiGate's own state), inferred edges from FortiOS interface naming conventions for FortiLink-aggregate and operator-named MCLAG pairs (so peer links the controller hierarchy doesn't model still render), and dashed orange LLDP edges for everything else. Cross-site Polaris assets matched via LLDP appear as solid-blue-bordered remote-asset nodes that pivot to the asset details page; LLDP neighbors that don't resolve to a Polaris asset appear as dashed-bordered ghost nodes. Operators can upload custom **device icons** (PNG / JPEG / WebP, 256 KB cap, manufacturer or manufacturer+model scoped) that override the generic node shapes per asset. Node positions are persisted per site so layout edits survive reload.

Admins and network admins can draw named **regions** on the map. Each region's name becomes a `region:<name>` tag stamped on every enclosed FortiGate plus its managed FortiSwitches and FortiAPs, so the assets-page tag column / search / filter can act on "everything in Atlanta" without anyone maintaining the membership list by hand. Polygons render only while editing — the default map view is unchanged.

### Dash wallboard
An optional no-login, read-only duplicate of the Dashboard at `/dash` for NOC wallboards and kiosks, served by its own isolated process. Off by default; an admin enables it under Server Settings → Web Server → Dash Wallboard and chooses the source-IP scope (RFC1918 + loopback, all IPs, or a custom CIDR allow-list); requests from disallowed sources are silently dropped. It answers with the built-in read-only role's permissions — widgets that role can't read hide themselves — and each viewer's widget layout is saved in their own browser, so a wallboard can be arranged without an account.

### MAC Quarantine
Polaris records which FortiGate every asset has been sighted on via DHCP. From the asset details panel (or via API token from a SIEM), an operator can quarantine a device — the asset's MACs are pushed as MAC-based address-group entries to every FortiGate that sighted the device within the configured window, after which the device's status flips to `quarantined`.

- **Drift detection** runs the FortiGate-side state back through verify on demand and during the next discovery cycle.
- **Auto-quarantine** re-fires when a quarantined device shows up on a new FortiGate.
- **Release** is best-effort: device-side failures don't block the Polaris release so an offline FortiGate doesn't trap an operator.
- **Infrastructure assets** (firewalls, switches, APs) cannot be quarantined — quarantining the device that does the quarantining would lock the operator out of the network.
- **Bulk operations** are wired through both the asset list and the API.
- **The verbs are hidden until push is enabled somewhere** — with the per-integration Quarantine Push toggle off on every enabled Fortinet integration there is no FortiGate to push to, so the row menu, bulk bar and details tab withhold Quarantine rather than offer a button that can only fail. Release always stays available, so a device quarantined before the toggle was switched off can still be let out.

### DHCP push to FortiGate
When the FMG/FortiGate integration's **DHCP Push** toggle is on, manual reservations created in Polaris are written to the originating FortiGate at create time, with read-back verify. **Transient device-side failures** (FortiGate offline, FMG unreachable, network timeout) keep the Polaris row in a `"pending"` state and a 60s retry job + `monitor.status_changed → up` recovery hook drive it to `synced` once the gate is reachable again — the operator's claim on the IP survives an outage. **Permanent failures** (4xx, verify mismatch, auth) still abort-and-rollback the create. Queued reservations are surfaced in the Events page Alerts panel's **Push queue** filter, in the single Events sidebar alert dot, and as an amber "Queued for push" badge on the IP panel with a per-row **Retry** button. The same toggle gates **lease release**: freeing a discovered DHCP lease tells FortiOS to forget it. Release-time unpush is best-effort and audits both success and orphan-on-device cases.

A managed FortiSwitch or FortiAP on a FortiLink pool holds its address by *dynamic lease*, so the FortiGate reports it "Not Reserved" even though Polaris shows a reservation for it — the reservation records who owns the address, not that the gate has pinned it. The IP panel distinguishes the two (a lease-backed managed device reads "FortiAP (lease)" and offers **Reserve**), and the optional **Also reserve discovered FortiSwitch and FortiAP addresses on their gate** toggle, nested under DHCP Push and off by default, does it for the whole fleet: each discovery cycle a bounded number of those devices get a real MAC→IP entry written on their own gate, pinning an address they already hold — so pool occupancy doesn't change. The MAC comes only from the gate's own lease table, every write is verified by read-back, a gate that refuses is recorded rather than retried, and decommissioning or deleting the device removes the entry again. It is the only DHCP write Polaris makes on a schedule rather than in response to an operator, so enable it on one integration and check a single gate first.

### Quarantine push
A separate FMG integration toggle gates whether quarantine pushes target this integration's FortiGates. Off by default; pairs with the per-API-token integration scoping so an external caller can only reach the FortiGates it's been authorized for. While it is off everywhere, the UI offers no quarantine verbs at all (see MAC Quarantine above).

### MIB Database
Admin-uploaded SNMP MIB modules drive vendor-specific telemetry. Uploads are validated by a minimal SMI parser (real ASN.1 modules only — binaries and arbitrary text are rejected) and scoped three ways: **Manufacturer-wide** (the common case), **Device-specific** (overrides one model), or **Generic** (shared across vendors). Resolution priority at probe time is *device → vendor → generic → built-in seed*. The MIB Database card shows live **Vendor Profile Status** so an admin can see which built-in profile symbols resolve and which MIB provided each. Each row has a **Browse** button (open to admin and assets-admin) that opens a two-pane modal listing every object the MIB defines — Tables and Scalars / Other — with type, access, and description for each, plus a **Walk on asset…** pivot that picks an SNMP credential and runs the walk against any asset, returning symbolic names with decoded INTEGER enums (`up(1)` instead of `1`) and 2D table rendering when the walk lands on a SMI table.

### Manufacturer aliases
A built-in alias map collapses IEEE legal forms (`Fortinet, Inc.`) into marketing names (`Fortinet`) consistently across asset rows, MIB scoping, and vendor-profile matching. Ships ~25 default mappings; admins extend the map and existing rows are backfilled in the background.

### Capacity grading
Server Settings → Maintenance shows host CPU/RAM/disk, database size with sample-table breakdown and dead-tuple ratios, monitoring workload (asset count, pinned-interface count incl. IPsec tunnels, pinned storage-mount count, cadences, retention), and a steady-state size projection. Critical conditions (disk free <10%, projected DB > 8× host RAM, autovacuum stale on a populated *and bloated* table) drive a non-dismissible sidebar alert; amber and watch conditions render as card-only reason rows.

### Authentication & RBAC
- **Local accounts** — argon2id-hashed passwords with strength rules and per-account temporary lockout.
- **TOTP second factor** — RFC 6238 enrollment via QR code, single-use backup codes, admin reset for lost devices. Local accounts enroll themselves from the account menu behind the page-header user badge, on any page — no admin involvement and no Users-page access needed.
- **Azure SAML SSO** — auto-provisioning, single logout, optional skip-login-page redirect.
- **OIDC, LDAP/AD, and Entra App Proxy SSO** — OpenID Connect (Auth-Code + PKCE), LDAP/Active Directory bind login, and header-based SSO for installs published through Microsoft Entra Application Proxy (source-IP-gated, unsigned-header trust model). IdP groups map to roles + region/other tags via Group Mappings (highest-privilege wins).
- **Local login access** — optionally restrict the local login form (`/login.html`) and the password endpoints to chosen source networks (RFC1918 + loopback, all, or a custom CIDR allow-list), under Server Settings → Web Server → Local Login Access. Off by default. SSO sign-in is never restricted; the local *and* LDAP password path is. Disallowed page requests are dropped and credential posts get the same generic 401 a wrong password does. Enabling it is refused if it would exclude your own address, since `/login.html` is how you get back in when the identity provider is down.
- **Roles** — Admin, Network Admin, Assets Admin, User, Read-Only. Network and asset surfaces are role-scoped; users own the records they create.
- **API tokens** — long-lived bearer tokens for external callers (e.g. SIEM-driven quarantine, NOC kiosks, read-only inventory consumers). Each token is bound to a role at creation and acts with exactly that role's permissions; per-token integration scoping is required when the role can push quarantine. The raw token is shown once at creation and only the argon2 hash is stored.

### Audit & operations
- **Event log** with syslog (CEF) forwarding, SFTP/SCP archival, configurable retention.
- **HTTPS** with built-in cert management (TLS 1.2+, AEAD-only).
- **Helmet CSP / HSTS / CSRF** synchronizer-token (`polaris_csrf` cookie + `X-CSRF-Token` header).
- **Encrypted backups** with versioned magic header (`POLARIS\0`), retained on disk and surfaced for in-app restore.
- **In-app updates** from Server Settings → Maintenance, with automatic rollback if any step fails.
- **PDF / CSV export** for assets, networks, events, and IP panel data.
- **Prometheus `/metrics` + Grafana dashboard** — every `polaris_*` metric (monitor pass + work duration, probe latency by transport, FMG dual-lane worker, DB pool, capacity severity, discovery phases, sample rollups, HTTP, job health) graphed in `docs/grafana/polaris-monitoring-dashboard.json`. Bearer-token gated via `METRICS_TOKEN`. See `docs/INSTALL.md` → "Optional: Prometheus + Grafana."

## System requirements

| Resource | Minimum (<50 devices) | Recommended (200+ devices, 200K+ reservations) |
|----------|----------------------|-----------------------------------------------|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| DB data volume | 50 GB SSD | 100 GB+ SSD |
| App / state volume | 5 GB | 20 GB |
| OS | Windows Server 2019+, RHEL 9, Ubuntu 22.04+ | Windows Server 2022, RHEL 9, Ubuntu 22.04+ |
| PostgreSQL | 15+ | 15+ |
| Node.js | 20 LTS | 20 LTS |

Discovery pre-loads subnets, reservations, and assets for O(1) lookups; peak memory is ~200–400 MB on top of the Node.js base. Monitoring sample tables grow proportionally with monitored asset count × cadence × retention; the Capacity card on Server Settings → Maintenance projects this at runtime. The **DB data volume** (where PostgreSQL stores its `data_directory`) is the number that matters most — Postgres degrades hard when its volume hits 100%. See [docs/INSTALL.md](docs/INSTALL.md) → "Disk sizing — read this first" for the authoritative per-volume sizing table and platform-specific data-directory paths.

**PostgreSQL tuning for large deployments**: open Server Settings → Maintenance → **Capacity Advisor** after the host has been monitoring for ~15 minutes. It computes recommended values for `shared_buffers` / `work_mem` / `effective_cache_size` / `random_page_cost` / `max_connections` based on observed workload, host RAM, and connection peak, then surfaces them alongside Polaris's own pool and worker tunables. For headless installs, see `docs/INSTALL.md` → "Capacity tuning — use the Capacity Advisor."

## Quick start (development)

1. **Install PostgreSQL 15+** and create the database:

   ```sql
   CREATE USER polaris WITH PASSWORD 'polaris';
   CREATE DATABASE polaris OWNER polaris;
   ```

2. **Install Node.js 20+** (https://nodejs.org).

3. **Clone, configure, run:**

   ```bash
   npm install
   cp .env.example .env          # edit DATABASE_URL if you changed creds
   npx prisma migrate dev --name init
   npm run db:seed               # optional sample data
   npm run dev
   ```

The dashboard is at `http://localhost:3000`; the API at `http://localhost:3000/api/v1`. On first visit the **Setup Wizard** walks through DB connection, admin account, and initial config (skip steps 1–2 above if you use it).

## Production deployment

Automated scripts install Node.js 20, PostgreSQL 15, the `polaris` system user, the database, app code (to `/opt/polaris` or `C:\polaris`), a random `SESSION_SECRET`, a random `POLARIS_SECRET_KEY` (encrypts stored device + integration credentials at rest), and a hardened service — then open port 3000 in the firewall.

**RHEL / Rocky / Alma 9:**

```bash
git clone https://github.com/rogers-group-inc/polaris.git && cd polaris
bash deploy/setup-rhel.sh
```

**Ubuntu / Debian:**

```bash
git clone https://github.com/rogers-group-inc/polaris.git && cd polaris
bash deploy/setup-ubuntu.sh
```

**Windows Server 2019 / 2022** (run as Administrator):

```powershell
git clone https://github.com/rogers-group-inc/polaris.git; cd polaris
powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1
```

After the script finishes the app is live at `http://<server-ip>:3000` — log in with `admin` / `admin` and change the password.

**Docker / Unraid:**

```bash
docker pull ghcr.io/rogers-group-inc/polaris:latest
```

Multi-stage image, ~940 MB, x86_64. PostgreSQL is **not** included — run a `postgres:15` container alongside it (or point at any reachable Postgres). Expose container port `3000` (HTTP-only; terminate TLS in a reverse proxy in front of the container — see `docker-compose.yml` for the nginx-fronted reference stack). All persistent state lives under `/app/state`, so a single bind mount is enough:

| Container path | Host path | Notes |
|---|---|---|
| `/app/state` | `/mnt/user/appdata/polaris` | `.env`, `.setup-complete`, `data/backups/`, `public/uploads/` |

On first launch the container starts the setup wizard at `http://<host>:3000` (DB host, admin account, session secret). The wizard supports self-signed Postgres TLS via an "Allow self-signed certificate" toggle. After finalize, the container restarts itself into the main app — with a generated `POLARIS_SECRET_KEY` in `/app/state/.env` that encrypts stored device + integration credentials. **Back that key up off the host:** it lives on the bind mount, and sealed secrets cannot be recovered without it.

If you instead run the multi-container `docker-compose.yml` stack, it supplies `DATABASE_URL` up front so the wizard never runs — generate `SESSION_SECRET` and `POLARIS_SECRET_KEY` into `./state/.env` yourself first. See [docs/INSTALL.md → Docker](docs/INSTALL.md#docker).

Updates: `docker pull` + restart. The in-app updater under Server Settings → Maintenance is for the script-deployed RHEL / Ubuntu / Windows path; image-based deployments update by pulling a new tag. Every commit to `main` builds and publishes `:latest`, the branch name, and `:sha-<short>` to GHCR via GitHub Actions.

### Updating

The recommended path is **Server Settings → Maintenance → Update**, which runs the same automated flow as the CLI scripts and rolls back on any failure:

```bash
bash deploy/update-linux.sh                                         # Linux
powershell -ExecutionPolicy Bypass -File deploy\update-windows.ps1  # Windows, as Admin
```

The flow: snapshot the commit → `pg_dump` backup (last 10 kept in `backups/`) → `git pull` → `npm ci` → build → stop service → migrate → start → HTTP smoke test. If any step fails the code, DB, and service are restored to the previous version.

### Managing the service

Production installs run the split-role layout (web / monitor / discovery / dash), fronted
by nginx for TLS termination — it's the **default and only supported production
layout** on Linux. The setup scripts install it automatically; the legacy
single-process `polaris.service` unit is no longer shipped.

**Linux (systemd):** manage the whole group via the target:
`systemctl status|restart polaris.target`, `journalctl -u polaris-web -f` (or
`-u polaris-monitor@1` / `-u polaris-discovery` for the other roles). See
[docs/INSTALL.md](docs/INSTALL.md) → "The split-role deployment (web / monitor /
discovery)" for the layout and customization details.

**Windows (NSSM):** one service per role (`PolarisWeb` / `PolarisMonitor1` /
`PolarisDiscovery`) — `nssm status|restart PolarisWeb`, logs in
`C:\polaris\logs\service-stdout.log`.

> Local development (`npm run dev`, `POLARIS_ROLE` unset) still runs everything
> in one process — the single-process "all" role exists only for dev, never in
> production.

## API overview

All endpoints live under `/api/v1/`.

| Resource | Base path |
|---|---|
| IP Blocks | `/blocks` |
| Subnets | `/subnets` (incl. `/next-available`, `/bulk-allocate`) |
| Reservations | `/reservations` (incl. `/alerts`, `/stale-settings`) |
| Allocation Templates | `/allocation-templates` |
| Assets | `/assets` (incl. monitoring, quarantine, snmp-walk) |
| Map | `/map` (sites, search, topology) |
| Integrations | `/integrations` (incl. discovery, query, interface aggregate) |
| Conflicts | `/conflicts` |
| Credentials | `/credentials` |
| Manufacturer Aliases | `/manufacturer-aliases` |
| API Tokens | `/api-tokens` |
| Events | `/events` |
| Search | `/search` |
| Users | `/users` |
| Auth / SSO / TOTP | `/auth` |
| Utilization | `/utilization` |
| Dashboard | `/dashboard/summary` |
| Server Settings | `/server-settings` (incl. MIBs, capacity, backups) |

Authentication is session-based for the UI; long-lived bearer tokens (`polaris_<32-char-base64url>`) are accepted on a small allow-listed surface for external callers. See `CLAUDE.md` for the full endpoint catalog and domain model.

## Integrations

### FortiManager
On-premise FortiManager **7.4.7+ / 7.6.2+** via JSON-RPC with a bearer API token. Discovers DHCP scopes, leases + static reservations (merged from CMDB and live monitor), interface IPs, VIPs (including load-balance virtual servers with their realserver pools), managed FortiSwitches, managed FortiAPs, and FortiGate inventory. Two transports are selectable per integration:

- **Proxy** (default) — every per-device call funnels through FMG's `/sys/proxy/json`. Simpler firewall posture; FMG-imposed serial polling caps the practical fleet size.
- **Direct** — FMG is queried for the device roster + management-IP resolution (cached across cycles, so warm runs dispatch directly against monitor-up FortiGates with no FMG round-trip and self-heal via FMG re-resolve when a cached IP turns stale); per-device calls go straight to each FortiGate's management IP using a shared REST API admin credential. Unlocks parallelism and is recommended above ~20 FortiGates.

DHCP push, quarantine push, monitoring transport (per-stream REST/SNMP toggles), per-class FortiSwitch/FortiAP direct polling, and per-class Auto-Monitor Interfaces selections are all configured per integration.

### Standalone FortiGate
A single FortiGate via REST API — same discovery scope as FortiManager — for deployments not managed by one. Requires a REST API admin token (System → Administrators → REST API Admin).

### Windows Server
Windows Server DHCP via WinRM (PowerShell remoting, port 5985 HTTP or 5986 HTTPS). Discovers v4 DHCP scopes.

### Microsoft Entra ID / Intune
Microsoft Graph via OAuth2 client credentials. Produces **assets only**.

- **Entra ID** (always) — hostname, OS, OS version, trust type, compliance, last sign-in. Requires `Device.Read.All` (application, admin-consented). Add `User.Read.All` + `Group.Read.All` + `OrgContact.Read.All` (or `Directory.Read.All`) **only** if you enable address-book directory search — an opt-in, live lookup that stores nothing.
- **Intune** (toggle) — serial, MAC (Wi-Fi + Ethernet, both stored), manufacturer, model, primary user, compliance state. Merged onto Entra devices via `azureADDeviceId ↔ deviceId`. Requires `DeviceManagementManagedDevices.Read.All`.

### Active Directory (on-premise)
A domain controller via LDAP / LDAPS simple bind, read-only domain user. Produces **assets only** — computer objects under a configured base DN, mapping hostname, DNS name, OS / OS version, OU path, `whenCreated`, `lastLogonTimestamp`, and description. Disabled accounts can be imported as `decommissioned` or skipped. Wildcard OU include/exclude filters. Discovery reads **computer objects only**; the bind account needs read access to user, group and contact objects as well **only** if you enable address-book directory search — an opt-in, live lookup that stores nothing.

### VMware vCenter
A vCenter server (7.0U2+) over the vSphere Automation REST API, with two narrow SOAP calls for what REST doesn't expose. Produces **assets only** — virtual machines, ESXi hosts, and a current-state datastore inventory. VMs link to their running host, gain a vMotion-safe host dependency (one edge per cluster member, so suppression only fires when the whole cluster is dark), and can take per-minute CPU/RAM from the hypervisor's batched quickStats without an in-guest agent.

### Azure Arc
Arc-enabled machines (`Microsoft.HybridCompute/machines`) via **Azure Resource Manager**, using an Entra app registration with the client-credentials flow. Produces **assets only**. No Microsoft Graph permission is needed — this is ARM-only, which is the step most often carried over by mistake from an Entra ID setup.

- **Required access** — the app registration's service principal needs the **Reader** role, ideally at the management-group root, and the `Microsoft.HybridCompute` resource provider must be registered in each subscription. Azure returns only what the principal can read, so a partial Reader assignment yields *fewer machines* rather than an access error; Test Connection reports how many subscriptions it can actually see, which is the way to catch that. Reader covers discovery entirely. It is **not** enough for the optional *Run deployment scripts* capability, which additionally needs a role carrying `Microsoft.HybridCompute/machines/runCommands/write` — see below.
- **What it reports** — because the Connected Machine agent runs in the guest: the real domain-joined FQDN, the running OS SKU and version, SMBIOS serial / manufacturer / model, and a live heartbeat. A `Disconnected` agent is treated as a reachability signal, never a lifecycle one — those machines stay in inventory, tagged `arc-disconnected`.
- **Optional extras** (one extra query each for the whole tenant, all default off) — Arc-enabled **VMware / SCVMM** placement, which also supplies the identifier that matches a machine to its existing vCenter VM instead of duplicating it; Arc-enabled **SQL Server** instances, attached to their host; and Arc-enabled **Kubernetes** clusters, which are the one extra that adds devices — each connected cluster becomes its own asset.
- **Filters** — explicit subscription list (or every subscription the app can see), plus wildcard resource-group and machine-name filters and `key=value` Azure-tag filters.

### Hybrid join cross-link
Active Directory and Entra ID identify the same hybrid-joined device with two unrelated GUIDs (AD `objectGUID` vs Entra `deviceId`). Polaris cross-links them via the on-prem SID — AD's `objectSid` equals Entra's `onPremisesSecurityIdentifier`. Discovery from each integration writes its own `AssetSource` row (`sourceKind` = `ad` / `entra` / `intune`, `externalId` keyed on the source's natural identifier). When a later sync from the other side arrives, Polaris finds the existing asset by SID, attaches its own AssetSource row alongside the others, and merges the discovery-owned Asset fields through a deterministic projection. The same Asset row carries both source rows; nothing is duplicated.

## Security

- TLS 1.2+ with AEAD-only cipher suites and configurable certificates
- Helmet Content Security Policy, HSTS, X-Frame-Options
- Synchronizer-token CSRF protection on every state-changing call (`polaris_csrf` cookie + `X-CSRF-Token` header)
- 10 login attempts / 15-minute window per IP; per-account temporary lockout after repeated failures
- HttpOnly + SameSite=Lax session cookies, session ID regenerated on login, configurable inactivity timeout
- Argon2id password hashing; argon2id-hashed API tokens with timing-safe lookup
- SAML RelayState CSRF protection on SSO callbacks
- 1 MB max request body
- Setup wizard self-locks after first-run via a `.setup-complete` marker so a network attacker can't re-run provisioning against an installed host

## Running tests

```bash
npm test                  # all tests once
npm run test:watch        # watch mode
npm run test:coverage     # with coverage report
```

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ / TypeScript (ESM) |
| Framework | Express 5 |
| ORM | Prisma 7 (driver-adapter via `@prisma/adapter-pg`) |
| Database | PostgreSQL 15 |
| Sessions | express-session + connect-pg-simple |
| Validation | Zod |
| Logging | Pino |
| Auth | argon2id, `@node-saml/node-saml`, `otpauth` + `qrcode` |
| IP math | `netmask` |
| LDAP | `ldapts` |
| Monitoring transports | `net-snmp`, `ssh2`, built-in `node:https` (FortiOS REST + WinRM SOAP), system `ping` |
| Mapping | Leaflet + leaflet.markercluster + leaflet-draw + OpenStreetMap |
| Graph layout | Cytoscape.js + dagre + cytoscape-dagre |
| PDF | jspdf + jspdf-autotable |
| Security | Helmet, express-rate-limit |
| Testing | Vitest + Supertest |
| Frontend | Vanilla JavaScript + HTML, served from `/public` (no build step) |
