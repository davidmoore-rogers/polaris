/**
 * src/services/updateService.ts — In-app update service
 *
 * Checks for new versions via git, runs the full update pipeline
 * (backup → pull → npm ci → tsc → prisma migrate → restart),
 * and tracks progress via a status file that survives restarts.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import { randomBytes, scryptSync, createCipheriv } from "node:crypto";
import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { getAppVersion } from "../utils/version.js";
import { getRole } from "../utils/role.js";

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, "..", "..");
const STATUS_FILE = join(APP_DIR, ".update-status.json");
const BACKUP_DIR = join(APP_DIR, "data", "backups");

export interface UpdateStatus {
  state:
    | "idle"
    | "checking"
    | "available"
    | "up-to-date"
    | "applying"
    | "complete"
    | "failed"
    | "restarting"
    | "disabled";
  step?: string;
  steps?: { name: string; status: "pending" | "running" | "done" | "failed"; message?: string }[];
  error?: string;
  currentVersion?: string;
  latestVersion?: string;
  currentCommit?: string;
  latestCommit?: string;
  commitsBehind?: number;
  changes?: string[];
  backupFile?: string;
  startedAt?: string;
  completedAt?: string;
  // When state === "disabled": human-readable hint on how to update outside the app.
  method?: string;
}

let _status: UpdateStatus = { state: "idle" };
let _applying = false;

// In-app updates rely on a writable git checkout at APP_DIR. Detect deployments
// where that's missing — most commonly the Docker image, where the runtime
// stage doesn't ship git or a .git tree — and surface a friendlier "disabled"
// status instead of letting `git fetch` fail with a generic ENOENT.
//
// Computed once at module load — neither signal changes at runtime.
const _updateEnvironment = (function detectUpdateEnvironment(): {
  available: boolean;
  reason?: string;
  method?: string;
} {
  const inDocker = existsSync("/.dockerenv");
  const hasGitDir = existsSync(join(APP_DIR, ".git"));

  if (!hasGitDir) {
    if (inDocker) {
      return {
        available: false,
        reason: "In-app updates are disabled in Docker.",
        method:
          "To update, pull the latest image and recreate the container. " +
          "Data and settings persist on the mounted state volume.",
      };
    }
    return {
      available: false,
      reason: "In-app updates are disabled — no git checkout at the install path.",
      method: "Update by reinstalling the application package.",
    };
  }
  return { available: true };
})();

function disabledStatus(): UpdateStatus {
  return {
    state: "disabled",
    currentVersion: readCurrentVersion(),
    error: _updateEnvironment.reason,
    method: _updateEnvironment.method,
  };
}

function readPackageMinor(): string {
  try {
    for (const rel of ["../../package.json", "../package.json"]) {
      const p = join(__dirname, rel);
      if (existsSync(p)) {
        const v = JSON.parse(readFileSync(p, "utf-8")).version || "0.9.0";
        const [major, minor] = v.split(".");
        return `${major}.${minor}`;
      }
    }
  } catch {}
  return "0.9";
}

function computeVersion(majorMinor: string, commitCount: string | number): string {
  return `${majorMinor}.${commitCount}`;
}

// Running-process version is derived once at startup by src/utils/version.ts;
// re-exporting under the original local name keeps the rest of this file
// unchanged and keeps the "latest version" computation below (which still
// uses readPackageMinor + computeVersion against an upstream commit count)
// independent of the cached running-process value.
const readCurrentVersion = getAppVersion;

function saveStatus() {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(_status, null, 2));
  } catch (err) {
    logger.warn({ err }, "Failed to write update status file");
  }
}

function loadStatusFromDisk(): UpdateStatus | null {
  try {
    if (existsSync(STATUS_FILE)) {
      return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

/**
 * On server startup, check if we just restarted after an update.
 */
export function initUpdateStatus() {
  const saved = loadStatusFromDisk();
  if (saved && saved.state === "restarting") {
    saved.state = "complete";
    saved.completedAt = new Date().toISOString();
    saved.latestVersion = readCurrentVersion();
    // Mark all steps done
    if (saved.steps) {
      saved.steps.forEach((s) => {
        if (s.status === "running" || s.status === "pending") s.status = "done";
      });
    }
    _status = saved;
    saveStatus();
    logger.info(
      { from: saved.currentVersion, to: saved.latestVersion },
      "Update completed after restart"
    );
  } else if (saved && (saved.state === "complete" || saved.state === "failed")) {
    _status = saved;
  }
}

export function getUpdateStatus(): UpdateStatus {
  if (!_updateEnvironment.available) return disabledStatus();
  return { ..._status, steps: _status.steps ? [..._status.steps] : undefined };
}

export function isUpdateMechanismAvailable(): boolean {
  return _updateEnvironment.available;
}

export function clearUpdateStatus() {
  _status = { state: "idle" };
  try {
    if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
  } catch {}
}

/**
 * Return the most recent commits on the installed code (`git log` on HEAD).
 * Used by the Application Updates card to show "what's been applied" history.
 */
export async function getRecentCommits(
  limit = 20
): Promise<{ hash: string; date: string; subject: string }[]> {
  const n = Math.max(1, Math.min(100, Math.floor(limit) || 20));
  try {
    const { stdout } = await execAsync(
      `git log -n ${n} --pretty=format:%h%x09%ad%x09%s --date=short`,
      { cwd: APP_DIR, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const t1 = line.indexOf("\t");
        const t2 = line.indexOf("\t", t1 + 1);
        if (t1 === -1 || t2 === -1) return { hash: line, date: "", subject: "" };
        return {
          hash: line.slice(0, t1),
          date: line.slice(t1 + 1, t2),
          subject: line.slice(t2 + 1),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Check if a newer version is available on the remote.
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!_updateEnvironment.available) {
    _status = disabledStatus();
    return _status;
  }
  _status = { state: "checking", currentVersion: readCurrentVersion() };

  try {
    // Fetch latest from remote
    await execAsync("git fetch --all --prune", { cwd: APP_DIR, timeout: 30000 });

    // Get current commit
    const { stdout: localHead } = await execAsync("git rev-parse --short HEAD", {
      cwd: APP_DIR,
    });
    const currentCommit = localHead.trim();

    // Get remote HEAD commit
    const { stdout: remoteHead } = await execAsync(
      "git rev-parse --short origin/HEAD 2>/dev/null || git rev-parse --short origin/main 2>/dev/null || git rev-parse --short origin/master",
      { cwd: APP_DIR }
    );
    const latestCommit = remoteHead.trim();

    if (currentCommit === latestCommit) {
      _status = {
        state: "up-to-date",
        currentVersion: readCurrentVersion(),
        currentCommit,
        latestCommit,
        commitsBehind: 0,
      };
      return _status;
    }

    // Count commits behind
    const { stdout: behindStr } = await execAsync(
      `git rev-list --count HEAD..origin/HEAD 2>/dev/null || git rev-list --count HEAD..origin/main 2>/dev/null || git rev-list --count HEAD..origin/master`,
      { cwd: APP_DIR }
    );
    const commitsBehind = parseInt(behindStr.trim(), 10) || 0;

    // Get commit messages for changes
    const { stdout: logStr } = await execAsync(
      `git log --oneline HEAD..origin/HEAD 2>/dev/null || git log --oneline HEAD..origin/main 2>/dev/null || git log --oneline HEAD..origin/master`,
      { cwd: APP_DIR }
    );
    const changes = logStr.trim().split("\n").filter(Boolean);

    // Compute remote version: major.minor from remote package.json + remote commit count
    let latestVersion = "unknown";
    try {
      const { stdout: remotePkg } = await execAsync(
        `git show origin/HEAD:package.json 2>/dev/null || git show origin/main:package.json 2>/dev/null || git show origin/master:package.json`,
        { cwd: APP_DIR }
      );
      const remotePkgVersion = JSON.parse(remotePkg).version || "0.9.0";
      const [rMajor, rMinor] = remotePkgVersion.split(".");
      const { stdout: remoteCount } = await execAsync(
        `git rev-list --count origin/HEAD 2>/dev/null || git rev-list --count origin/main 2>/dev/null || git rev-list --count origin/master`,
        { cwd: APP_DIR }
      );
      latestVersion = computeVersion(`${rMajor}.${rMinor}`, remoteCount.trim());
    } catch {}

    _status = {
      state: "available",
      currentVersion: readCurrentVersion(),
      latestVersion,
      currentCommit,
      latestCommit,
      commitsBehind,
      changes,
    };
    return _status;
  } catch (err: any) {
    _status = {
      state: "failed",
      error: "Failed to check for updates: " + (err.message || String(err)),
      currentVersion: readCurrentVersion(),
    };
    return _status;
  }
}

/**
 * Apply the available update. Runs asynchronously in the background.
 *
 * @param password Optional AES-256-GCM password for encrypting the pre-update
 *                 database backup. When set, the backup is wrapped in the same
 *                 POLARIS\0 envelope used by manual backups so the existing
 *                 restore flow accepts it.
 */
export async function applyUpdate(password?: string | null): Promise<void> {
  if (!_updateEnvironment.available) {
    _status = disabledStatus();
    return;
  }
  if (_applying) return;
  _applying = true;

  const connUrl = process.env.DATABASE_URL || "";

  const steps: NonNullable<UpdateStatus["steps"]> = [
    { name: "Backup database", status: "pending", message: "" },
    { name: "Pull latest code", status: "pending", message: "" },
    { name: "Install dependencies", status: "pending", message: "" },
    { name: "Generate Prisma client", status: "pending", message: "" },
    { name: "Build TypeScript", status: "pending", message: "" },
    { name: "Run migrations", status: "pending", message: "" },
    { name: "Restart service", status: "pending", message: "" },
  ];

  _status = {
    state: "applying",
    currentVersion: readCurrentVersion(),
    currentCommit: _status.currentCommit,
    latestVersion: _status.latestVersion,
    latestCommit: _status.latestCommit,
    commitsBehind: _status.commitsBehind,
    changes: _status.changes,
    startedAt: new Date().toISOString(),
    steps,
  };
  saveStatus();

  function setStep(idx: number, status: "running" | "done" | "failed", message?: string) {
    steps[idx].status = status;
    if (message) steps[idx].message = message;
    _status.steps = steps;
    saveStatus();
  }

  function failUpdate(idx: number, error: string) {
    setStep(idx, "failed", error);
    _status.state = "failed";
    _status.error = error;
    saveStatus();
    _applying = false;
  }

  try {
    // ── Step 1: Backup database ──
    // Stream pg_dump → gzip → file so backup size isn't bounded by an
    // in-memory buffer. Saved to data/backups/ so it appears in the
    // Backup History list and can be downloaded from the Maintenance tab.
    setStep(0, "running");
    const skipBackupSetting = await prisma.setting.findUnique({ where: { key: "update.skip_backup" } });
    if (skipBackupSetting?.value === true) {
      setStep(0, "done", "Backup skipped (disabled in settings)");
    } else {
      try {
        mkdirSync(BACKUP_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const version = readCurrentVersion();
        const backupId = `bk-pre-update-${Date.now()}`;
        const isEncrypted = !!(password && password.length > 0);
        const filename = `polaris-pre-update-${version}-${ts}${isEncrypted ? ".enc" : ".sql"}.gz`;
        const backupFile = join(BACKUP_DIR, backupId);

        const { createGzip } = await import("node:zlib");
        const { createWriteStream, createReadStream } = await import("node:fs");
        const { pipeline } = await import("node:stream/promises");

        const dump = spawn(
          "pg_dump",
          [connUrl, "--no-owner", "--no-acl", "--clean", "--if-exists"],
          { cwd: APP_DIR }
        );
        let dumpStderr = "";
        dump.stderr.on("data", (chunk) => { dumpStderr += chunk.toString(); });
        const dumpExit = new Promise<void>((resolve, reject) => {
          dump.on("error", reject);
          dump.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`pg_dump exited with code ${code}: ${dumpStderr.trim() || "no stderr"}`));
          });
        });

        if (isEncrypted) {
          // Stream pg_dump → gzip → AES-256-GCM cipher → temp ciphertext file,
          // then assemble the final file as: [POLARIS\0][salt][iv][authTag][ciphertext].
          // We can't write the auth tag until the cipher finishes, so we stage
          // the ciphertext separately rather than reserving and patching bytes.
          const salt = randomBytes(32);
          const iv = randomBytes(16);
          const key = scryptSync(password!, salt, 32);
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          const ciphertextFile = backupFile + ".tmp-ct";

          await Promise.all([
            pipeline(dump.stdout, createGzip(), cipher, createWriteStream(ciphertextFile)),
            dumpExit,
          ]);

          const authTag = cipher.getAuthTag();
          const header = Buffer.concat([Buffer.from("POLARIS\0"), salt, iv, authTag]);
          const out = createWriteStream(backupFile);
          await new Promise<void>((resolve, reject) => {
            out.write(header, (err) => (err ? reject(err) : resolve()));
          });
          await pipeline(createReadStream(ciphertextFile), out);
          try { unlinkSync(ciphertextFile); } catch {}
        } else {
          await Promise.all([
            pipeline(dump.stdout, createGzip(), createWriteStream(backupFile)),
            dumpExit,
          ]);
        }

        const sizeBytes = existsSync(backupFile) ? readFileSync(backupFile).length : 0;
        const sizeKb = Math.round(sizeBytes / 1024);

        // Register in backup_history so the Maintenance tab shows it with a Download button
        try {
          const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
          const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
          history.push({ id: backupId, filename, size: sizeBytes, encrypted: isEncrypted, preUpdate: true, createdAt: new Date().toISOString() });
          if (history.length > 50) history.splice(0, history.length - 50);
          await prisma.setting.upsert({
            where: { key: "backup_history" },
            update: { value: history },
            create: { key: "backup_history", value: history },
          });
        } catch (dbErr) {
          logger.warn({ err: dbErr }, "Pre-update backup created but failed to register in backup_history");
        }

        _status.backupFile = filename;
        setStep(0, "done", `Backup created (${sizeKb} KB${isEncrypted ? ", encrypted" : ""})`);
      } catch (err: any) {
        // Non-fatal — warn but continue
        setStep(0, "done", "Backup skipped: " + (err.message || "pg_dump not available"));
        logger.warn({ err }, "Pre-update backup failed — continuing without backup");
      }
    }

    // ── Step 2: Pull latest code ──
    setStep(1, "running");
    try {
      await execAsync("git checkout -- package-lock.json", {
        cwd: APP_DIR,
        timeout: 10000,
      }).catch(() => {});
      const { stdout } = await execAsync("git pull --ff-only", {
        cwd: APP_DIR,
        timeout: 60000,
      });
      setStep(1, "done", stdout.trim().split("\n").pop() || "Updated");
    } catch (err: any) {
      failUpdate(1, "git pull failed: " + (err.stderr || err.message));
      return;
    }

    // ── Step 3: Install dependencies ──
    setStep(2, "running");
    try {
      await execAsync("npm ci --production=false", {
        cwd: APP_DIR,
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
      });
      setStep(2, "done");
    } catch (err: any) {
      failUpdate(2, "npm ci failed: " + (err.stderr || err.message).slice(0, 500));
      return;
    }

    // ── Step 4: Generate Prisma client ──
    // Explicit step — don't rely on `npm ci` postinstall having fired. A
    // partially-failed `npm ci` (transient network blip, future `--ignore-scripts`,
    // etc.) leaves the generated client stale, then step 6's `migrate deploy`
    // drops columns the running client still selects → every Asset read/write
    // crashes with `column "<name>" does not exist`.
    setStep(3, "running");
    try {
      await execAsync("npx prisma generate", { cwd: APP_DIR, timeout: 60000 });
      setStep(3, "done");
    } catch (err: any) {
      failUpdate(3, "Prisma generate failed: " + (err.stderr || err.message).slice(0, 500));
      return;
    }

    // ── Step 5: Build TypeScript ──
    // Clean `dist/` first so stale compiled JS from a previous build (e.g.
    // generated-client files Prisma renamed between versions) can't shadow
    // the fresh tsc output. tsc itself is non-destructive — without this,
    // a file that exists in `dist/` but no longer in `src/` lingers forever.
    setStep(4, "running");
    try {
      const distDir = join(APP_DIR, "dist");
      if (existsSync(distDir)) {
        await execAsync(`rm -rf "${distDir}"`, { cwd: APP_DIR, timeout: 30000 }).catch(async () => {
          // Windows fallback: rm isn't available in cmd.exe. Use Node's fs.rmSync
          // via -e so we don't introduce a hard PowerShell dependency.
          await execAsync(
            `node -e "require('fs').rmSync('dist',{recursive:true,force:true})"`,
            { cwd: APP_DIR, timeout: 30000 },
          );
        });
      }
      await execAsync("npx tsc", { cwd: APP_DIR, timeout: 120000 });
      setStep(4, "done");
    } catch (err: any) {
      failUpdate(4, "TypeScript build failed: " + (err.stderr || err.message).slice(0, 500));
      return;
    }

    // ── Step 6: Run migrations ──
    setStep(5, "running");
    try {
      await execAsync("npx prisma migrate deploy", {
        cwd: APP_DIR,
        timeout: 120000,
      });
      setStep(5, "done");
    } catch (err: any) {
      failUpdate(5, "Migration failed: " + (err.stderr || err.message).slice(0, 500));
      return;
    }

    // ── Step 7: Restart service ──
    setStep(6, "running", "Restarting...");
    _status.state = "restarting";
    _status.latestVersion = readCurrentVersion();
    saveStatus();

    logger.info("Update applied — restarting service...");

    // Schedule restart after response is sent
    setTimeout(() => {
      restartService();
    }, 1500);
  } catch (err: any) {
    _status.state = "failed";
    _status.error = "Unexpected error: " + (err.message || String(err));
    saveStatus();
    _applying = false;
  }
}

/**
 * Restart the service using the platform's service manager.
 *
 * Multi-process (POLARIS_ROLE set, e.g. web) must restart the WHOLE group, not
 * just this process — otherwise the monitor/discovery units keep running the
 * OLD code against the freshly-migrated schema (the exact column-mismatch
 * failure the updater guards against). Single-process ("all", role unset) keeps
 * the historical single-unit restart.
 *
 * The updater only runs on the web/all role (it owns the git checkout + status
 * file), so this is always called from the web process.
 */
export function restartService() {
  const isWindows = process.platform === "win32";
  // role unset => "all" => legacy single-process install.
  const multiProcess = getRole() !== "all";

  if (isWindows) {
    // Multi-process: restart each per-role NSSM service, web LAST so its status
    // page survives through the others' restart. Single-process: the one
    // "Polaris" service. Detached so it survives this process's exit.
    const cmd = multiProcess
      ? "C:\\nssm\\nssm.exe restart PolarisDiscovery & C:\\nssm\\nssm.exe restart PolarisMonitor1 & C:\\nssm\\nssm.exe restart PolarisWeb"
      : "C:\\nssm\\nssm.exe restart Polaris";
    const child = spawn("cmd.exe", ["/c", cmd], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    setTimeout(() => { process.exit(0); }, 5000);
  } else if (multiProcess) {
    // Restart the full group via a transient unit so the restart survives our
    // own exit (a detached child stays in web's cgroup and would be killed when
    // web restarts; systemd-run runs it as an independent transient unit).
    // Requires a polkit/sudo grant for the polaris user to manage polaris.target
    // — see docs/INSTALL.md. Falls back to a plain exit so at least web cycles.
    //
    // Auto-sync shipped unit files before restarting. A Polaris update that
    // ships unit-file changes (new env var on a worker role, hardening
    // directive, etc.) only lands the new content in /opt/polaris/deploy/;
    // /etc/systemd/system/ still holds whatever the operator cp'd in at
    // install time. Without the sync + daemon-reload below, the restart
    // would cycle the processes against the OLD unit definitions and ship
    // no env changes. cmp-only-overwrite means a no-op when nothing
    // changed; operator customization should live in <unit>.d/*.conf
    // drop-ins (per docs/INSTALL.md) — those survive any cp. The transient
    // unit's contents run as root via the manage-units polkit grant, so
    // the polaris user doesn't need direct cp access to /etc/systemd/system/.
    // Chained with && so a failed cp or daemon-reload aborts the restart
    // and leaves the system running the old code/units pair (the rollback
    // path knows how to repair from there).
    // Proxy mode: in addition to the systemd unit-file sync, also stage +
    // validate any updated nginx config from deploy/nginx/polaris.conf into
    // /etc/nginx/conf.d/polaris.conf, then reload nginx BEFORE the target
    // restart. Order matters: if Polaris restarts first and the new build
    // expects a new nginx behavior (new location block etc.), there'd be a
    // brief window of 404s. Failure mode: if nginx -t rejects the staged
    // config, we LOG and skip the reload (existing nginx config keeps
    // running) rather than fail the whole restart. Mirrors
    // deploy/update-linux.sh:sync_nginx_config() so manual + in-app paths
    // land the same end state.
    const proxyMode = Boolean(process.env.POLARIS_PROXY_CERT_PATH);
    const nginxSync = proxyMode ? [
      `if [ -f ${APP_DIR}/deploy/nginx/polaris.conf ] && [ -f /etc/nginx/conf.d/polaris.conf ] && ! cmp -s ${APP_DIR}/deploy/nginx/polaris.conf /etc/nginx/conf.d/polaris.conf; then`,
      `  cp -p /etc/nginx/conf.d/polaris.conf /etc/nginx/conf.d/polaris.conf.bak.$(date +%s)`,
      `  cp -f ${APP_DIR}/deploy/nginx/polaris.conf /etc/nginx/conf.d/polaris.conf.new`,
      `  mv -f /etc/nginx/conf.d/polaris.conf.new /etc/nginx/conf.d/polaris.conf`,
      `  if nginx -t >/dev/null 2>&1; then`,
      `    systemctl reload nginx && logger -t polaris-updater "Synced nginx config and reloaded"`,
      `  else`,
      `    logger -t polaris-updater "ERROR: nginx -t failed on staged config; reverting to previous nginx config"`,
      `    latest_bak=$(ls -1t /etc/nginx/conf.d/polaris.conf.bak.* 2>/dev/null | head -1)`,
      `    [ -n "$latest_bak" ] && cp -f "$latest_bak" /etc/nginx/conf.d/polaris.conf`,
      `  fi`,
      `fi`,
    ].join("\n") : "";

    logger.info(
      { proxyMode },
      "Syncing unit files (and nginx config in proxy mode) and restarting polaris.target for update...",
    );
    const syncScript = [
      "set -e",
      nginxSync,
      `for f in ${APP_DIR}/deploy/polaris-web.service ${APP_DIR}/deploy/polaris-monitor@.service ${APP_DIR}/deploy/polaris-discovery.service ${APP_DIR}/deploy/polaris-migrate.service ${APP_DIR}/deploy/polaris.target; do`,
      `  name="$(basename "$f")"`,
      `  target="/etc/systemd/system/$name"`,
      `  if [ -f "$target" ] && ! cmp -s "$f" "$target"; then`,
      `    cp -f "$f" "$target"`,
      `    logger -t polaris-updater "Synced unit file: $name (operator edits to the main unit file are clobbered; use $name.d/*.conf drop-ins for customization)"`,
      `  fi`,
      `done`,
      `systemctl daemon-reload`,
      `systemctl restart polaris.target`,
    ].filter(Boolean).join("\n");
    try {
      const child = spawn("systemd-run", ["--no-block", "/bin/sh", "-c", syncScript], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (err: any) {
      logger.warn({ err: err?.message }, "systemd-run for group restart failed; falling back to self-exit");
    }
    setTimeout(() => { process.exit(0); }, 3000);
  } else {
    // Legacy single unit: exit non-zero so systemd Restart=on-failure cycles us.
    logger.info("Exiting for systemd restart...");
    process.exit(1);
  }
}
