# IP Management (IPAM)

A central IP Address Management service for reserving and tracking IPv4/IPv6 space across infrastructure projects.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your database credentials

# 3. Run database migrations
npx prisma migrate dev --name init

# 4. Seed example data
npm run db:seed

# 5. Start the dev server
npm run dev
```

The API will be available at `http://localhost:3000/api/v1`.

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
