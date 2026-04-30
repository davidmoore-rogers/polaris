#!/usr/bin/env bash
# deploy/setup-ubuntu-nodb.sh — Polaris deployment script for Ubuntu / Debian
#                                with a remote/external PostgreSQL database
#
# Run as root:  bash deploy/setup-ubuntu-nodb.sh --db-url "postgresql://user:pass@db-host:5432/polaris"
#
# What this script does:
#   1. Installs Node.js 20, git, and PostgreSQL client tools (no server)
#   2. Creates a dedicated 'polaris' system user
#   3. Clones or copies the application to /opt/polaris
#   4. Configures .env with the provided DATABASE_URL
#   5. Installs dependencies, builds, and runs migrations against the remote database
#   6. Installs and enables a systemd service
#
# Use this script when your PostgreSQL database is hosted externally
# (e.g. AWS RDS, Azure Database for PostgreSQL, a separate DB server).
#
# After running, the app will be available at http://<server-ip>:3000

set -euo pipefail

APP_DIR="/opt/polaris"
APP_USER="polaris"
APP_GROUP="polaris"
REPO_URL="https://github.com/davidmoore-rogers/polaris.git"
DATABASE_URL=""

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── Parse arguments ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-url)   DATABASE_URL="$2"; shift 2 ;;
    --app-dir)  APP_DIR="$2"; shift 2 ;;
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: bash setup-ubuntu-nodb.sh --db-url \"postgresql://user:pass@host:5432/polaris\""
      echo ""
      echo "Options:"
      echo "  --db-url    PostgreSQL connection URL (required)"
      echo "  --app-dir   Installation directory (default: /opt/polaris)"
      echo "  --repo-url  Git repository URL"
      exit 0 ;;
    *) error "Unknown option: $1" ;;
  esac
done

# ─── Preflight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root"
fi

if [[ -z "$DATABASE_URL" ]]; then
  echo ""
  echo -e "${YELLOW}No --db-url provided. Please enter the PostgreSQL connection URL.${NC}"
  echo -e "Format: postgresql://user:password@host:5432/database"
  echo ""
  read -rp "DATABASE_URL: " DATABASE_URL
  if [[ -z "$DATABASE_URL" ]]; then
    error "DATABASE_URL is required. Use --db-url or enter it when prompted."
  fi
fi

# Validate URL format
if [[ ! "$DATABASE_URL" =~ ^postgres(ql)?:// ]]; then
  error "Invalid DATABASE_URL — must start with postgresql:// or postgres://"
fi

info "Starting Polaris deployment on $(hostname) (remote database mode)"

# Ensure apt is up to date
info "Updating package lists..."
apt-get update -qq

# ─── 1. Install Node.js 20 ───────────────────────────────────────────────────
if command -v node &>/dev/null && [[ "$(node -v)" == v20* || "$(node -v)" == v22* ]]; then
  info "Node.js $(node -v) already installed"
else
  info "Installing Node.js 20 via NodeSource..."
  apt-get install -y ca-certificates curl gnupg
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y nodejs
  info "Node.js $(node -v) installed"
fi

# Allow Node.js to bind to privileged ports (80, 443) without root
info "Granting Node.js low-port binding capability..."
setcap cap_net_bind_service=+ep "$(which node)"

# ─── 2. Install git ──────────────────────────────────────────────────────────
if command -v git &>/dev/null; then
  info "Git already installed"
else
  info "Installing git..."
  apt-get install -y git
  info "Git installed"
fi

# ─── 3. Install PostgreSQL client tools (for pg_dump backups) ────────────────
if command -v pg_dump &>/dev/null; then
  info "PostgreSQL client tools already installed"
else
  info "Installing PostgreSQL client tools..."
  apt-get install -y postgresql-client
  info "PostgreSQL client tools installed"
fi

# ─── 4. Create system user ───────────────────────────────────────────────────
if id "$APP_USER" &>/dev/null; then
  info "User '$APP_USER' already exists"
else
  info "Creating system user '$APP_USER'..."
  useradd --system --shell /bin/false --home-dir "$APP_DIR" --create-home "$APP_USER"
  info "User '$APP_USER' created"
fi

# ─── 5. Test database connectivity ──────────────────────────────────────────
info "Testing database connectivity..."
if command -v psql &>/dev/null; then
  if psql "$DATABASE_URL" -c "SELECT 1" &>/dev/null; then
    info "Database connection successful"
  else
    warn "Could not connect to database — check your DATABASE_URL. Continuing anyway (the database may not be ready yet)."
  fi
fi

# ─── 6. Deploy application ───────────────────────────────────────────────────
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

# ─── 7. Configure environment ────────────────────────────────────────────────
if [[ ! -f "$APP_DIR/.env" ]]; then
  info "Creating .env..."
  SESSION_SECRET=$(openssl rand -base64 32)
  cat > "$APP_DIR/.env" <<ENVFILE
# Database (remote)
DATABASE_URL=${DATABASE_URL}

# App
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# Auth
SESSION_SECRET=${SESSION_SECRET}
ENVFILE
  chown "$APP_USER:$APP_GROUP" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  info ".env created with remote DATABASE_URL"
else
  info ".env already exists — skipping"
  warn "Verify DATABASE_URL in $APP_DIR/.env points to the correct remote database"
fi

# ─── 8. Install dependencies & build ─────────────────────────────────────────
info "Installing dependencies..."
sudo -u "$APP_USER" npm ci --production=false

info "Building TypeScript..."
sudo -u "$APP_USER" npx tsc

info "Running database migrations..."
sudo -u "$APP_USER" npx prisma migrate deploy

# Seed on first deploy — check via the app's own database connection
HAS_USERS=$(sudo -u "$APP_USER" node --env-file=.env -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.user.count().then(c => { console.log(c); p.\$disconnect(); }).catch(() => { console.log(0); p.\$disconnect(); });
" 2>/dev/null || echo "0")
HAS_USERS=$(echo "$HAS_USERS" | tr -d '[:space:]')
if [[ "$HAS_USERS" == "" || "$HAS_USERS" == "0" ]]; then
  info "Seeding default admin (skipped in production — use the first-run wizard or restore from backup)..."
  sudo -u "$APP_USER" node --env-file=.env --import tsx/esm prisma/seed.ts || true
else
  info "Database already seeded ($HAS_USERS users) — skipping"
fi

# ─── 9. Install systemd service ──────────────────────────────────────────────
info "Installing systemd service..."
cp "$APP_DIR/deploy/polaris.service" /etc/systemd/system/polaris.service
# Remove PostgreSQL dependency since the DB is remote
sed -i 's/After=network.target postgresql.service/After=network.target/' /etc/systemd/system/polaris.service
sed -i '/^Requires=postgresql.service/d' /etc/systemd/system/polaris.service
systemctl daemon-reload
systemctl enable --now polaris

info "Waiting for service to start..."
sleep 2

if systemctl is-active --quiet polaris; then
  info "Polaris service is running"
else
  warn "Service may not have started — check: journalctl -u polaris -f"
fi

# ─── 10. Firewall ────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  info "Opening port 3000 in firewall..."
  ufw allow 3000/tcp
  if ufw status | grep -q "Status: active"; then
    info "UFW is active — rule applied"
  else
    warn "UFW is installed but inactive — rule saved but not enforced"
  fi
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
info "============================================"
info "  Polaris deployment complete!"
info "  Mode:  Remote database"
info "  URL:   http://$(hostname -I | awk '{print $1}'):3000"
info "  Login: admin / admin"
info "  Logs:  journalctl -u polaris -f"
info "============================================"
echo ""
warn "Change the default admin password after first login!"
