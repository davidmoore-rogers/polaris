#!/usr/bin/env bash
# deploy/setup-rhel.sh — Polaris deployment script for RHEL / Rocky / Alma Linux 9
#
# Run as root:  bash deploy/setup-rhel.sh
#
# What this script does:
#   1. Installs Node.js 20 and PostgreSQL 15 (if not already installed)
#   2. Creates a dedicated 'polaris' system user
#   3. Creates the PostgreSQL database and role
#   4. Clones or copies the application to /opt/polaris
#   5. Installs dependencies and runs migrations
#   6. Installs and enables a systemd service
#
# After running, the app will be available at http://<server-ip>:3000

set -euo pipefail

APP_DIR="/opt/polaris"
APP_USER="polaris"
APP_GROUP="polaris"
DB_NAME="polaris"
DB_USER="polaris"
DB_PASS="polaris"
REPO_URL="https://github.com/davidmoore-rogers/polaris.git"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── Preflight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root"
fi

info "Starting Polaris deployment on $(hostname)"

# ─── 1. Install Node.js 20 ───────────────────────────────────────────────────
if command -v node &>/dev/null && [[ "$(node -v)" == v20* || "$(node -v)" == v22* ]]; then
  info "Node.js $(node -v) already installed"
else
  info "Installing Node.js 20..."
  dnf module enable -y nodejs:20
  dnf install -y nodejs npm
  info "Node.js $(node -v) installed"
fi

# Allow Node.js to bind to privileged ports (80, 443) without root
info "Granting Node.js low-port binding capability..."
setcap cap_net_bind_service=+ep "$(which node)"

# ─── 2. Install PostgreSQL 15 ────────────────────────────────────────────────
if command -v psql &>/dev/null; then
  info "PostgreSQL already installed"
else
  info "Installing PostgreSQL..."
  dnf install -y postgresql-server postgresql
  postgresql-setup --initdb
  info "PostgreSQL installed"
fi

# ─── 2b. Install git ────────────────────────────────────────────────────────
if command -v git &>/dev/null; then
  info "Git already installed"
else
  info "Installing git..."
  dnf install -y git
  info "Git installed"
fi

# Enable and start PostgreSQL
systemctl enable --now postgresql
info "PostgreSQL is running"

# ─── 3. Create system user ───────────────────────────────────────────────────
if id "$APP_USER" &>/dev/null; then
  info "User '$APP_USER' already exists"
else
  info "Creating system user '$APP_USER'..."
  useradd --system --shell /bin/false --home-dir "$APP_DIR" --create-home "$APP_USER"
  info "User '$APP_USER' created"
fi

# ─── 4. Create database and role ─────────────────────────────────────────────
info "Setting up PostgreSQL database..."
pushd /tmp >/dev/null
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

# pg-boss (queue runtime for monitor cadences at scale) lives in its own
# `pgboss` schema. Make sure the polaris role owns it so pg-boss can create
# its tables and the workers can boot. Idempotent — safe to re-run.
sudo -u postgres psql -d "$DB_NAME" <<SQL
CREATE SCHEMA IF NOT EXISTS pgboss;
ALTER SCHEMA pgboss OWNER TO $DB_USER;
GRANT ALL ON SCHEMA pgboss TO $DB_USER;
GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO $DB_USER;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO $DB_USER;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO $DB_USER;
SQL

info "Database '$DB_NAME' ready"

# Ensure pg_hba.conf allows password auth for the polaris user
PG_HBA=$(sudo -u postgres psql -tc "SHOW hba_file;" | tr -d ' ')
if ! grep -q "$DB_USER" "$PG_HBA" 2>/dev/null; then
  warn "Adding md5 auth entry for '$DB_USER' to pg_hba.conf"
  sed -i "/^# TYPE/a local   $DB_NAME   $DB_USER   md5\nhost    $DB_NAME   $DB_USER   127.0.0.1/32   md5\nhost    $DB_NAME   $DB_USER   ::1/128        md5" "$PG_HBA"
  systemctl reload postgresql
fi
popd >/dev/null

# ─── 5. Deploy application ───────────────────────────────────────────────────
if [[ -d "$APP_DIR/.git" ]]; then
  info "Updating existing installation..."
  cd "$APP_DIR"
  sudo -u "$APP_USER" git pull --ff-only
else
  info "Cloning repository to $APP_DIR..."
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
fi

cd "$APP_DIR"

# ─── 6. Configure environment ────────────────────────────────────────────────
if [[ ! -f "$APP_DIR/.env" ]]; then
  info "Creating .env from template..."
  SESSION_SECRET=$(openssl rand -base64 32)
  cat > "$APP_DIR/.env" <<ENVFILE
# Database
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}

# App
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# Auth
SESSION_SECRET=${SESSION_SECRET}
ENVFILE
  chown "$APP_USER:$APP_GROUP" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  info ".env created with generated SESSION_SECRET"
else
  info ".env already exists — skipping"
fi

# ─── 7. Install dependencies & build ─────────────────────────────────────────
info "Installing dependencies..."
sudo -u "$APP_USER" npm ci --production=false

info "Building TypeScript..."
sudo -u "$APP_USER" npx tsc

info "Running database migrations..."
sudo -u "$APP_USER" npx prisma migrate deploy

# Only seed on first deploy (skip if users table already has rows)
HAS_USERS=$(cd /tmp && sudo -u postgres psql -tc "SELECT count(*) FROM ${DB_NAME}.public.users" 2>/dev/null | tr -d ' ') || HAS_USERS=""
if [[ "$HAS_USERS" == "" || "$HAS_USERS" == "0" ]]; then
  info "Seeding default admin (skipped in production — use the first-run wizard or restore from backup)..."
  sudo -u "$APP_USER" node --env-file=.env --import tsx/esm prisma/seed.ts || true
else
  info "Database already seeded ($HAS_USERS users) — skipping"
fi

# ─── 8. Install systemd service ──────────────────────────────────────────────
info "Installing systemd service..."
cp "$APP_DIR/deploy/polaris.service" /etc/systemd/system/polaris.service
systemctl daemon-reload
systemctl enable --now polaris

info "Waiting for service to start..."
sleep 2

if systemctl is-active --quiet polaris; then
  info "Polaris service is running"
else
  warn "Service may not have started — check: journalctl -u polaris -f"
fi

# ─── 9. Firewall ─────────────────────────────────────────────────────────────
if command -v firewall-cmd &>/dev/null; then
  info "Opening port 3000 in firewall..."
  firewall-cmd --permanent --add-port=3000/tcp
  firewall-cmd --reload
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
info "============================================"
info "  Polaris deployment complete!"
info "  URL:   http://$(hostname -I | awk '{print $1}'):3000"
info "  Login: admin / admin"
info "  Logs:  journalctl -u polaris -f"
info "============================================"
echo ""
warn "Change the default admin password after first login!"
