#!/usr/bin/env bash
# deploy/update-linux.sh — Polaris update script for RHEL / Ubuntu / Debian
#
# Run as root:  bash deploy/update-linux.sh
#
# What this script does:
#   1. Records the current version and commit
#   2. Creates a database backup (pg_dump)
#   3. Pulls the latest code from git
#   4. Installs dependencies and rebuilds
#   5. Runs database migrations
#   6. Restarts the service
#   7. Verifies the service is healthy
#
# On failure, offers to rollback to the previous version.

set -euo pipefail

APP_DIR="/opt/polaris"
APP_USER="polaris"
DB_NAME="polaris"
BACKUP_DIR="/opt/polaris/backups"
SERVICE_NAME="polaris"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }
step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }

# ─── Preflight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root"
  exit 1
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  error "$APP_DIR is not a git repository — was the app installed with the setup script?"
  exit 1
fi

cd "$APP_DIR"

# ─── 1. Record current version ──────────────────────────────────────────────
step "1/8  Recording current version..."

OLD_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
OLD_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

info "Current version: v${OLD_VERSION} (${OLD_COMMIT})"

# ─── 2. Pre-update database backup ──────────────────────────────────────────
step "2/8  Creating pre-update database backup..."

mkdir -p "$BACKUP_DIR"
BACKUP_FILE="${BACKUP_DIR}/polaris-pre-update-${OLD_VERSION}-$(date +%Y%m%d-%H%M%S).sql.gz"

if command -v pg_dump &>/dev/null; then
  sudo -u postgres pg_dump --clean --if-exists "$DB_NAME" | gzip > "$BACKUP_FILE"
  BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  info "Backup created: $BACKUP_FILE ($BACKUP_SIZE)"
else
  warn "pg_dump not found — skipping backup. Proceed with caution."
  BACKUP_FILE=""
fi

# ─── 3. Pull latest code ────────────────────────────────────────────────────
step "3/8  Pulling latest code..."

sudo -u "$APP_USER" git fetch --all --prune
sudo -u "$APP_USER" git pull --ff-only

NEW_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
NEW_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

if [[ "$OLD_COMMIT" == "$NEW_COMMIT" ]]; then
  info "Already up to date — v${OLD_VERSION} (${OLD_COMMIT})"
  # Clean up the backup since no update occurred
  if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
    rm -f "$BACKUP_FILE"
    info "Removed unnecessary backup"
  fi
  exit 0
fi

info "Updating: v${OLD_VERSION} (${OLD_COMMIT}) → v${NEW_VERSION} (${NEW_COMMIT})"

# ─── Rollback function ──────────────────────────────────────────────────────
rollback() {
  echo ""
  error "Update failed at: $1"
  warn "Rolling back to v${OLD_VERSION} (${OLD_COMMIT})..."
  echo ""

  cd "$APP_DIR"
  sudo -u "$APP_USER" git checkout "$OLD_COMMIT" -- . 2>/dev/null || sudo -u "$APP_USER" git reset --hard "$OLD_COMMIT"
  sudo -u "$APP_USER" npm ci --production=false 2>/dev/null
  # Regenerate Prisma client + wipe stale dist so the rolled-back process
  # comes up with a client matching the rolled-back schema. Same rationale
  # as the forward-update path below; both are documented in
  # cross-cutting/schema-migrations-and-prisma-client-lifecycle in TOUCHES.md.
  sudo -u "$APP_USER" npx prisma generate 2>/dev/null
  sudo -u "$APP_USER" rm -rf "$APP_DIR/dist" 2>/dev/null
  sudo -u "$APP_USER" npx tsc 2>/dev/null

  # Restore database if migration failed and we have a backup
  if [[ "$1" == *"migration"* && -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
    warn "Restoring database from backup..."
    gunzip -c "$BACKUP_FILE" | sudo -u postgres psql --single-transaction -d "$DB_NAME" 2>/dev/null
    info "Database restored from backup"
  fi

  systemctl restart "$SERVICE_NAME" 2>/dev/null
  info "Rolled back to v${OLD_VERSION} (${OLD_COMMIT})"
  info "Service restarted with previous version"

  if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
    info "Database backup retained at: $BACKUP_FILE"
  fi

  exit 1
}

# ─── 4. Install dependencies ────────────────────────────────────────────────
step "4/8  Installing dependencies..."

# Ensure Node.js can bind to privileged ports (80, 443) without root
setcap cap_net_bind_service=+ep "$(which node)" 2>/dev/null || true

sudo -u "$APP_USER" npm ci --production=false || rollback "npm ci"

# Check for security vulnerabilities
AUDIT_OUTPUT=$(sudo -u "$APP_USER" npm audit --production 2>/dev/null || true)
if echo "$AUDIT_OUTPUT" | grep -qiE "critical|high"; then
  warn "npm audit found high/critical vulnerabilities:"
  echo "$AUDIT_OUTPUT" | grep -iE "critical|high" | head -5
  echo ""
fi

# ─── 5. Generate Prisma client ──────────────────────────────────────────────
# Explicit step — don't rely on `npm ci`'s postinstall having fired. A
# partially-failed `npm ci` (transient mirror blip, future --ignore-scripts,
# etc.) leaves the generated client stale; then step 7's `migrate deploy`
# drops columns the running client still selects, and every Asset read/write
# crashes with `column "<name>" does not exist`. See
# cross-cutting/schema-migrations-and-prisma-client-lifecycle in TOUCHES.md.
step "5/8  Generating Prisma client..."

sudo -u "$APP_USER" npx prisma generate || rollback "prisma generate"

# ─── 6. Build TypeScript ────────────────────────────────────────────────────
# Clean dist/ first so stale compiled JS from a previous build (e.g.
# generated-client files Prisma renamed between versions) can't shadow the
# fresh tsc output. tsc itself is non-destructive: without this, a file
# that exists in dist/ but no longer in src/ lingers forever.
step "6/8  Building TypeScript..."

sudo -u "$APP_USER" rm -rf "$APP_DIR/dist" || rollback "dist cleanup"
sudo -u "$APP_USER" npx tsc || rollback "TypeScript build"

info "Build successful — stopping service for migration"

# ─── 7. Migrate & restart ───────────────────────────────────────────────────
step "7/8  Running database migrations..."

systemctl stop "$SERVICE_NAME"

sudo -u "$APP_USER" npx prisma migrate deploy || rollback "database migration"

info "Migrations complete — starting service"

systemctl start "$SERVICE_NAME"

# ─── 8. Verify ──────────────────────────────────────────────────────────────
step "8/8  Verifying service health..."

sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
  info "Service is running"
else
  warn "Service may not have started — checking logs..."
  journalctl -u "$SERVICE_NAME" --no-pager -n 10
  rollback "service startup"
fi

# Optional: HTTP health check
HEALTH_OK=false
for i in 1 2 3; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT:-3000}/api/v1/server-settings/branding" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "302" || "$HTTP_CODE" == "401" ]]; then
    HEALTH_OK=true
    break
  fi
  sleep 2
done

if $HEALTH_OK; then
  info "HTTP health check passed"
else
  warn "HTTP health check returned $HTTP_CODE — the service is running but may not be fully ready"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
info "============================================"
info "  Update complete!"
info "  Version: v${OLD_VERSION} → v${NEW_VERSION}"
info "  Commit:  ${OLD_COMMIT} → ${NEW_COMMIT}"
if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
  info "  Backup:  $BACKUP_FILE"
fi
info "  Logs:    journalctl -u $SERVICE_NAME -f"
info "============================================"
echo ""

# Clean up old backups (keep last 10)
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/polaris-pre-update-*.sql.gz 2>/dev/null | wc -l)
if [[ "$BACKUP_COUNT" -gt 10 ]]; then
  REMOVE_COUNT=$((BACKUP_COUNT - 10))
  ls -1t "$BACKUP_DIR"/polaris-pre-update-*.sql.gz | tail -n "$REMOVE_COUNT" | xargs rm -f
  info "Cleaned up $REMOVE_COUNT old pre-update backup(s)"
fi
