# IP Management (IPAM)

A central IP Address Management service for reserving and tracking IPv4/IPv6 space across infrastructure projects.

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
CREATE USER ipam WITH PASSWORD 'ipam';
CREATE DATABASE ipam OWNER ipam;
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
# Edit .env with your database credentials (default: postgresql://ipam:ipam@localhost:5432/ipam)

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
