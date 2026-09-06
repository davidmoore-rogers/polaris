---
name: prisma-postgres-timescale
description: "Prisma 7 + PostgreSQL + TimescaleDB operating rules for a Node.js service: driver-adapter client lifecycle and regeneration, migration conventions (seeding new keys, enum-to-table cutovers, timestamp collisions), PgBouncer compatibility, hypertable rules (no FK from a hypertable, never row-DELETE compressed chunks, pre/post-restore gates), per-scope advisory-lock check-then-insert, and encrypt-at-rest via a client extension. Load when writing a migration, adding a model, touching time-series tables, or debugging Prisma/Postgres in production."
---

# Prisma + PostgreSQL + TimescaleDB rules

Distilled from an app that runs ~20 sample tables as hypertables at fleet scale. No app paths.

## Client lifecycle

- Prisma 7 with a driver adapter (`@prisma/adapter-pg`): the generated client lives in the
  repo tree and is rebuilt by `postinstall`. Generation only needs `DATABASE_URL` to be
  **well-formed** — no connection is made — so CI and fresh worktrees can generate with a
  placeholder.
- A **fresh checkout without the generated client** fails loudly and misleadingly: a wall of
  implicit-`any` type errors and "N test files failed, 0 tests" at collect time. Generate first,
  then read failures as yours.
- Never symlink/junction one checkout's `node_modules` or generated client into another; the
  client is schema-specific, and on Windows deleting the junctioned tree deletes the target.
- Pool sizing is an env var surfaced in the app's own capacity advisor; every extra process
  (web, workers) opens its own pool, so budget `max_connections` across the process group.

## Migrations

- One migrator process, run before any other role starts (a systemd oneshot or an init
  container) — never let N replicas race `migrate deploy`.
- **Adding a permission key / registry row**: the migration must seed it onto every existing
  row (every Role, every install) and the runtime normalizer must tolerate its absence until then.
- **Narrowing** a value set (e.g. a permission ladder) needs a migration that folds stored
  values DOWN; relying on the next write to normalize leaves UI and DB disagreeing.
- **Enum → table cutover** (done twice successfully): add the table, seed the enum's values as
  protected built-in rows, change the column to `String`, validate at write time against the
  table, keep code that branches on the literal built-in names, migrate references in one step.
- **Timestamp collisions**: two branches each add `2026MMDD000000_*`; a cherry-pick can leave
  your migration with an EARLIER timestamp than one already applied upstream. Re-check
  ordering after every rebase/pick.
- A unique index that may be violated by pre-existing data is created by a **retrying startup
  job**, not by the migration (which would fail the upgrade); the migration only skips it.
- Prefer `migrate deploy` (no shadow DB, no prompts) everywhere but the developer's own DB.

## PgBouncer

Transaction pooling breaks anything session-scoped: advisory locks that outlive a statement,
`LISTEN/NOTIFY`, `pg_dump`, `pg_stat_activity` reads, job queues like pg-boss. Route those
through a **direct** URL (a second env var) and keep the ORM on the pooled one.

## TimescaleDB hypertables

- **No foreign key from a hypertable to a parent table.** A cascade DELETE that reaches a
  compressed chunk decompresses it into un-truncatable bloat; prune by `drop_chunks` and let
  orphans age out. Never row-DELETE or UPDATE rows that could sit in a compressed chunk.
- `shared_preload_libraries=timescaledb` must be a server flag, not left to the image: the
  entrypoint only writes it during initdb, so an existing volume comes up with the extension
  installed but unloadable.
- Convert to hypertables at boot with `migrate_data => true` so existing rows carry over; keep
  plain tables for current-state data (delete-replace per scrape) and hypertables for
  append-only samples with hourly/daily rollup companions.
- Backup/restore wraps in `timescaledb_pre_restore()` / `timescaledb_post_restore()`; a
  restore that skips them fails on the catalog. A backup you have not restored is not a backup.
- Watch compressed-chunk bloat as a first-class capacity signal.

## Two patterns worth copying

- **Serialized check-then-insert**: overlap/uniqueness checks that need business logic are
  check-then-insert races. Take `pg_advisory_xact_lock(hash(scope))` inside the transaction,
  check, insert; keep a DB unique index as the backstop. Route EVERY creating path through the
  one helper — a bare `create` elsewhere reopens the race.
- **Encrypt-at-rest via a client extension**: seal secret leaves of JSON config columns in the
  extension's write hooks per model, but **open on ALL models** on read, because relation
  reads never fire per-model hooks. Raw SQL bypasses the extension. If the key is unset, run
  as plaintext with a loud health warning rather than refusing to boot; seal existing rows with
  a startup job once the key appears.
