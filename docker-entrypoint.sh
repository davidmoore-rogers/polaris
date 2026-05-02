#!/bin/sh
set -e

cd /app

touch .env

if [ -s .env ]; then
  set -a
  . ./.env
  set +a
fi

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] Applying Prisma migrations..."
  if ! npx --no-install prisma migrate deploy; then
    echo "[entrypoint] WARN: prisma migrate deploy failed; continuing anyway." >&2
  fi
else
  echo "[entrypoint] No DATABASE_URL set — first-run setup wizard will start."
fi

exec node --env-file=.env dist/index.js
