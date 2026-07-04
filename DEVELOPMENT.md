# Polaris — Development Environment

How to run Polaris locally for development. Production deployment is the
split-role, nginx-fronted layout described in [docker-compose.yml](docker-compose.yml)
and [docs/INSTALL.md](docs/INSTALL.md) — none of that applies here. Dev is a
single process (`POLARIS_ROLE` unset = `all`), plain HTTP, no nginx, no
Prometheus.

There are two ways to run dev, both backed by the same Postgres container:

1. **Containerized app** — everything in podman/docker via `compose.dev.yml`
   (best on Windows, where native modules like argon2 and net-snmp are
   awkward to build against the host toolchain).
2. **Host-native app** — `npm run dev` on the host, pointed at the Postgres
   container.

---

## The dev compose stack (`compose.dev.yml`)

Two services under the compose project name `polaris` (containers become
`polaris-postgres-1` / `polaris-app-1`, volumes `polaris_pgdata` /
`polaris_node_modules`):

### `postgres`

- `postgres:15-alpine`, data on the `pgdata` named volume (survives
  `compose down`; only `compose down -v` wipes it).
- Credentials `polaris` / `polaris`, database `polaris` (dev-only values).
- Published on `127.0.0.1:5432` so host tools (psql, DBeaver, `npm run dev`,
  Prisma Studio) can reach it. Inside the compose network the app reaches it
  at host `postgres`.
- Healthcheck via `pg_isready`; the app service waits on it.

### `app`

- Built from [Dockerfile.dev](Dockerfile.dev): `node:20-bookworm` plus
  native-module build deps (`python3`, `build-essential`), `postgresql-client`
  for ad-hoc psql inside the container, and `iputils-ping` (the monitoring
  code path spawns the system `ping` for ICMP probes). The production image
  in [Dockerfile](Dockerfile) is a separate multi-stage build — don't confuse
  the two.
- Source tree is **bind-mounted** at `/app`, so `tsx watch` (via
  `npm run dev`) hot-reloads on host edits. No rebuild needed for code
  changes — only rebuild the image when Dockerfile.dev itself changes.
- A named volume shadows `/app/node_modules` so the container's Linux-built
  native modules never mix with a Windows host `node_modules`. Consequence:
  after changing `package.json` deps, run `npm install` **inside the
  container** (the default `command:` self-heals this by running
  `npm install` when `node_modules/.bin/tsx` is missing).
- App published on `127.0.0.1:3000`.

### Bringing it up

```bash
podman compose -f compose.dev.yml up -d postgres
podman compose -f compose.dev.yml run --rm app npm install
podman compose -f compose.dev.yml run --rm app npx prisma migrate deploy
podman compose -f compose.dev.yml run --rm app npm run db:seed
podman compose -f compose.dev.yml up app
```

(`docker compose` works identically if you use docker instead of podman.)

### First-run setup wizard vs. DATABASE_URL

`DATABASE_URL` is deliberately **not** set in the app service's environment.
On a fresh stack the first-run setup wizard runs at http://localhost:3000 —
give it host `postgres`, port `5432`, user/password/db `polaris`. The wizard
writes `.env` and `.setup-complete` into the bind-mounted project root (both
gitignored), and subsequent boots pick them up.

To bypass the wizard, set `DATABASE_URL=postgresql://polaris:polaris@postgres:5432/polaris`
in `.env` (or uncomment the line in `compose.dev.yml`) before first boot.

**Do not set `POLARIS_STATE_DIR` in the dev container.** When set, the wizard
writes `.env` under the state dir but `npm run dev`'s `node --env-file=.env`
reads `/app/.env` — the two desync and boot fails with "DATABASE_URL is
missing but .setup-complete is present". Left unset, all state files
(`.env`, `.setup-complete`, `data/`, `public/uploads/`) land in the
bind-mounted project root, which is gitignored.

### Environment variables set by the dev compose file

| Variable | Dev value | Note |
|---|---|---|
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | |
| `SESSION_SECRET` | dev placeholder | Only enforced (boot-fail if missing) when `NODE_ENV=production` |
| `DATABASE_URL` | unset → wizard | See above; `postgres:5432` from inside the network, `localhost:5432` from the host |
| `POLARIS_ROLE` | unset (= `all`) | Single process runs web + monitor + discovery |
| `POLARIS_STATE_DIR` | unset | Intentional — see wizard note above |

Everything else (`POLARIS_PUBLIC_URL`, `POLARIS_PROXY_CERT_PATH`,
`HEALTH_TOKEN`, `METRICS_TOKEN`, pool/worker sizing, …) is unset in dev; the
nginx-related fail-fast checks only apply to production deployments. The full
variable catalog with per-variable commentary lives in
[.env.example](.env.example) and the Environment Variables section of
[CLAUDE.md](CLAUDE.md).

---

## Host-native alternative

Run only Postgres in a container and the app on the host:

```bash
podman compose -f compose.dev.yml up -d postgres
cp .env.example .env      # DATABASE_URL already points at localhost:5432/polaris
npm install
npx prisma migrate dev
npm run db:seed
npm run dev               # tsx watch, hot reload
```

The default `DATABASE_URL` in `.env.example`
(`postgresql://polaris:polaris@localhost:5432/polaris`) matches the container's
published port and credentials exactly.

Caveat on Windows hosts: some native deps (argon2, net-snmp) need a working
build toolchain; if `npm install` fights you, use the containerized app path
instead.

---

## Day-to-day commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload (`tsx watch`, reads `.env`) |
| `npm test` / `npm run test:watch` | Vitest (+ Supertest) |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / eslint |
| `npm run db:migrate` | `prisma migrate dev` (create + apply migrations) |
| `npm run db:seed` | Seed example data |
| `npm run db:reset` | Drop + re-migrate + re-seed |
| `npm run db:studio` | Prisma Studio DB browser |
| `npm run check:docs` | Doc-index structural check (also runs as a pre-commit hook) |
| `npm run test:fmg` | FortiManager connectivity smoke test |
| `npm run demo` | `demo.mjs` feature walkthrough |

To run any of these inside the containerized app:
`podman compose -f compose.dev.yml run --rm app <command>` (or `exec` against
the running `app` service).

### Resetting the dev database

- Schema/data reset, keep the container: `npm run db:reset`
- Nuke everything including the volume:
  `podman compose -f compose.dev.yml down -v` — then also delete
  `.setup-complete` and `.env` from the project root if you want the setup
  wizard to run again (see "First-run setup lock" in CLAUDE.md).
