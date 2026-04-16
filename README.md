# Shelob

A network management tool for asset management and reserving and tracking IPv4/IPv6 space across infrastructure projects. 

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

## API Overview

| Resource | Base Path |
|---|---|
| IP Blocks | `/api/v1/blocks` |
| Subnets | `/api/v1/subnets` |
| Reservations | `/api/v1/reservations` |
| Utilization | `/api/v1/utilization` |

See `CLAUDE.md` for full endpoint documentation and domain model.

## Production Deployment (RHEL / Rocky / Alma Linux)

An automated deployment script is included that sets up everything on a fresh RHEL 9 server.

### Automated setup

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
- Open port 3000 in the firewall

After it finishes, the app is live at `http://<server-ip>:3000` — log in with `admin` / `admin`.

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

```bash
systemctl status shelob          # check status
systemctl restart shelob         # restart after config changes
journalctl -u shelob -f          # tail logs
journalctl -u shelob --since today  # today's logs
```

### Updating

```bash
cd /opt/shelob
sudo -u shelob git pull --ff-only
sudo -u shelob npm ci
sudo -u shelob npx tsc
sudo -u shelob npx prisma migrate deploy
systemctl restart shelob
```

## Running Tests

```bash
npm test                  # run all tests once
npm run test:watch        # watch mode
npm run test:coverage     # with coverage report
```

## Tech Stack

- **Node.js 20+** / TypeScript
- **Express 5** — HTTP framework
- **Prisma** — ORM + migrations
- **PostgreSQL 15** — primary database
- **Zod** — request validation
- **Pino** — structured logging
- **Vitest** — unit & integration tests
