# Polaris — Install Guide

This guide covers fresh installs on **RHEL / Rocky / AlmaLinux 9**, **Ubuntu / Debian**, and **Windows Server**. The runtime itself is platform-portable; the only differences between platforms are package names, service managers, and where PostgreSQL puts its data directory.

If you're upgrading an existing install rather than installing fresh, use the in-app updater under **Server Settings → Maintenance → Updates**. Don't follow this document for upgrades.

---

## Disk sizing — read this first

The single most common operational footgun on a fresh Polaris install is undersized `/var` (Linux) or undersized `C:` (Windows) — both are where PostgreSQL stores its data by default. Sample tables grow with monitored asset count × probe cadence × retention, so a deployment that's small at week 1 can hit 100% in month 6.

| Volume | Minimum | Recommended | What lives here |
|---|---|---|---|
| **DB data volume** | 50 GB | 100 GB+ | PostgreSQL `data_directory`. On RHEL: `/var/lib/pgsql/data`. On Ubuntu: `/var/lib/postgresql/<ver>/main`. On Windows: `C:\Program Files\PostgreSQL\<ver>\data`. |
| **App / state volume** | 5 GB | 20 GB | Polaris install dir, encrypted DB backups (`data/backups/`), uploaded device icons, update staging (one extra copy of the bundle per update). |
| **`/var/log` (Linux only, if separate)** | 5 GB | 10 GB | systemd journal, audit logs, syslog forwarding spool. |
| **`/var/log/audit` (RHEL STIG only, if separate)** | 5 GB | 10 GB | auditd events. Fills faster than expected on busy hosts. |

The **DB volume number is the one that matters most.** Aim high; Postgres degrades hard when its volume hits 100% (postmaster will crash on WAL writes during recovery, see *Recovery* below).

The setup wizard runs a preflight check that statfs's the conventional PGDATA paths after you click **Test Connection** and surfaces a warning if free space is below the recommended minimum. The runtime check (Server Settings → Maintenance) then watches the actual `SHOW data_directory` value across all volumes.

---

## RHEL / Rocky / AlmaLinux 9

> **Note:** This walkthrough installs PostgreSQL from PGDG (the official PostgreSQL Global Development Group repo), not the RHEL AppStream module. PGDG matches upstream within days, supports the full Postgres extension ecosystem (TimescaleDB, PostGIS, etc.), and supports side-by-side major versions. AppStream's module ships a curated subset and lags upstream; in particular, **the TimescaleDB package targets PGDG only** — the AppStream `postgresql:15` module's package names (`postgresql-server`) don't satisfy `timescaledb-2-postgresql-15`'s requirement on `postgresql15-server`. If you have an existing AppStream install you want to migrate from, see *Migrating from AppStream to PGDG* below.

### 1. PostgreSQL (PGDG)

```bash
# Install the PGDG repo
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm

# Disable RHEL's AppStream postgresql module so PGDG's packages aren't shadowed
sudo dnf -qy module disable postgresql

# Install Postgres 15 + contrib (needed for various Polaris features)
sudo dnf install -y postgresql15 postgresql15-server postgresql15-contrib

# Initialize PGDATA and start the service
sudo /usr/pgsql-15/bin/postgresql-15-setup initdb
sudo systemctl enable --now postgresql-15
```

PGDATA lands at `/var/lib/pgsql/15/data`. Verify the disk holding `/var/lib/pgsql` has at least 50 GB free:

```bash
df -h /var/lib/pgsql
```

If `/var` is on its own LV (the typical STIG-hardened layout) and has less than 50 GB, **stop here and grow it** before continuing. See *Growing /var on RHEL* below.

### 2. Database + user

```bash
sudo -u postgres psql <<'SQL'
CREATE USER polaris WITH PASSWORD 'change-me';
CREATE DATABASE polaris OWNER polaris;
GRANT pg_read_all_settings TO polaris;

-- pg-boss (queue runtime for monitor cadences at scale) lives in its
-- own `pgboss` schema. The polaris role needs to own it so pg-boss can
-- create its tables on first boot. Pre-creating with the right owner
-- here prevents the schema from being created later by a different role
-- (which would lock polaris out and force a fallback to cursor mode).
\c polaris
CREATE SCHEMA IF NOT EXISTS pgboss;
ALTER SCHEMA pgboss OWNER TO polaris;
GRANT ALL ON SCHEMA pgboss TO polaris;
GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO polaris;
SQL
```

The `pg_read_all_settings` grant lets Polaris read `SHOW data_directory` so the Maintenance tab can measure the `/var` filesystem and alert before it fills.

The `pgboss` schema grants are required for pg-boss queue mode (operators with thousands of monitored assets). Without them, "permission denied for schema pgboss" appears in `journalctl -u polaris` and Polaris falls back to in-process cursor mode — fine for small/medium fleets, won't keep up at thousands. The scripted installs (`deploy/setup-rhel.sh`, `deploy/setup-ubuntu.sh`) run these grants for you; manual or remote-DB installs need to run them once. **Remote/managed PostgreSQL (RDS, Cloud SQL, Neon, etc.):** hand the `\c polaris ... ALTER DEFAULT PRIVILEGES ...` block to your DBA to run on the polaris database.

Allow the postgres directory to be traversed by the polaris OS user (needed for the same disk-space check — `statfs` on `/var/lib/pgsql/15/data` requires search permission on every ancestor directory). The PostgreSQL startup scripts reset these directories to `700` on every restart, so persist via a systemd override rather than a one-off chmod:

```bash
sudo systemctl edit postgresql-15
```

Add the following and save:

```ini
[Service]
ExecStartPost=/bin/chmod o+x /var/lib/pgsql
ExecStartPost=/bin/chmod o+x /var/lib/pgsql/15
```

Then reload and apply immediately:

```bash
sudo systemctl daemon-reload
sudo chmod o+x /var/lib/pgsql /var/lib/pgsql/15
```

Edit `/var/lib/pgsql/15/data/pg_hba.conf` and add a line for the polaris user (typically `host polaris polaris 127.0.0.1/32 scram-sha-256`), then `sudo systemctl reload postgresql-15`.

### 3. Node.js 20+

```bash
sudo dnf module reset nodejs -y
sudo dnf module enable nodejs:20 -y
sudo dnf install -y nodejs
```

### 4. Polaris

```bash
# Polaris install lives at /opt/polaris by convention
sudo mkdir -p /opt/polaris
sudo chown polaris:polaris /opt/polaris
# … extract release tarball into /opt/polaris …

cd /opt/polaris
npm ci --omit=dev
```

### 5. Run the install script

Since Phase 3, fresh installs land the split-role systemd layout
(`polaris.target` + `polaris-web` + `polaris-monitor@1..@N` + `polaris-discovery`
+ `polaris-migrate`) + nginx-fronted HTTPS in one command. The legacy
single-process `polaris.service` is no longer shipped.

```bash
sudo bash deploy/setup-rhel.sh --public-url https://polaris.example.com
```

What the script does, in order: installs Node + Postgres + Go + nginx
(mainline from nginx.org for HTTP/3 ≥ 1.25), creates the `polaris` system
user + DB + role, clones the repo, builds, runs migrations, generates a
self-signed cert for the supplied hostname under `/etc/polaris-nginx/`,
installs the split-role systemd units + a `Wants=nginx` drop-in on
`polaris-web`, sets `POLARIS_PROXY_CERT_PATH` + `POLARIS_PUBLIC_URL` in
`.env`, opens TCP+UDP/443 in firewalld, and starts `polaris.target` (which
brings up nginx first via the drop-in, then `polaris-web` in HTTP-only
proxy mode on `127.0.0.1:3000`).

Options:
- `--public-url <https://hostname>` — REQUIRED (well, defaulted to
  `https://$(hostname -f)` if you skip it). The cert + nginx `server_name`
  use whatever hostname is in this URL.
- `--monitor-replicas N` — number of `polaris-monitor@N` instances to
  enable. Default 2.
- `--prometheus-ip <IP>` — the IP the nginx `/metrics-*` locations allow.
  Default `127.0.0.1`. Update later with a drop-in if Prometheus is
  off-host.

Browse to `https://<your-hostname>/` to run the first-run setup wizard.
Self-signed cert in use; replace `/etc/polaris-nginx/{cert,key}.pem` with
your real cert + `systemctl reload nginx` whenever you're ready.

### Growing `/var` on RHEL

If the install template gave `/var` a small LV (8 GB is common), grow it before continuing:

```bash
# Check current sizing + free LVM space
vgs vg1
pvs
lsblk

# If `vgs` shows VFree near zero AND `lsblk` shows free space at the
# end of /dev/sda, grow the partition first
sudo parted -s /dev/sda resizepart 3 100%
sudo partprobe /dev/sda
sudo pvresize /dev/sda3

# Now grow /var (XFS or ext4 — the -r flag handles both)
sudo lvextend -r -L +20G /dev/vg1/var
df -h /var
```

If you can't grow `/var`, the alternative is to relocate PGDATA to `/opt` (which usually has ample space): stop postgres, `rsync -aHAX /var/lib/pgsql/15/ /opt/pgsql/`, set `Environment=PGDATA=/opt/pgsql/data` via a systemd drop-in, fix SELinux contexts with `sudo semanage fcontext -a -e /var/lib/pgsql /opt/pgsql && sudo restorecon -R /opt/pgsql`, then daemon-reload and start postgres.

### Migrating from AppStream Postgres to PGDG

If you already have a working Polaris install on AppStream Postgres and want to switch to PGDG (typically because you want TimescaleDB), the migration is a dump → install PGDG → restore cycle. Plan ~15-30 min of downtime; the dump itself is the bottleneck and scales with your fleet's data volume.

```bash
# 1. Dump the existing database (run as postgres OS user — peer auth)
sudo systemctl stop polaris
sudo -u postgres pg_dump polaris --clean --if-exists --no-owner --no-acl > /tmp/polaris.sql
sudo systemctl stop postgresql

# 2. Install PGDG, disable the AppStream module
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
sudo dnf -qy module disable postgresql
sudo dnf install -y postgresql15 postgresql15-server postgresql15-contrib
sudo /usr/pgsql-15/bin/postgresql-15-setup initdb

# 3. Verify pg_hba.conf uses scram-sha-256 (default on PGDG; check anyway)
sudo grep -E '^(local|host)' /var/lib/pgsql/15/data/pg_hba.conf | head -5
# If you see ident/md5 on the 127.0.0.1 lines, edit to scram-sha-256

# 4. Apply the chmod-traversable override (see step 2 above) BEFORE starting,
#    then start the new instance
sudo systemctl edit postgresql-15  # add the [Service] block from above
sudo systemctl daemon-reload
sudo chmod o+x /var/lib/pgsql /var/lib/pgsql/15
sudo systemctl disable postgresql
sudo systemctl enable --now postgresql-15

# 5. Recreate the polaris role + database
PWORD=$(sudo grep -oP 'polaris:\K[^@]+' /opt/polaris/.env)
sudo -u postgres psql <<EOF
CREATE USER polaris WITH PASSWORD '$PWORD';
CREATE DATABASE polaris OWNER polaris;
GRANT pg_read_all_settings TO polaris;
EOF

# 6. Restore the dump (as postgres, since the dump used --no-owner)
sudo -u postgres psql -d polaris < /tmp/polaris.sql

# 7. Reassign ownership of all polaris-database objects to the polaris role
#    (--no-owner restored everything as postgres; polaris needs ownership
#    to ALTER its tables, including the create_hypertable conversion that
#    runs at Polaris boot once TimescaleDB is installed)
sudo -u postgres psql -d polaris <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO polaris', r.tablename);
  END LOOP;
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO polaris', r.sequence_name);
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO polaris', r.viewname);
  END LOOP;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO polaris;
SQL

# 8. Re-run the install script — it'll re-stage the split-role units against
#    postgresql-15.service and bring polaris.target back up against the
#    migrated DB.
sudo bash deploy/setup-rhel.sh --public-url https://polaris.example.com

# 9. Optionally remove the abandoned AppStream PGDATA
sudo test -f /var/lib/pgsql/data/PG_VERSION && echo "OLD DATA STILL EXISTS — DO NOT DELETE" || sudo rm -rf /var/lib/pgsql/data

# 10. Start Polaris and watch the boot
sudo systemctl start polaris
sudo journalctl -u polaris -f --no-pager
```

After step 10 succeeds, follow *Recommended: TimescaleDB* below to install the extension. On the first restart afterward, Polaris detects the extension and converts the eighteen monitoring sample tables to hypertables — six source tables plus twelve `*_hourly` / `*_daily` rollup tables produced by the tiered-retention rollup job (~5-15 min for a fleet that's been running for weeks; no operator action required, just patience as conversions log in the journal).

### Recovery: postgres crashes on a full /var

If `/var` filled and postgres is now crash-looping with `PANIC: could not write to file "pg_wal/xlogtemp.NNNN": No space left on device`, **don't touch pg_wal/ manually** — that corrupts the database. Recovery only needs ~50 MB free to complete:

```bash
# Free space safely first
sudo rm /var/lib/pgsql/15/data/log/postgresql-Wed.log    # rotator overwrites next week
sudo dnf clean all
sudo journalctl --vacuum-size=50M

# Then start postgres
sudo systemctl start postgresql-15
```

Watch for `database system is ready to accept connections`. Once recovery completes, `pg_wal` segments get recycled and free a few hundred MB. Then start polaris.

---

## Ubuntu / Debian

### 1. PostgreSQL

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

PGDATA on Ubuntu is **`/var/lib/postgresql/<version>/main`** — note the version-suffix. The systemd unit name is also versioned (e.g. `postgresql@15-main.service`). Verify free space:

```bash
df -h /var/lib/postgresql
```

### 2. Database + user

```bash
sudo -u postgres psql <<'SQL'
CREATE USER polaris WITH PASSWORD 'change-me';
CREATE DATABASE polaris OWNER polaris;
GRANT pg_read_all_settings TO polaris;

-- pg-boss (queue runtime for monitor cadences at scale) lives in its
-- own `pgboss` schema. The polaris role needs to own it so pg-boss can
-- create its tables on first boot. Pre-creating with the right owner
-- here prevents the schema from being created later by a different role
-- (which would lock polaris out and force a fallback to cursor mode).
\c polaris
CREATE SCHEMA IF NOT EXISTS pgboss;
ALTER SCHEMA pgboss OWNER TO polaris;
GRANT ALL ON SCHEMA pgboss TO polaris;
GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO polaris;
SQL
```

The `pg_read_all_settings` grant lets Polaris read `SHOW data_directory` so the Maintenance tab can measure the `/var` filesystem and alert before it fills.

The `pgboss` schema grants are required for pg-boss queue mode (operators with thousands of monitored assets). Without them, "permission denied for schema pgboss" appears in `journalctl -u polaris` and Polaris falls back to in-process cursor mode — fine for small/medium fleets, won't keep up at thousands. The scripted installs (`deploy/setup-rhel.sh`, `deploy/setup-ubuntu.sh`) run these grants for you; manual or remote-DB installs need to run them once. **Remote/managed PostgreSQL (RDS, Cloud SQL, Neon, etc.):** hand the `\c polaris ... ALTER DEFAULT PRIVILEGES ...` block to your DBA to run on the polaris database.

Allow the postgres directory to be traversed by the polaris OS user. Persist it via a systemd override so it survives PostgreSQL restarts (replace `<version>` with your installed version, e.g. `15`):

```bash
sudo systemctl edit postgresql@<version>-main
```

Add the following and save:

```ini
[Service]
ExecStartPost=/bin/chmod o+x /var/lib/postgresql
```

Then reload and apply immediately:

```bash
sudo systemctl daemon-reload
sudo chmod o+x /var/lib/postgresql
```

Edit `/etc/postgresql/<version>/main/pg_hba.conf` to add the polaris user, then `sudo systemctl reload postgresql`.

### 3. Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 4. Polaris

Same as RHEL — install to `/opt/polaris`, run `npm ci --omit=dev`.

### 5. Run the install script

Since Phase 3, the Ubuntu/Debian install script lands the split-role
systemd layout + nginx-fronted HTTPS in one command (same as RHEL):

```bash
sudo bash deploy/setup-ubuntu.sh --public-url https://polaris.example.com
```

The script installs nginx mainline from nginx.org's Debian/Ubuntu repo
(distro nginx is too old for HTTP/3), generates a self-signed cert, drops
the split-role units (rewritten to depend on Ubuntu/Debian's
`postgresql.service` meta-service instead of RHEL's `postgresql-15.service`),
opens TCP+UDP/443 in ufw, and starts `polaris.target`. Browse to
`https://<your-hostname>/` to run the first-run setup wizard.

The same `--public-url` / `--monitor-replicas` / `--prometheus-ip` flags
documented above for setup-rhel.sh apply here too.

---

## Windows Server

### 1. PostgreSQL

Download the EnterpriseDB installer from <https://www.postgresql.org/download/windows/> and run it. Default install path is `C:\Program Files\PostgreSQL\<version>\` with PGDATA at `C:\Program Files\PostgreSQL\<version>\data`.

The installer registers PostgreSQL as a Windows service. Verify free space on the drive holding PGDATA (usually `C:`):

```powershell
Get-PSDrive -Name C
```

If `C:` has less than 50 GB free, **install PGDATA on a different drive** during the EnterpriseDB installer flow (the installer prompts for the data directory location). Don't try to expand `C:` after the fact.

### 2. Database + user

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres
```

```sql
CREATE USER polaris WITH PASSWORD 'change-me';
CREATE DATABASE polaris OWNER polaris;
\c polaris
CREATE SCHEMA IF NOT EXISTS pgboss;
ALTER SCHEMA pgboss OWNER TO polaris;
GRANT ALL ON SCHEMA pgboss TO polaris;
GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO polaris;
\q
```

Edit `pg_hba.conf` (in the data directory) to add a line for the polaris user, then restart the PostgreSQL service from `services.msc`.

The `pgboss` schema grants are required for pg-boss queue mode (operators with thousands of monitored assets). Without them Polaris falls back to in-process cursor mode — fine for small/medium fleets, won't keep up at thousands.

### 3. Node.js 20+

Download the LTS installer from <https://nodejs.org/> and run it.

### 4. Polaris

Extract the release zip to a directory of your choice (e.g. `C:\Polaris`). From an admin PowerShell:

```powershell
cd C:\Polaris
npm ci --omit=dev
```

### 5. NSSM service wrapper

Polaris on Windows runs under [NSSM](https://nssm.cc/) (Non-Sucking Service Manager). Download nssm.exe and register the service:

```powershell
nssm install Polaris "C:\Program Files\nodejs\node.exe" "C:\Polaris\dist\index.js"
nssm set Polaris AppDirectory "C:\Polaris"
nssm set Polaris DependOnService postgresql-x64-17
nssm set Polaris Start SERVICE_AUTO_START
nssm start Polaris
```

`DependOnService` is the Windows equivalent of systemd's `Requires=` — Polaris won't try to start until PostgreSQL is up. Adjust the version suffix to match your install (`postgresql-x64-15` etc.).

Browse to `http://<host>:3000` to run the setup wizard.

---

## The split-role deployment (web / monitor / discovery)

Since Phase 3 this is the **default and only supported production layout**
on Linux. `deploy/setup-rhel.sh` and `deploy/setup-ubuntu.sh` install it
automatically; the legacy single-process `polaris.service` unit is no
longer shipped. This section documents what the install scripts actually
do, for operators who want to understand the layout or customize it
post-install.

Polaris's workload splits across processes so discovery's CPU/DB-heavy
phases can't starve the monitor workers (they don't share one Node event
loop). The split coordinates through the **pg-boss queue** (enabled at
boot via `Setting.monitor.queueMode = "pgboss"`).

The roles (chosen per-process via `POLARIS_ROLE`):

- **web** — HTTP-only on `127.0.0.1:3000` (nginx terminates TLS) + all singleton schedulers + one-shot migrations. Single instance (control plane). Owns the in-app updater.
- **monitor** — pg-boss monitor-queue consumers. Run **N replicas**; pg-boss gives each job to exactly one worker.
- **discovery** — pg-boss discovery-queue consumer.
- **migrate** — oneshot `prisma migrate deploy` at boot; the app services gate on its completion.

The `all` role still exists in `src/utils/role.ts` (one process runs every
capability) and is the default when `POLARIS_ROLE` is unset — that's what
`npm run dev` uses. **Production never ships `all` mode**: no `polaris.service`
unit is shipped, no `--without-split` flag exists on the setup scripts.

### systemd (RHEL/Ubuntu)

`deploy/setup-rhel.sh` + `deploy/setup-ubuntu.sh` install the units below
automatically. This is the manual equivalent for operators who want to
re-deploy from a fresh checkout:

```bash
# Copy the role units + the migrate one-shot + the grouping target.
sudo cp deploy/polaris-migrate.service deploy/polaris-web.service \
        deploy/polaris-monitor@.service deploy/polaris-discovery.service \
        deploy/polaris.target /etc/systemd/system/

# Ubuntu/Debian: rewrite postgresql-15.service → postgresql.service
# (the meta-service that resolves to the version-specific cluster unit).
# RHEL/Rocky/Alma: leave as-is.
# sudo sed -i 's/postgresql-15\.service/postgresql.service/g' /etc/systemd/system/polaris-*.service

sudo systemctl daemon-reload

# Enable the group + the monitor replicas you want (here: 2).
sudo systemctl enable polaris-monitor@1 polaris-monitor@2
sudo systemctl enable polaris-web polaris-discovery polaris-migrate
sudo systemctl enable --now polaris.target     # "Start Everything"
```

`systemctl start polaris.target` brings up migrate → web → monitor@1..N →
discovery; `systemctl stop polaris.target` stops the group.

**Per-role `/metrics` listeners.** prom-client registries are per-process. The
web role serves `/metrics` on the main HTTPS port; monitor and discovery boot a
standalone `/metrics` listener via `src/utils/metricsServer.ts` on
`POLARIS_METRICS_PORT`. The shipped units default to:

| Role | Default port (bind 127.0.0.1) |
|---|---|
| `polaris-monitor@N` | `910N` (instance `1` → 9101, `2` → 9102, … `9` → 9109) |
| `polaris-discovery` | `9110` |

Prometheus must scrape **every** endpoint or any panel that depends on metrics
stamped from inside a monitor worker (`polaris_probe_*`, `polaris_monitor_work_duration_seconds`,
`polaris_sample_write_duration_seconds`) or discovery consumer
(`polaris_discovery_*`, FMG proxy lane) will silently show "no data" on the
Grafana dashboard. See [docs/grafana/README.md](grafana/README.md#multi-process-split-role-deployments)
for the matching scrape job. Override with a systemd drop-in if you run more
than 9 monitor replicas or need to reach Prometheus from a different host
(`POLARIS_METRICS_BIND=0.0.0.0`).

**Updater group-restart grant.** The in-app updater (Server Settings →
Maintenance) restarts the whole group via `systemd-run … systemctl restart
polaris.target`. Grant the `polaris` user permission with a polkit rule
(`/etc/polkit-1/rules.d/49-polaris.rules`):

```javascript
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      subject.user == "polaris") {
    return polkit.Result.YES;
  }
});
```

**Auto-sync of unit files.** Before restarting `polaris.target` the updater
also syncs `/opt/polaris/deploy/polaris-*.service` and `polaris.target` into
`/etc/systemd/system/`, then runs `systemctl daemon-reload`. Files are
overwritten only when their content differs from what's currently installed,
so this is a no-op on updates that don't touch unit files. **Customize via
drop-ins, not direct edits**: put per-host changes in
`/etc/systemd/system/polaris-monitor@.service.d/local.conf` (or the matching
unit's `.d/` directory) so they survive every update. The transient unit
that runs the sync runs as root via the polkit grant above; no extra sudo /
NOPASSWD entry is required.

### Windows (NSSM)

Register one service per role with the same `AppDirectory`, role via
`AppEnvironmentExtra`, and a migrate step before the app services start
(`npx --no-install prisma migrate deploy`). NSSM's `DependOnService` only orders
start, it doesn't wait for a one-shot to finish — run migrate as a script step,
not a service. Example:

```powershell
nssm install PolarisWeb       "C:\Program Files\nodejs\node.exe" "dist\index.js"
nssm set     PolarisWeb       AppEnvironmentExtra "NODE_ENV=production" "POLARIS_ROLE=web"
nssm install PolarisMonitor1  "C:\Program Files\nodejs\node.exe" "dist\index.js"
nssm set     PolarisMonitor1  AppEnvironmentExtra "NODE_ENV=production" "POLARIS_ROLE=monitor" "POLARIS_METRICS_PORT=9101"
nssm install PolarisDiscovery "C:\Program Files\nodejs\node.exe" "dist\index.js"
nssm set     PolarisDiscovery AppEnvironmentExtra "NODE_ENV=production" "POLARIS_ROLE=discovery" "POLARIS_METRICS_PORT=9110"
```

Add `POLARIS_METRICS_PORT` to each non-web role so Prometheus can scrape its
in-process metrics; see the systemd section above for the role → port mapping
and [docs/grafana/README.md](grafana/README.md#multi-process-split-role-deployments)
for the scrape job.

### Docker

Use the shipped `docker-compose.yml` — one image, per-service `POLARIS_ROLE`, a
one-shot `migrate` service the app services gate on
(`service_completed_successfully`), and `monitor` with `deploy.replicas`.

### Sizing — connections multiply

Each process opens its own Prisma + pg-boss pool, so the group needs roughly
`(monitor replicas + 2) × (DATABASE_POOL_SIZE + POLARIS_PGBOSS_POOL_SIZE)`
connections. Keep that under Postgres `max_connections` (minus headroom for
`pg_dump`, admin sessions). Lower the per-replica `DATABASE_POOL_SIZE` (10–15)
and `POLARIS_PGBOSS_POOL_SIZE` (~10) and set `POLARIS_MONITOR_REPLICAS` on the
web node so the Capacity Advisor sizes `max_connections` correctly. The
shipped setup scripts (`deploy/setup-{rhel,ubuntu}{,-nodb}.sh`) now persist
`POLARIS_MONITOR_REPLICAS` from `--monitor-replicas` into `/opt/polaris/.env`
automatically; if you later scale by `systemctl enable --now polaris-monitor@N`
or pre-fix installs are missing the var, update it by hand and restart
`polaris.target`. The web role logs a warning at boot when the var is unset
in split-role mode.
**PgBouncer** absorbs the Prisma pools (recommended for multi-monitor) but
pg-boss pools always connect to Postgres directly — budget those against the
raw `max_connections`. Per-role footprint is exposed at
`/metrics` as `polaris_db_pool_role_capacity{role}`.

---

## nginx front-end (TLS termination)

nginx terminates TLS for every Polaris install. Fresh installs land this
layout via the setup scripts; existing pre-nginx installs migrate via
`deploy/migrate-to-nginx.sh`. Polaris itself listens HTTP-only on
`127.0.0.1:3000` and exposes the cert nginx serves through the Identification
tab so Polaris Agents can pin against the same leaf nginx presents.

Why nginx fronts the app:

- One external URL for the main app **and** all the role-specific `/metrics`
  endpoints (path-routed: `/metrics`, `/metrics-monitor-1`, `/metrics-monitor-2`,
  `/metrics-discovery`) — no firewall changes per worker port, no
  bearer-in-clear on the worker ports.
- One place to manage cert rotation (a single file nginx reads, plus
  `systemctl reload nginx`).
- HTTP/3 over QUIC out-of-the-box for browser traffic.

### Migrating an existing install

Run `deploy/migrate-to-nginx.sh` on installs that were provisioned before the
nginx-front cutover. The script only supports the split-role layout
(`polaris.target` enabled with the four role units).

### Prerequisites

- The split-role layout (above) must be enabled.
- nginx ≥ 1.25 (HTTP/3 stable). The migration script installs from
  `nginx.org`'s mainline repo if your system nginx is older or missing.
- A working server cert + key already loaded in Polaris's `Setting.certificates`
  (the script extracts the active leaf pair from the DB and hands it to nginx).
- UDP/443 reachable from clients you want to serve HTTP/3 to. The script opens
  TCP+UDP/443 in `firewalld` on the local host; any upstream firewalls /
  load balancers also need UDP/443 open. Clients fall back to TCP transparently
  if UDP is blocked anywhere along the path.
- A decision on which IP is allowed to scrape `/metrics-*` (your Prometheus
  host). The script writes an `allow <PROMETHEUS_IP>; deny all;` block on
  those four nginx locations as the first defense layer; bearer auth via
  `METRICS_TOKEN` is the second layer.

### Migration

```bash
sudo bash /opt/polaris/deploy/migrate-to-nginx.sh \
  --public-url https://polaris.example.com \
  --prometheus-ip 10.0.0.42
```

The script is transactional — it backs up `/opt/polaris/.env` first, stages
nginx config + cert files in `/tmp/`, validates with `nginx -t` before
committing, and rolls back automatically on failure at any gate. It's also
idempotent: re-running detects the migrated state and exits cleanly.

What it does in order:

1. Confirms `polaris.target` is enabled.
2. Ensures nginx ≥ 1.25 is installed (replaces older RHEL AppStream nginx
   with `nginx.org`'s mainline if needed).
3. Extracts the active `category="server"` cert + key from
   `Setting.certificates` via Prisma and writes
   `/etc/polaris-nginx/{cert,key}.pem` with `0640 root:nginx` permissions
   and SELinux `httpd_sys_content_t` context (persistent via `semanage
   fcontext` + `restorecon`).
4. Installs `deploy/nginx/polaris.conf` into `/etc/nginx/conf.d/polaris.conf`
   with `<PROMETHEUS_IP>` substituted. Validates with `nginx -t`.
5. Installs a systemd drop-in at `/etc/systemd/system/polaris-web.service.d/`
   that makes polaris-web `Wants=` nginx — nginx starts first, but a failed
   nginx doesn't block polaris-web (so you can SSH in and fix nginx without
   a separate broken-Polaris problem).
6. Installs the in-app nginx GUI helpers:
   `/usr/local/sbin/polaris-nginx-apply` (the privileged wrapper for the
   Server Settings → Certificates GUI), `/etc/sudoers.d/polaris-nginx`
   (narrow NOPASSWD grant on the one binary), `/etc/tmpfiles.d/polaris-nginx.conf`
   (staging dir entry), and adds the `polaris` user to the `nginx` group
   so the existing fingerprint pane can read the `0640 root:nginx` cert
   file directly. Existing installs picking this up via in-app update get
   the same wiring through `restartService()`'s sync block.
7. Appends `POLARIS_PROXY_CERT_PATH` + `POLARIS_PUBLIC_URL` to `/opt/polaris/.env`.
8. Opens TCP+UDP/443 in `firewalld`.
9. `systemctl daemon-reload`, `systemctl enable --now nginx`,
   `systemctl reload nginx`, `systemctl restart polaris.target`.
10. Smoke tests: TCP + UDP listeners on 443, `Alt-Svc: h3` header, Polaris
    bound to `127.0.0.1:3000`, `/metrics-monitor-1` returns 200 or 401 (not 5xx).

### After migration: the in-app nginx GUI

Server Settings → Certificates now shows the in-app nginx GUI: the
**HTTPS Certificate** card (read-only metadata + a **Rotate certificate**
button), an **nginx Proxy** card with the six controls (HTTPS port, HTTP/3
toggle, TLS protocols, HSTS, Prometheus allow-list), and the **Trusted
Certificate Authorities** card (unchanged).

A yellow drift banner reads "nginx config not Polaris-managed yet" until
you click **Adopt managed mode**. Until then the controls are read-only and
Polaris will not touch your nginx config on in-app updates. If you've
hand-edited `/etc/nginx/conf.d/polaris.conf` beyond the six controls (extra
location blocks, custom headers, custom timeouts), the banner lists what
it detected — adopting will overwrite those hand-edits on the next Apply.

Click **Adopt managed mode** to unlock. From there:

- **Save & Apply** stages a rendered config to `/run/polaris-nginx-stage/`,
  validates via `nginx -t`, atomic-renames into place, and `systemctl reload
  nginx`s. The wrapper rolls back to the most recent `.bak` if `nginx -t`
  fails.
- **Rotate certificate** orchestrates the dual-pin workflow: upload cert+key
  → stage the new pin on every active agent via `/agents/cert-pins/bulk-add`
  (so they accept both old + new) → swap the cert file + reload nginx →
  retire the old pin via `/agents/cert-pins/bulk-remove`. Zero-downtime if
  all agents are online during the staging step.

**Firewall reminder.** Changing the HTTPS port via the GUI requires you to
manually open `<new>/tcp` + `<new>/udp` in firewalld — Polaris will not
modify firewall rules from the UI (lockout footgun). The GUI banner after
Apply reminds you to do this.

### Verifying

```bash
ss -ltnp | grep ':443'       # nginx TCP listener
ss -lunp | grep ':443'       # nginx UDP listener (HTTP/3)
ss -ltnp | grep ':3000'      # Polaris bound to 127.0.0.1 only

curl -sI https://polaris.example.com/ | grep -i alt-svc
# expects: alt-svc: h3=":443"; ma=86400

METRICS_TOKEN=$(grep ^METRICS_TOKEN /opt/polaris/.env | cut -d= -f2-)
curl -sH "Authorization: Bearer $METRICS_TOKEN" https://polaris.example.com/metrics-monitor-1 \
  | grep -c '^polaris_monitor_work_total'
# expects a positive count
```

### Operational notes

- **Cert rotation requires the dual-pin window.** Existing agents pin the
  current leaf cert's SHA-256. Before rolling nginx's cert, stage the new
  leaf's fingerprint via Server Settings → Maintenance → "Cert pin rotation"
  → bulk-add. Once every agent has applied the staged pin (visible in the
  Agents tab), roll the cert in nginx, then bulk-remove the old pin.
- **Operator customization belongs in drop-ins, not the main config files.**
  The in-app updater (Server Settings → Maintenance → Apply Update) syncs
  `deploy/nginx/polaris.conf` into `/etc/nginx/conf.d/polaris.conf` on every
  update (cmp-only, no-op when unchanged) — direct edits there get clobbered.
  Use `/etc/nginx/conf.d/polaris-local.conf` or a per-server-block drop-in.
  Same convention for systemd: edit `<unit>.service.d/*.conf`, not the unit file itself.
- **HTTP/3 / QUIC may be blocked by corporate firewalls or IDS**. Clients
  transparently fall back to TCP/HTTP-2 in that case (worst case: no HTTP/3
  benefit, not a broken site). Confirm with network ops that UDP/443 isn't
  blocked between your operator workstations and the prod box.
- **The Polaris Agent stays on TCP/HTTP-2.** Go's stdlib `net/http` doesn't
  speak HTTP/3 — agent traffic (heartbeat, samples, enroll, config) uses
  the TCP listener, which carries the same cert and same auth. HTTP/3
  benefits only browser traffic.

---

## Recommended: TimescaleDB

Polaris's monitoring data lives in eighteen sample tables: six source tables (`asset_monitor_samples`, `asset_telemetry_samples`, `asset_temperature_samples`, `asset_interface_samples`, `asset_storage_samples`, `asset_ipsec_tunnel_samples`) that hold raw per-cadence samples, plus twelve `*_hourly` / `*_daily` rollup tables produced by the tiered-retention rollup job (one hourly + one daily companion per source). All eighteen are append-only / upsert-only time-series. Plain Postgres handles them fine at small scale, but once the combined size crosses ~1 GB the daily retention prune starts seq-scanning hundreds of millions of rows, contending with normal write load. **TimescaleDB** (an official Postgres extension) converts all of them to hypertables with chunk-based partitioning and native compression:

- Daily prune becomes `DROP CHUNK` (instant, no seq-scan, no lock contention)
- Compressed chunks (default: anything older than 7 days) take ~10–30× less disk
- Read queries are unchanged — Polaris uses ordinary SQL, Timescale handles transparency

Polaris **detects the extension at boot**. If present, the boot-time migration converts all eighteen tables to hypertables on the next startup (source tables partitioned by `timestamp`; rollup tables by `bucketStart`) and adds the compression policy. If absent, Polaris stays on plain-Postgres prune and surfaces a `timescale_recommended` alert in the Maintenance tab once sample tables grow past 1 GB.

If you're standing up a new install on RHEL/Rocky/AlmaLinux 9, Ubuntu/Debian, or Docker, install Timescale **before** the first run so all sample tables become hypertables from the start with no conversion downtime.

### RHEL / Rocky / AlmaLinux 9

```bash
sudo tee /etc/yum.repos.d/timescale_timescaledb.repo <<'EOF'
[timescale_timescaledb]
name=timescale_timescaledb
baseurl=https://packagecloud.io/timescale/timescaledb/el/9/$basearch
repo_gpgcheck=1
gpgcheck=0
enabled=1
gpgkey=https://packagecloud.io/timescale/timescaledb/gpgkey
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
metadata_expire=300
EOF

sudo dnf install -y timescaledb-2-postgresql-15
sudo timescaledb-tune --pg-config=/usr/pgsql-15/bin/pg_config --quiet --yes
sudo systemctl restart postgresql-15
sudo -u postgres psql -d polaris -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
```

`timescaledb-tune` updates `shared_preload_libraries` in `postgresql.conf` along with a few memory parameters. The Postgres restart picks the change up. Re-running it is safe.

### Ubuntu / Debian

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -c -s) main" \
  | sudo tee /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey | sudo apt-key add -
sudo apt update
sudo apt install -y timescaledb-2-postgresql-15
sudo timescaledb-tune --quiet --yes
sudo systemctl restart postgresql
sudo -u postgres psql -d polaris -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
```

### Docker / docker-compose

Use the official Timescale image instead of vanilla Postgres in your compose file:

```yaml
services:
  postgres:
    image: timescale/timescaledb:latest-pg15   # was: postgres:15
    volumes:
      - polaris-pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: polaris
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: polaris
```

Existing data on the named volume is preserved across the image swap. After bringing the new container up, enable the extension once:

```bash
docker exec -it <postgres-container> psql -U polaris -d polaris \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
```

### Windows Server

The official Timescale Windows installer is bundled with the EnterpriseDB Postgres installer. Run the EDB installer with the timescaledb extension checked, or download `timescaledb_x.y.z_pg15_windows_amd64.zip` from packagecloud, copy `timescaledb*.dll` into `C:\Program Files\PostgreSQL\15\lib`, copy `timescaledb*.sql` and the control file into `C:\Program Files\PostgreSQL\15\share\extension`, then add `timescaledb` to `shared_preload_libraries` in `postgresql.conf`, restart the Windows service, and run `CREATE EXTENSION timescaledb` against the polaris database.

### Managed / remote Postgres

If your Postgres is on a hosted service (RDS, Aurora, Cloud SQL, Azure Postgres, Crunchy, etc.), TimescaleDB availability varies:

| Service | TimescaleDB |
|---|---|
| AWS RDS for Postgres | **No** |
| AWS Aurora | **No** |
| Azure Postgres Flexible Server | Yes (opt-in) |
| Google Cloud SQL | **No** |
| Crunchy Bridge | Yes |
| Timescale Cloud | Yes (native) |
| Self-managed cloud (EC2 / Compute Engine / etc.) | Yes — install via the OS-native steps above |

If your service doesn't support TimescaleDB, Polaris stays on plain-Postgres prune and the Maintenance tab will continue to surface the recommendation as the sample tables grow. At that point, the right answers are: tighten retention, reduce monitored asset count, or migrate to a Postgres host that supports the extension.

---

## What the runtime does to keep this working

After install, Polaris monitors disk space on every filesystem it (and PostgreSQL, when co-located) writes to:

- **At boot**: `runStartupDiskCheck` logs a clear "X volume has Y MB free" line at info/warn/error per volume. Catches the "polaris flapping because /var is full" case before the operator has to dig through Prisma errors.
- **Every 10 minutes**: the `capacityWatch` job re-runs the snapshot and emits a `capacity.severity_changed` Event whenever severity transitions (ok ↔ watch ↔ amber ↔ red). Events flow through the configured syslog/SFTP archival pipeline so you get the alert even when the UI is unreachable.
- **Server Settings → Maintenance**: live volume bars + per-reason advisory cards. Severity tiering is **watch** at 20–30% free, **amber** at 10–20%, **red** below 10%.

The watch tier is the new "you have weeks, not minutes" warning. Don't ignore it.

---

## Capacity tuning — use the Capacity Advisor

After Polaris has been running long enough to populate the monitor-work duration histogram (~5–15 minutes on a populated fleet, up to 24 hours on a fresh install), open **Server Settings → Maintenance → Capacity Advisor**. The card derives recommended values for connection pool sizes, monitor worker counts, queue mode (cursor ↔ pg-boss), and PostgreSQL `max_connections` / tuning settings from your observed workload (monitored asset count, monitored interface count, per-class FortiGate count, per-cadence p90 pass duration, observed peak connection count, host RAM).

How it works in practice:

1. Tick the rows you want to apply. Each row shows current vs recommended; rows already at-or-above recommendation render with an OK pill and a disabled checkbox.
2. Click **Stage selected**. Polaris writes the chosen env-driven values to `.env` and (for the queue-mode lever) updates `Setting.monitor.queueMode`. **Restart Polaris** to pick up the changes.
3. Advisory-only rows (PostgreSQL `max_connections`, `shared_buffers`, `effective_cache_size`, `work_mem`, `random_page_cost`, `track_io_timing`) are display-only because Polaris can't edit `postgresql.conf`. Edit it and restart PostgreSQL to apply — except `track_io_timing = on`, which only needs a **reload** (`SELECT pg_reload_conf();` or `systemctl reload postgresql`). Enabling `track_io_timing` is what lets Polaris measure real disk-read wait for the `db_io_pressure` capacity reason; overhead is negligible on modern hardware (verify with `pg_test_timing`), and until it's on, Polaris shows a `track_io_timing_off` watch when the database is larger than host RAM.

The env vars surfaced by the advisor have safe defaults out of the box, so a fresh install starts at sensible values:

```
DATABASE_POOL_SIZE=25
POLARIS_PGBOSS_POOL_SIZE=20
POLARIS_MONITOR_PROBE_WORKERS=24
POLARIS_MONITOR_FAST_WORKERS=24
POLARIS_MONITOR_HEAVY_WORKERS=24
POLARIS_MONITOR_FLOATING_WORKERS=32
POLARIS_PROBE_CONCURRENCY=16   # cursor mode only
POLARIS_HEAVY_CONCURRENCY=8    # cursor mode only
```

For headless installs (no UI access) the same env vars can be set by hand. The defaults above cover up to ~500 monitored assets in cursor mode; past that, flip to pg-boss (`Setting.monitor.queueMode = "pgboss"`) and let the advisor scale worker counts as the fleet grows.

`max_connections` on the PostgreSQL side should sit at roughly `(prismaPool + pgbossPool) / 0.65` rounded up to a multiple of 50, leaving ~35% headroom for non-Polaris consumers (psql sessions, backups, replication, monitoring agents). The advisor surfaces the exact recommendation alongside the pool sizes.

---

## Optional: Prometheus + Grafana

Polaris exposes a Prometheus scrape endpoint at `GET /metrics` covering every `polaris_*` metric defined in `src/metrics.ts` — monitor pass and per-cadence work duration, probe latency by transport, FMG dual-lane worker saturation, DB pool / capacity severity / dead-tuple ratios, discovery duration and per-phase histograms, sample-write and rollup durations, HTTP request latency, and per-job durations. Default Node.js process metrics (event-loop lag, RSS, heap, CPU) are also emitted unprefixed so the standard Node.js Grafana dashboards work without modification.

**Bearer token.** The first-run setup wizard auto-generates a `METRICS_TOKEN` and writes it to `.env`. Clearing it surfaces a `metrics_token_unset` watch reason on the Maintenance tab (the endpoint leaks fleet recon data if unauthenticated). Prometheus needs a matching `Authorization: Bearer <token>` header; a minimal scrape config:

```yaml
scrape_configs:
  - job_name: polaris
    metrics_path: /metrics
    static_configs:
      - targets: ['polaris.example.com:3000']
    bearer_token: '<value of METRICS_TOKEN from .env>'
```

**Grafana dashboard.** A pre-built dashboard lives at `docs/grafana/polaris-monitoring-dashboard.json` with the import flow + per-row reading guide in `docs/grafana/README.md`. In Grafana → **Dashboards → New → Import** → upload the JSON → pick your Prometheus datasource for the `DS_PROMETHEUS` variable.

**Postgres-side visibility (separate).** The Polaris dashboard is the *app's* view of the database (pool in-use, dead-tuple ratio on sample tables, projected steady-state size). For true Postgres internals (connections, locks, WAL, replication lag, slow queries, per-table bloat across the whole DB) deploy [`postgres_exporter`](https://github.com/prometheus-community/postgres_exporter) on the prod box and import a community Grafana dashboard like ID 9628 or 12485 alongside.

---

## Optional: Polaris Agent

The Polaris Agent is a small Go binary you can install on Linux / macOS / Windows hosts that pushes monitoring samples back to Polaris over HTTPS. Useful for hosts behind NAT, hosts without a working SNMP/WinRM probe surface, and Windows / Linux endpoints generally. The feature is **optional** — Polaris monitors plenty of devices without it via the existing REST API / SNMP / WinRM / SSH / ICMP transports.

### Build the binaries

**The default path:** the install scripts in this guide (`deploy/setup-{rhel,ubuntu,windows}.{sh,ps1}` and their `-nodb` variants) provision Go 1.22+ alongside Node 20+, so a freshly-installed Polaris server is ready to produce agent binaries on demand. From the web UI:

1. Sign in as admin
2. Integrations → **Polaris Agents** tab → **Polaris Agent** card → **Build agent binaries (vX.Y.Z)**
3. Watch the progress strip; all six platforms reach ✓ within ~90 s on a 2-vCPU host

The button is hidden + replaced by a yellow notice ("install Go 1.22+ and reload") when Go isn't on the server's PATH. The card also shows a per-platform inventory grid and surfaces a drift hint when `agent/VERSION` has moved past `manifest.json` (the auto-build job fires this build for you on the next boot if you don't click it sooner).

**Build queueing + cancellation:** A second click while a build is running enqueues (FIFO depth 3); the 4th simultaneous click gets a "queue full" 409. Each build's row carries a × button that cancels (SIGTERM with SIGKILL 5s grace for the active build; splice-from-queue for queued ones). The on-disk manifest only updates after all six platforms succeed, so a cancelled build leaves no operator-visible artifact.

**Auto-build:** Polaris fires Build automatically 60 s after every boot when `agent/VERSION` has moved past the on-disk manifest. Disable via the toggle on the same card when shop policy requires human-initiated builds. The auto-build is gated on Go being installed (logs a warning Event if not), an existing manifest (operator must have built at least once — fresh installs don't get surprised), and the kill-switch Setting.

**Per-version cleanup:** After every successful build Polaris auto-prunes old version directories. The prune helper NEVER removes the manifest's currentVersion, NEVER removes versions in use by a live agent (so rollback works), and ALWAYS keeps the most recent N (env `POLARIS_AGENT_KEEP_VERSIONS`, default 3). The "Clean up old binaries" button on the card fires the same helper manually.

### Build the binaries (fallback: build on a separate host)

When Polaris itself runs on a host that can't have Go installed (strict supply chain, air-gapped CI, etc.), build on a separate host and copy the artifacts in:

```sh
# On any host with Go 1.22+ installed
cd /path/to/polaris/agent
go mod tidy
make all                        # → dist/<version>/polaris-agent-*
```

```sh
# On the Polaris host
sudo mkdir -p /opt/polaris/data/agents/<version>
sudo cp dist/<version>/* /opt/polaris/data/agents/<version>/
sudo tee /opt/polaris/data/agents/manifest.json <<'EOF'
{
  "currentVersion": "<version>",
  "minimumCompatible": "<version>",
  "binaries": {
    "linux-amd64":   "polaris-agent-linux-amd64",
    "linux-arm64":   "polaris-agent-linux-arm64",
    "darwin-amd64":  "polaris-agent-darwin-amd64",
    "darwin-arm64":  "polaris-agent-darwin-arm64",
    "windows-amd64": "polaris-agent-windows-amd64.exe",
    "windows-arm64": "polaris-agent-windows-arm64.exe"
  }
}
EOF
sudo chown -R polaris:polaris /opt/polaris/data/agents
```

Docker / Unraid users: the container's state directory is `/app/state`. Bind-mount or `docker cp` the same layout into `/app/state/data/agents/`.

When `manifest.json` is missing, the install flow surfaces a clear error: *"No agent binaries available — drop a manifest.json + binaries under `<state>/data/agents/<version>/` and retry"*. So you can deploy Polaris first and add the binaries later when you actually want to use the feature.

### Set POLARIS_PUBLIC_URL

The agent.conf file written to each installed agent embeds the URL the agent will call back to. For any single-box install where Polaris is reachable from the agent host at its public DNS name, set this in `.env`:

```ini
POLARIS_PUBLIC_URL=https://polaris.example.com:3000
```

Without it the agent receives `https://localhost:<PORT>` which only works for testing on the same host.

For reverse-proxy / TLS-termination-upstream topologies (nginx, Caddy, ALB), `POLARIS_PUBLIC_URL` must be the **proxy's** public URL — the agent's pinned cert is the proxy's cert, not the upstream's.

`POLARIS_PUBLIC_URL` is **also required for OIDC SSO** — Polaris derives the OIDC redirect URI from it (`${POLARIS_PUBLIC_URL}/api/v1/auth/oidc/callback`). OIDC login refuses with a clear error if it's unset.

## Authentication providers (OIDC / LDAP / SAML)

Beyond local accounts, Polaris authenticates against Azure SAML, **OIDC** (OpenID Connect Authorization-Code + PKCE), or **LDAP / Active Directory** (bind). Configure under **Users → Authentication** (admin only); each tab has a **Test** button.

- **OIDC:** fill in the Discovery URL, Client ID/Secret, and scopes. Copy the **Redirect URI** shown on the tab and register it in your IdP app registration. **Azure AD note:** by default Azure emits group **object IDs (GUIDs)** in the `groups` claim, not names — map those object IDs in Group Mappings, or configure Azure to emit group names. Azure also drops the claim above ~200 groups (the user then resolves to `readonly` until a smaller group set or a groups-assignment filter is configured).
- **LDAP/AD:** set the server URL (`ldaps://…`), bind DN + password, search base/filter, and (for group mapping) the User ID Attribute (`objectGUID` on AD) + Group Attribute (`memberOf`). LDAP users sign in through the normal username/password form.
- **Group → role + tags:** under **Users → Group Mappings**, map an IdP group to a role plus region/other tags. A user in several mapped groups gets the **highest-privilege** role; tags from all matched groups combine. **A mapping to an admin-equivalent role makes IdP group membership a path to Polaris admin** — restrict who can edit those groups in your directory accordingly.

### Install on a remote host

From the Polaris UI:

1. Open the asset's details modal → **Monitoring** tab
2. Flip any stream to **Polaris Agent**
3. Save
4. Reopen the asset details modal → **System** tab → **Install Agent…**
5. Confirm the OS + arch picker (defaults from `Asset.os`)
6. On **Windows** assets, pick the transport (WinRM or SSH); on Linux/macOS SSH is the only option
7. Pick a stored credential of the matching type (SSH or WinRM)
8. Click **Install**

The install status pill flips `pending → uploading → enrolling → active` over ~30 seconds. The host's systemd / launchd / Windows Service is registered as `polaris-agent`. Uninstall + Force Remove buttons appear once the agent is active. The chosen transport is persisted on the agent row; retry, uninstall, and upgrade reuse it.

### Required on the target host

- **Linux / macOS:** SSH reachable from Polaris on port 22 (or whatever the credential's port field specifies); the credential's user must be able to `sudo -n` (passwordless sudo) — the installer creates a systemd unit / launchd plist.
- **Windows (WinRM):** WinRM enabled on port 5986 (HTTPS) or 5985 (HTTP). Run `Enable-PSRemoting -Force` on a fresh host. The credential must have local admin rights — the installer creates a Windows Service under `%ProgramFiles%\Polaris\Agent\`.
- **Windows (SSH):** OpenSSH Server installed and enabled (`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Start-Service sshd; Set-Service -Name sshd -StartupType Automatic`) and reachable on port 22 (or the credential's port). The credential must have local admin rights. Polaris runs the same PowerShell installer used by the WinRM path — the Windows host pulls the agent binary back from Polaris over HTTPS with cert-pin validation, so outbound HTTPS from the host to Polaris must work during the install.

### Upgrade agents on already-installed hosts

When `agent/VERSION` advances and you build (or auto-build fires), existing installed agents stay on their old binaries until you push the upgrade.

**Per-asset:** Asset details modal → System tab → Polaris Agent panel → **Upgrade…** button. Confirm and watch the install-state pill flip `active → upgrading → active` within ~10 s. The agent's bearer + cert pin survive the swap — no re-enrollment, no need to repick a credential (the install credential stored on the row is reused).

**Fleet-wide:** Integrations → Polaris Agents tab → Polaris Agent card. When any installed agents lag the current build, the card shows an "N of M installed agents running an older version" line with an **Upgrade all** button. Click → confirm → Polaris fans out to every out-of-date host with a Promise pool of 4 (the SSH/WinRM connections are the bottleneck; higher parallelism risks tripping per-host concurrent-connection limits — Windows WinRM caps at ~5 by default).

Failures land per-row as `installStatus="upgrade_failed"` with the error captured in `installError`; an audit Event (`agent.upgrade_failed`) goes out per failed host. The operator retries individuals via the Retry Upgrade button on the asset details panel, or just clicks Upgrade-all again (already-current hosts are silently skipped by the eligibility filter).

---

## Optional: PgBouncer in front of PostgreSQL

When Polaris's `DATABASE_POOL_SIZE + POLARIS_PGBOSS_POOL_SIZE` keeps climbing past what's comfortable to provision on PostgreSQL directly (each backend connection costs ~10 MB of RSS plus a process slot), put **PgBouncer** in front of PostgreSQL. PgBouncer holds a small pool of real Postgres backends and multiplexes Polaris's many connection slots onto them. The Maintenance tab's "Peak observed" can grow well past PG's `max_connections` without any of those connections actually reaching PostgreSQL.

Polaris is PgBouncer-aware: application queries (Prisma) go through PgBouncer, but pg-boss queue ops, `pg_dump` backup/restore, and `pg_stat_activity` reads still need a direct Postgres connection (LISTEN/NOTIFY, prepared-statement cache, and the COPY-heavy dump protocol all break under PgBouncer transaction-pool mode). The two-URL setup keeps both paths working.

### When to deploy PgBouncer

- Capacity Advisor's `DATABASE_POOL_SIZE` recommendation has crept past ~300, AND
- You'd rather not raise PostgreSQL `max_connections` past ~600–800 (memory budget, replication slot accounting, or just shop policy).

If neither bullet applies, skip it. The single-URL setup is simpler to operate and the Capacity Advisor's recommendations are correct without it.

### RHEL / Rocky / AlmaLinux 9

```bash
sudo dnf install -y pgbouncer
```

Edit `/etc/pgbouncer/pgbouncer.ini`:

```ini
[databases]
polaris = host=127.0.0.1 port=5432 dbname=polaris

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 500
default_pool_size = 40
reserve_pool_size = 10
reserve_pool_timeout = 5
server_idle_timeout = 600
# Required for Prisma's prepared-statement use under transaction pooling.
# Requires PgBouncer 1.21+ (RHEL 9 EPEL ships 1.21+).
max_prepared_statements = 200
```

Generate `userlist.txt` by copying PostgreSQL's existing SCRAM hash:

```bash
sudo -u postgres psql -tAc \
  "SELECT '\"polaris\" \"' || rolpassword || '\"' FROM pg_authid WHERE rolname = 'polaris'" \
  | sudo tee /etc/pgbouncer/userlist.txt
sudo chown pgbouncer:pgbouncer /etc/pgbouncer/userlist.txt
sudo chmod 600 /etc/pgbouncer/userlist.txt
```

Enable + start:

```bash
sudo systemctl enable --now pgbouncer
sudo ss -tnlp 'sport = :6432'   # confirm it's listening
```

### Wire Polaris into PgBouncer

In `/opt/polaris/.env`:

```
DATABASE_URL=postgresql://polaris:PASSWORD@127.0.0.1:6432/polaris?pgbouncer=true
POLARIS_DB_DIRECT_URL=postgresql://polaris:PASSWORD@127.0.0.1:5432/polaris
```

Restart Polaris (`sudo systemctl restart polaris`). Verify in the journal:

```bash
sudo journalctl -u polaris -n 50 --no-pager | grep "DB connection mode"
```

You should see `DB connection mode: PgBouncer detected. ...`. On the Maintenance tab → Capacity Advisor card, a "PgBouncer detected" hint will appear above the recommendations.

### Ubuntu / Debian

```bash
sudo apt install -y pgbouncer
```

Same `pgbouncer.ini` shape; on Debian/Ubuntu it lives at `/etc/pgbouncer/pgbouncer.ini`. Same userlist + service enable pattern. Same Polaris `.env` lines.

### Windows Server

PgBouncer isn't officially packaged for Windows. If you've crossed the threshold where you need it, the practical path is to move PostgreSQL + Polaris to Linux. (The Windows install path is documented but is a smaller-fleet target.)

### After enabling PgBouncer

- **`max_connections`** on PostgreSQL can drop materially. PgBouncer's `default_pool_size` × pool count is what hits Postgres now, not Polaris's pool. The Capacity Advisor's `max_connections` recommendation becomes an upper bound rather than a strict requirement; size PG to comfortably exceed `(default_pool_size + reserve_pool_size + admin/autovacuum)` × number of DBs.
- **`pg_dump` backups** taken from Server Settings → Maintenance → Backup automatically use `POLARIS_DB_DIRECT_URL`. If you script backups outside the app, target port 5432 directly — not 6432.
- **Prisma migrations** (when you upgrade Polaris and the in-app updater runs `prisma migrate`) need the direct URL too. CLI migrations require `DATABASE_URL=<direct URL> npx prisma migrate deploy`.
