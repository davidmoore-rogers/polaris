#!/bin/bash
# deploy/scripts/polaris-nginx-apply.sh — privileged wrapper for the polaris OS
# user. Installed at /usr/local/sbin/polaris-nginx-apply by setup-rhel.sh,
# migrate-to-nginx.sh, and auto-synced on every in-app update via
# src/services/updateService.ts.
#
# Granted to polaris through /etc/sudoers.d/polaris-nginx as NOPASSWD on this
# one binary; called from src/services/privilegedSysadmin.ts. This wrapper is
# the ENTIRE attack surface granted to the polaris user — sudoers does not
# restrict subcommand or argument shape, so all validation lives here.
#
# Subcommands accept NO user-supplied file paths. Staged files live at
# hardcoded /run/polaris-nginx-stage/ paths the polaris user writes to before
# sudo-ing this script; we read from those fixed locations only.
#
#   apply-config        — install /run/polaris-nginx-stage/polaris.conf,
#                         validate via `nginx -t`, atomic-rename into place,
#                         reload nginx. Rolls back to the most recent .bak
#                         on `nginx -t` failure.
#   rotate-cert         — install /run/polaris-nginx-stage/{cert,key}.pem
#                         (mode 0640 root:nginx, SELinux httpd_sys_content_t),
#                         reload nginx. nginx's graceful-reload semantics keep
#                         old workers serving the old cert if reload fails.
#   reload              — `nginx -t && systemctl reload nginx`
#   verify-listening N  — emit `ss -ltnp` and `ss -lunp` filtered for :N so
#                         the GUI can warn if the firewall is blocking the
#                         new port after a port change.
#
# All ops serialize via flock on /run/polaris-nginx-apply.lock so a concurrent
# updateService nginx-config sync can't interleave with a GUI apply. Each op
# is wrapped in `timeout 30` to bound runtime — `nginx -t` + reload routinely
# complete in < 2s, so anything past 30s is stuck.

set -euo pipefail

STAGE_DIR=/run/polaris-nginx-stage
LIVE_CONF=/etc/nginx/conf.d/polaris.conf
LIVE_CERT=/etc/polaris-nginx/cert.pem
LIVE_KEY=/etc/polaris-nginx/key.pem
LOCK_FILE=/run/polaris-nginx-apply.lock

usage() {
  cat >&2 <<USAGE
Usage: polaris-nginx-apply <subcommand>
  apply-config        install staged nginx config, validate, reload
  rotate-cert         install staged cert+key pair, reload
  reload              nginx -t && systemctl reload nginx
  verify-listening N  show TCP+UDP listeners filtered to port N
USAGE
  exit 64
}

die() { echo "polaris-nginx-apply: $*" >&2; exit 1; }

acquire_lock() {
  # Bind fd 9 to the lock file so flock holds across the rest of the script;
  # the kernel releases it on process exit (success, failure, or signal).
  exec 9>"$LOCK_FILE"
  flock -x -w 30 9 || die "could not acquire $LOCK_FILE within 30s (another apply in progress?)"
}

require_regular_file() {
  local path=$1
  [ -f "$path" ]   || die "missing staged file: $path"
  [ -s "$path" ]   || die "staged file is empty: $path"
  [ ! -L "$path" ] || die "staged file must not be a symlink: $path"
}

do_apply_config() {
  require_regular_file "$STAGE_DIR/polaris.conf"
  acquire_lock

  if [ -f "$LIVE_CONF" ]; then
    cp -p "$LIVE_CONF" "$LIVE_CONF.bak.$(date +%s)"
  fi

  install -o root -g root -m 0644 "$STAGE_DIR/polaris.conf" "$LIVE_CONF.new"
  mv -f "$LIVE_CONF.new" "$LIVE_CONF"
  rm -f "$STAGE_DIR/polaris.conf"

  if ! timeout 30 nginx -t >/tmp/polaris-nginx-t.log 2>&1; then
    local latest_bak
    latest_bak=$(ls -1t "$LIVE_CONF.bak."* 2>/dev/null | head -1 || true)
    if [ -n "$latest_bak" ]; then
      cp -f "$latest_bak" "$LIVE_CONF"
      echo "nginx -t failed; reverted live config to $latest_bak" >&2
    fi
    cat /tmp/polaris-nginx-t.log >&2
    exit 1
  fi

  timeout 30 systemctl reload nginx
  echo "ok: nginx config applied + reloaded"
}

do_rotate_cert() {
  require_regular_file "$STAGE_DIR/cert.pem"
  require_regular_file "$STAGE_DIR/key.pem"
  acquire_lock

  if [ -f "$LIVE_CERT" ] && [ -f "$LIVE_KEY" ]; then
    local ts; ts=$(date +%s)
    cp -p "$LIVE_CERT" "$LIVE_CERT.bak.$ts"
    cp -p "$LIVE_KEY"  "$LIVE_KEY.bak.$ts"
  fi

  install -o root -g nginx -m 0640 "$STAGE_DIR/cert.pem" "$LIVE_CERT.new"
  install -o root -g nginx -m 0640 "$STAGE_DIR/key.pem"  "$LIVE_KEY.new"
  mv -f "$LIVE_CERT.new" "$LIVE_CERT"
  mv -f "$LIVE_KEY.new"  "$LIVE_KEY"
  rm -f "$STAGE_DIR/cert.pem" "$STAGE_DIR/key.pem"

  if command -v restorecon >/dev/null 2>&1; then
    restorecon "$LIVE_CERT" "$LIVE_KEY" >/dev/null 2>&1 || true
  fi

  if ! timeout 30 systemctl reload nginx; then
    echo "systemctl reload nginx failed; old workers may still be serving old cert" >&2
    journalctl -u nginx -n 20 --no-pager >&2 || true
    exit 1
  fi
  echo "ok: cert rotated + nginx reloaded"
}

do_reload() {
  acquire_lock
  if ! timeout 30 nginx -t >/tmp/polaris-nginx-t.log 2>&1; then
    cat /tmp/polaris-nginx-t.log >&2
    exit 1
  fi
  timeout 30 systemctl reload nginx
  echo "ok: nginx reloaded"
}

do_verify_listening() {
  local port=${1:-}
  [[ "$port" =~ ^[0-9]+$ ]] || die "verify-listening requires a numeric port"
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    die "port out of range: $port"
  fi
  echo "# TCP listeners on :$port"
  ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p { print }' || true
  echo "# UDP listeners on :$port"
  ss -lunp 2>/dev/null | awk -v p=":$port" '$4 ~ p { print }' || true
}

[ $# -ge 1 ] || usage
subcommand=$1
shift

case "$subcommand" in
  apply-config)     do_apply_config ;;
  rotate-cert)      do_rotate_cert ;;
  reload)           do_reload ;;
  verify-listening) do_verify_listening "$@" ;;
  *)                usage ;;
esac
