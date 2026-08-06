#!/bin/sh
set -e

cd /app

STATE_DIR="${POLARIS_STATE_DIR:-/app/state}"
ENV_FILE="$STATE_DIR/.env"

mkdir -p "$STATE_DIR/data/backups" "$STATE_DIR/public/uploads"
touch "$ENV_FILE"

if [ -s "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

# Migrations run ONCE, only on the web/all role (or a dedicated migrate
# service). monitor/discovery containers must NOT migrate — they'd race the
# web container on the same `migrate deploy`. POLARIS_ROLE unset = "all" =
# single-container deployment, which still migrates (unchanged behavior).
ROLE="${POLARIS_ROLE:-all}"
if [ -n "${DATABASE_URL:-}" ]; then
  if [ "$ROLE" = "all" ] || [ "$ROLE" = "web" ] || [ "$ROLE" = "migrate" ]; then
    echo "[entrypoint] Applying Prisma migrations (role=$ROLE)..."
    # FATAL, not a warning. docker-compose.yml gates web/monitor/discovery on
    # `migrate: condition: service_completed_successfully`, so exiting 0 here
    # after a failed migration would satisfy that gate and bring the whole
    # stack up against a stale schema — Prisma then throws
    # `column "<name>" does not exist` at runtime instead of the stack
    # refusing to start. Matches polaris-migrate.service (Type=oneshot, the
    # app units Require= it) and applyUpdate's failUpdate-and-stop on the
    # migration step.
    if ! npx --no-install prisma migrate deploy; then
      echo "[entrypoint] FATAL: prisma migrate deploy failed — refusing to start against a stale schema." >&2
      exit 1
    fi
  else
    echo "[entrypoint] role=$ROLE — skipping migrations (web/migrate role owns them)."
  fi
else
  echo "[entrypoint] No DATABASE_URL set — first-run setup wizard will start."
fi

# A dedicated one-shot migrate container exits after migrating (compose gates
# the app services on its completion); the app roles fall through to the server.
if [ "$ROLE" = "migrate" ]; then
  echo "[entrypoint] migrate role — done, exiting 0."
  exit 0
fi

exec node --env-file="$ENV_FILE" dist/index.js
