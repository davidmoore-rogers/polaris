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
SQL
```

The `pg_read_all_settings` grant lets Polaris read `SHOW data_directory` so the Maintenance tab can measure the `/var` filesystem and alert before it fills.

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

### 5. systemd unit

The shipped unit at `deploy/polaris.service` should require `postgresql-15.service` (NOT `postgresql.service` — that's the AppStream unit name). Copy it into place and enable:

```bash
sudo cp deploy/polaris.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now polaris
```

If you're starting from a unit that references `postgresql.service` (older Polaris docs or an upstream community install), edit it before enabling:

```bash
sudo sed -i 's/postgresql\.service/postgresql-15.service/g' /etc/systemd/system/polaris.service
sudo systemctl daemon-reload
```

Browse to `http://<host>:3000` to run the setup wizard.

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

# 8. Update polaris.service to depend on postgresql-15.service instead of postgresql.service
sudo sed -i 's/postgresql\.service/postgresql-15.service/g' /etc/systemd/system/polaris.service
sudo systemctl daemon-reload

# 9. Optionally remove the abandoned AppStream PGDATA
sudo test -f /var/lib/pgsql/data/PG_VERSION && echo "OLD DATA STILL EXISTS — DO NOT DELETE" || sudo rm -rf /var/lib/pgsql/data

# 10. Start Polaris and watch the boot
sudo systemctl start polaris
sudo journalctl -u polaris -f --no-pager
```

After step 10 succeeds, follow *Recommended: TimescaleDB* below to install the extension. On the first restart afterward, Polaris detects the extension and converts the six monitoring sample tables to hypertables (~5-15 min for a fleet that's been running for weeks; no operator action required, just patience as conversions log in the journal).

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
SQL
```

The `pg_read_all_settings` grant lets Polaris read `SHOW data_directory` so the Maintenance tab can measure the `/var` filesystem and alert before it fills.

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

### 5. systemd unit

Edit the shipped `deploy/polaris.service` to fix the `Requires=` directive — the Ubuntu unit name is versioned:

```ini
After=network.target postgresql.service
Requires=postgresql.service
```

`postgresql.service` on Debian-based systems is a meta-service that depends on the version-specific cluster unit (`postgresql@15-main.service`), so depending on `postgresql.service` works correctly.

Then copy and enable:

```bash
sudo cp deploy/polaris.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now polaris
```

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
\q
```

Edit `pg_hba.conf` (in the data directory) to add a line for the polaris user, then restart the PostgreSQL service from `services.msc`.

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

## Recommended: TimescaleDB

Polaris's monitoring sample tables (`asset_monitor_samples`, `asset_telemetry_samples`, `asset_temperature_samples`, `asset_interface_samples`, `asset_storage_samples`, `asset_ipsec_tunnel_samples`) are append-only time-series. Plain Postgres handles them fine at small scale, but once the combined size crosses ~1 GB the daily retention prune starts seq-scanning hundreds of millions of rows, contending with normal write load. **TimescaleDB** (an official Postgres extension) converts these tables to hypertables with chunk-based partitioning and native compression:

- Daily prune becomes `DROP CHUNK` (instant, no seq-scan, no lock contention)
- Compressed chunks (default: anything older than 7 days) take ~10–30× less disk
- Read queries are unchanged — Polaris uses ordinary SQL, Timescale handles transparency

Polaris **detects the extension at boot**. If present, the boot-time migration converts the six sample tables to hypertables on the next startup and adds the compression policy. If absent, Polaris stays on plain-Postgres prune and surfaces a `timescale_recommended` alert in the Maintenance tab once sample tables grow past 1 GB.

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
