# Shelob

An IP address management (IPAM) tool for tracking and reserving IPv4/IPv6 space, managing network assets, and auto-discovering DHCP infrastructure from FortiManager and Windows Server.

## Features

- **IP Block & Subnet Management** — Create top-level IP blocks, carve subnets manually or auto-allocate by prefix length, track VLAN assignments
- **Reservation Tracking** — Reserve individual IPs or entire subnets with owner, project, expiry, and conflict detection
- **Asset Management** — Track servers, switches, firewalls, APs, and other devices with MAC history, serial numbers, warranty dates, and procurement info
- **FortiManager Integration** — Auto-discover DHCP scopes, interface IPs, device inventory, and DHCP leases from on-premise FortiManager (7.4.7+ / 7.6.2+) via JSON-RPC
- **Windows Server Integration** — Auto-discover DHCP scopes from Windows Server DHCP via WinRM (PowerShell remoting)
- **Azure SAML SSO** — SAML 2.0 single sign-on with Azure AD / Entra ID, with auto-provisioning and single logout
- **Role-Based Access** — Admin, Network Admin, Assets Admin, User, and Read-Only roles
- **Event Logging** — Audit trail with syslog forwarding, SFTP/SCP archival, and 7-day rolling retention
- **HTTPS & TLS Hardening** — Built-in HTTPS with certificate management, TLS 1.2+ minimum, AEAD-only cipher suites
- **Security Hardening** — Helmet CSP headers, rate limiting, session timeout, CSRF protection on SAML
- **Database Management** — Backup/restore with optional encryption, scheduled backups
- **MAC OUI Lookup** — Identify device manufacturers from MAC addresses using the IEEE OUI database, with admin-defined overrides
- **PDF/CSV Export** — Export assets, networks, events, and IP panel data
- **Light/Dark Theme** — User-selectable UI theme
- **First-Run Setup Wizard** — Browser-based guided setup for database, admin account, and application configuration

## System Requirements

### Minimum (small deployments: <50 devices, <500 subnets)

| Resource | Spec |
|----------|------|
| CPU | 2 vCPU |
| RAM | 4 GB |
| Disk | 20 GB SSD |
| OS | Windows Server 2019+, RHEL 9, Ubuntu 22.04+, or similar |
| PostgreSQL | 15+ |
| Node.js | 20 LTS |

### Recommended (large deployments: 200+ devices, 2,000+ subnets, 200K+ reservations)

| Resource | Spec |
|----------|------|
| CPU | 4 vCPU |
| RAM | 8 GB |
| Disk | 50 GB SSD |
| OS | Windows Server 2022, RHEL 9, Ubuntu 22.04+, or similar |
| PostgreSQL | 15+ |
| Node.js | 20 LTS |

### PostgreSQL Tuning (for large deployments)

```
shared_buffers = 2GB
work_mem = 32MB
effective_cache_size = 4GB
max_connections = 20
random_page_cost = 1.1
```

> At large scale, the discovery sync pre-loads all subnets, reservations, and assets into memory for O(1) lookups. Peak memory usage during a full sync cycle with 200K+ records is approximately 200-400 MB on top of the Node.js base footprint.

## Prerequisites

### PostgreSQL 15+

**RHEL / Rocky / Alma Linux 9:**

```bash
sudo dnf install -y postgresql15-server postgresql15
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
```

**Ubuntu / Debian:**

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

**Windows (via installer):**

Download the installer from https://www.postgresql.org/download/windows/ and follow the setup wizard. The installer includes pgAdmin and adds `psql` to your PATH.

### Create the database and user

```bash
sudo -u postgres psql
```

```sql
CREATE USER shelob WITH PASSWORD 'shelob';
CREATE DATABASE shelob OWNER shelob;
\q
```

> Adjust the credentials in `.env` if you choose a different username or password.

### Node.js 20+

Install via https://nodejs.org or your system package manager.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your database credentials (default: postgresql://shelob:shelob@localhost:5432/shelob)

# 3. Run database migrations
npx prisma migrate dev --name init

# 4. Seed example data
npm run db:seed

# 5. Start the dev server
npm run dev
```

The dashboard is available at `http://localhost:3000` and the API at `http://localhost:3000/api/v1`.

Alternatively, skip steps 2-4 and use the **Setup Wizard** — navigate to `http://localhost:3000` and it will guide you through database connection, admin account creation, and initial configuration.

## Demo Mode

A standalone demo server with mock data is included for evaluation:

```bash
node demo.mjs
```

This starts an in-memory server on port 3000 with sample blocks, subnets, reservations, assets, and integrations. No database required.

## API Overview

| Resource | Base Path |
|---|---|
| IP Blocks | `/api/v1/blocks` |
| Subnets | `/api/v1/subnets` |
| Reservations | `/api/v1/reservations` |
| Assets | `/api/v1/assets` |
| Integrations | `/api/v1/integrations` |
| Events | `/api/v1/events` |
| Users | `/api/v1/users` |
| Auth / SSO | `/api/v1/auth` |
| Utilization | `/api/v1/utilization` |
| Server Settings | `/api/v1/server-settings` |

All list endpoints support pagination via `limit` and `offset` query parameters (default: 50, max: 200).

See `CLAUDE.md` for full endpoint documentation and domain model.

## Integrations

### FortiManager

Connects to on-premise FortiManager via JSON-RPC API to discover:
- DHCP server scopes (creates subnets)
- FortiGate device inventory (creates assets)
- Interface IPs (creates reservations)
- DHCP leases and static reservations
- Device inventory with MAC/IP/switch/AP tracking

Requires FortiManager **7.4.7+** or **7.6.2+** with a bearer API token. Default poll interval: 12 hours.

### Windows Server

Connects to Windows Server DHCP via WinRM (PowerShell remoting) to discover:
- DHCP v4 scopes (creates subnets)

Requires WinRM enabled on the target server (port 5985 HTTP or 5986 HTTPS). Default poll interval: 4 hours.

## Authentication

### Local Accounts

Built-in username/password authentication with bcrypt hashing. Passwords require 8+ characters with mixed case, a number, and a special character.

### Azure AD SAML SSO

SAML 2.0 integration with Azure AD / Microsoft Entra ID. Configure via Settings > SSO:
- SP Entity ID, ACS URL, and SLS URL are auto-derived from the application URL
- Supports `wantAssertionsSigned` and `wantAuthnResponseSigned`
- Optional "Skip Login Page" to redirect directly to Azure
- Configurable inactivity timeout
- Users are auto-provisioned on first login

## Security

- **TLS** — Minimum TLS 1.2, AEAD-only cipher suites, configurable certificates
- **Headers** — Helmet.js with Content Security Policy, HSTS, X-Frame-Options
- **Rate Limiting** — 10 login attempts per 15-minute window
- **Session** — HttpOnly cookies, SameSite=Lax, configurable inactivity timeout
- **SAML** — RelayState CSRF protection on SSO callbacks
- **Body Limits** — 1 MB max request size

## Production Deployment

Automated deployment scripts are included for all supported platforms. Each script installs Node.js 20, PostgreSQL 15, creates the database, deploys the app, and registers a service.

### RHEL / Rocky / Alma Linux 9

```bash
# As root on the target server:
git clone https://github.com/davidmoore-rogers/shelob.git
cd shelob
bash deploy/setup-rhel.sh
```

The script will:
- Install Node.js 20 and PostgreSQL 15
- Create a dedicated `shelob` system user (the app never runs as root)
- Create the PostgreSQL database and role
- Clone the repo to `/opt/shelob`, install dependencies, build, and migrate
- Generate a random `SESSION_SECRET` in `.env`
- Install and enable a systemd service with security hardening
- Open port 3000 in the firewall (`firewall-cmd`)

### Ubuntu / Debian

```bash
# As root on the target server:
git clone https://github.com/davidmoore-rogers/shelob.git
cd shelob
bash deploy/setup-ubuntu.sh
```

Same steps as the RHEL script, but uses `apt-get`, the NodeSource repository for Node.js, and `ufw` for the firewall rule.

### Windows Server 2019 / 2022

```powershell
# As Administrator:
git clone https://github.com/davidmoore-rogers/shelob.git
cd shelob
powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1
```

The script will:
- Install Node.js 20 and PostgreSQL 15 (via `winget` or direct installer)
- Create the PostgreSQL database and role
- Clone the repo to `C:\shelob`, install dependencies, build, and migrate
- Generate a random `SESSION_SECRET` in `.env`
- Install [NSSM](https://nssm.cc) and register Shelob as a Windows Service with log rotation
- Open port 3000 in Windows Firewall (Domain + Private profiles)

After any script finishes, the app is live at `http://<server-ip>:3000` — log in with `admin` / `admin`.

### Manual setup

If you prefer to set things up by hand:

```bash
# 1. Create a service account (never run the app as root)
useradd --system --shell /bin/false --home-dir /opt/shelob shelob

# 2. Deploy the code
mkdir -p /opt/shelob
git clone https://github.com/davidmoore-rogers/shelob.git /opt/shelob
chown -R shelob:shelob /opt/shelob
cd /opt/shelob

# 3. Configure environment
cp .env.example .env
# Edit .env — set DATABASE_URL, generate a real SESSION_SECRET, set NODE_ENV=production

# 4. Install, build, migrate
sudo -u shelob npm ci
sudo -u shelob npx tsc
sudo -u shelob npx prisma migrate deploy
sudo -u shelob node --env-file=.env --import tsx/esm prisma/seed.ts

# 5. Install the systemd service
cp deploy/shelob.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now shelob
```

### Managing the service

**Linux (systemd):**

```bash
systemctl status shelob          # check status
systemctl restart shelob         # restart after config changes
journalctl -u shelob -f          # tail logs
journalctl -u shelob --since today  # today's logs
```

**Windows (NSSM):**

```powershell
nssm status Shelob               # check status
nssm restart Shelob               # restart after config changes
Get-Content C:\shelob\logs\service-stdout.log -Tail 50   # tail logs
```

### Updating

**Linux:**

```bash
cd /opt/shelob
sudo -u shelob git pull --ff-only
sudo -u shelob npm ci
sudo -u shelob npx tsc
sudo -u shelob npx prisma migrate deploy
systemctl restart shelob
```

**Windows:**

```powershell
cd C:\shelob
git pull --ff-only
npm ci
npx tsc
npx prisma migrate deploy
nssm restart Shelob
```

## Running Tests

```bash
npm test                  # run all tests once
npm run test:watch        # watch mode
npm run test:coverage     # with coverage report
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ / TypeScript |
| Framework | Express 5 |
| ORM | Prisma |
| Database | PostgreSQL 15 |
| Validation | Zod |
| Logging | Pino |
| Testing | Vitest + Supertest |
| IP Math | `ip-cidr` + `netmask` |
| SSO | `@node-saml/node-saml` (SAML 2.0) |
| Security | Helmet, express-rate-limit |
