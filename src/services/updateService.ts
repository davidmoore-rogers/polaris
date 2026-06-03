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
import { randomBytes, scryptSync, createCipheriv, createHash } from "node:crypto";
import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { getAppVersion } from "../utils/version.js";
import { renderNginxConfig } from "./nginxRenderer.js";
import { getProxyConfig, saveProxyConfig } from "./proxyConfigService.js";

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, "..", "..");
const STATUS_FILE = join(APP_DIR, ".update-status.json");
const BACKUP_DIR = join(APP_DIR, "data", "backups");

// Git repository the in-app updater fetches/pulls from. Operators can point
// installs at a fork or internal mirror via POLARIS_UPDATE_REPO in .env;
// unset falls back to the canonical upstream. The URL is applied to the
// `origin` remote before every fetch/pull (see ensureUpdateRemote), so all the
// downstream `origin/HEAD || origin/main || origin/master` plumbing in
// checkForUpdates/applyUpdate keeps working unchanged.
const DEFAULT_UPDATE_REPO = "https://github.com/davidmoore-rogers/polaris.git";

function configuredUpdateRepo(): string {
  const raw = (process.env.POLARIS_UPDATE_REPO || "").trim();
  return raw || DEFAULT_UPDATE_REPO;
}

/**
 * Point the `origin` remote at the configured update repo before a
 * fetch/pull. Idempotent — only rewrites the URL when it differs from what
 * git already has, so a fresh clone from the same repo is a no-op. Non-fatal:
 * a failure here just leaves the existing remote in place and is logged.
 */
async function ensureUpdateRemote(): Promise<void> {
  const desired = configuredUpdateRepo();
  try {
    const { stdout } = await execAsync("git remote get-url origin", {
      cwd: APP_DIR,
      timeout: 10000,
    });
    const current = stdout.trim();
    if (current === desired) return;
    await execAsync(`git remote set-url origin "${desired}"`, {
      cwd: APP_DIR,
      timeout: 10000,
    });
    logger.info({ from: current, to: desired }, "In-app update: repointed origin remote to configured update repo");
  } catch (err: any) {
    // No origin remote yet, or set-url failed — add it. If even that fails,
    // leave whatever's there and let the fetch surface a clear error.
    try {
      await execAsync(`git remote add origin "${desired}"`, {
        cwd: APP_DIR,
        timeout: 10000,
      });
      logger.info({ to: desired }, "In-app update: added origin remote for configured update repo");
    } catch (addErr: any) {
      logger.warn(
        { err: err?.message, addErr: addErr?.message, desired },
        "In-app update: could not set origin remote URL — proceeding with existing remote",
      );
    }
  }
}

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
    // Make sure origin points at the configured update repo (POLARIS_UPDATE_REPO)
    // before fetching.
    await ensureUpdateRemote();

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
      // Ensure origin points at the configured update repo (POLARIS_UPDATE_REPO)
      // before pulling — covers the case where applyUpdate runs without a
      // preceding checkForUpdates, or the env changed since the last check.
      await ensureUpdateRemote();
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
export async function restartService() {
  const isWindows = process.platform === "win32";

  if (isWindows) {
    // Restart each per-role NSSM service, web LAST so its status page survives
    // through the workers' restart. Detached so it survives this process's exit.
    const cmd = "C:\\nssm\\nssm.exe restart PolarisDiscovery & C:\\nssm\\nssm.exe restart PolarisMonitor1 & C:\\nssm\\nssm.exe restart PolarisWeb";
    const child = spawn("cmd.exe", ["/c", cmd], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // spawn() reports a missing/unspawnable binary asynchronously via the
    // 'error' event, NOT via the synchronous try/catch below. Without this
    // listener an ENOENT (no cmd.exe on PATH, etc.) bubbles as an unhandled
    // error and crashes the process before the self-exit timeout fires.
    child.on("error", (err) => {
      logger.warn({ err: err.message }, "nssm restart spawn failed; relying on self-exit + supervisor (NSSM / dev watcher / podman restart policy) to bring the process back");
    });
    child.unref();
    setTimeout(() => { process.exit(0); }, 5000);
  } else {
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
    // Render the operator's proxyConfig into /etc/nginx/conf.d/polaris.conf
    // before spawning the transient unit. Only fires when managedMode=true
    // — pre-adoption installs see their hand-edited file left alone, and
    // the GUI's drift banner stays up until the operator clicks Adopt.
    //
    // Drift check: if live file's sha256 doesn't match proxyConfig.lastAppliedHash,
    // somebody hand-edited the config after our last write. Refuse to clobber
    // and log a warning; the next operator visit to the GUI sees the drift
    // banner and forces explicit re-adoption.
    //
    // Optimistic hash update: record lastAppliedHash to the freshly-
    // rendered sha256 BEFORE the transient unit runs. If `nginx -t` fails
    // and the unit reverts, the DB hash will diverge from the (reverted)
    // live file — the GUI's getDriftStatus picks that up on the next visit.
    const STAGED_UPDATE_CONF = "/run/polaris-nginx-stage/polaris.conf.from-update";
    let nginxSync = "";
    if (proxyMode) {
      try {
        const cfg = await getProxyConfig();
        if (!cfg.managedMode) {
          logger.info("In-app update: skipping nginx config render — proxyConfig.managedMode is false (operator hasn't adopted)");
        } else {
          const rendered = renderNginxConfig({
            config: cfg,
            serverName: deriveServerNameForRender(),
            polarisPort: derivePolarisPortForRender(),
          });
          let driftDetected = false;
          try {
            const live = readFileSync("/etc/nginx/conf.d/polaris.conf", "utf8");
            const liveSha = createHash("sha256").update(live).digest("hex");
            if (cfg.lastAppliedHash && liveSha !== cfg.lastAppliedHash) {
              driftDetected = true;
              logger.warn(
                { liveSha, expected: cfg.lastAppliedHash },
                "In-app update: /etc/nginx/conf.d/polaris.conf has been hand-edited since the last apply — refusing to clobber; GUI will surface drift banner",
              );
            }
          } catch {
            // Live file unreadable; transient unit's existence check skips the swap.
          }
          if (!driftDetected) {
            mkdirSync("/run/polaris-nginx-stage", { recursive: true });
            writeFileSync(STAGED_UPDATE_CONF, rendered.contents, { mode: 0o644 });
            await saveProxyConfig({
              lastAppliedAt: new Date().toISOString(),
              lastAppliedHash: rendered.sha256,
            });
            nginxSync = [
              `if [ -f ${STAGED_UPDATE_CONF} ]; then`,
              `  cp -p /etc/nginx/conf.d/polaris.conf /etc/nginx/conf.d/polaris.conf.bak.$(date +%s) 2>/dev/null || true`,
              `  cp -f ${STAGED_UPDATE_CONF} /etc/nginx/conf.d/polaris.conf.new`,
              `  mv -f /etc/nginx/conf.d/polaris.conf.new /etc/nginx/conf.d/polaris.conf`,
              `  rm -f ${STAGED_UPDATE_CONF}`,
              `  if nginx -t >/dev/null 2>&1; then`,
              `    systemctl reload nginx && logger -t polaris-updater "Synced nginx config from rendered template (sha256=${rendered.sha256.slice(0, 12)}) and reloaded"`,
              `  else`,
              `    logger -t polaris-updater "ERROR: nginx -t failed on rendered config; reverting"`,
              `    latest_bak=$(ls -1t /etc/nginx/conf.d/polaris.conf.bak.* 2>/dev/null | head -1)`,
              `    [ -n "$latest_bak" ] && cp -f "$latest_bak" /etc/nginx/conf.d/polaris.conf`,
              `  fi`,
              `fi`,
            ].join("\n");
          }
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, "In-app update: nginx config render failed — falling back to no-op (leaving live config untouched)");
      }
    }
    // Sync the in-app nginx GUI helpers (wrapper + sudoers + tmpfiles entry +
    // polaris↔nginx group membership). Runs unconditionally on every update;
    // cmp -s + usermod-guard make each step idempotent. Outside proxy mode
    // the wrapper and sudoers are inert, the tmpfiles dir is unused, and
    // the usermod is gated on `getent group nginx` so it's a no-op.
    const nginxHelperSync = [
      `if [ -f ${APP_DIR}/deploy/scripts/polaris-nginx-apply.sh ] && ! cmp -s ${APP_DIR}/deploy/scripts/polaris-nginx-apply.sh /usr/local/sbin/polaris-nginx-apply 2>/dev/null; then`,
      `  install -o root -g root -m 0755 ${APP_DIR}/deploy/scripts/polaris-nginx-apply.sh /usr/local/sbin/polaris-nginx-apply`,
      `  logger -t polaris-updater "Synced /usr/local/sbin/polaris-nginx-apply"`,
      `fi`,
      `if [ -f ${APP_DIR}/deploy/sudoers.d/polaris-nginx ] && ! cmp -s ${APP_DIR}/deploy/sudoers.d/polaris-nginx /etc/sudoers.d/polaris-nginx 2>/dev/null; then`,
      `  install -o root -g root -m 0440 ${APP_DIR}/deploy/sudoers.d/polaris-nginx /etc/sudoers.d/polaris-nginx`,
      `  logger -t polaris-updater "Synced /etc/sudoers.d/polaris-nginx"`,
      `fi`,
      `if [ -f ${APP_DIR}/deploy/tmpfiles.d/polaris-nginx.conf ] && ! cmp -s ${APP_DIR}/deploy/tmpfiles.d/polaris-nginx.conf /etc/tmpfiles.d/polaris-nginx.conf 2>/dev/null; then`,
      `  install -o root -g root -m 0644 ${APP_DIR}/deploy/tmpfiles.d/polaris-nginx.conf /etc/tmpfiles.d/polaris-nginx.conf`,
      `  systemd-tmpfiles --create /etc/tmpfiles.d/polaris-nginx.conf >/dev/null 2>&1 || true`,
      `  logger -t polaris-updater "Synced /etc/tmpfiles.d/polaris-nginx.conf"`,
      `fi`,
      `if getent group nginx >/dev/null 2>&1 && ! id -nG polaris 2>/dev/null | grep -qw nginx; then`,
      `  usermod -aG nginx polaris`,
      `  logger -t polaris-updater "Added polaris user to nginx group (cert file readability)"`,
      `fi`,
    ].join("\n");

    logger.info(
      { proxyMode },
      "Syncing unit files (and nginx config in proxy mode) and restarting polaris.target for update...",
    );
    const syncScript = [
      "set -e",
      nginxHelperSync,
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
      // spawn() reports a missing binary asynchronously via the 'error' event,
      // NOT through this try/catch. Without the listener an ENOENT (no
      // systemd-run on PATH — dev containers without systemd, npm-run-dev on
      // a non-systemd host, etc.) bubbles as an unhandled error and crashes
      // the process before the self-exit timeout fires, leaving the container
      // / watcher with no listener bound on 3000. With the listener attached,
      // we log + drop into the same self-exit path the prod-failure case uses
      // and let the supervisor (systemd in prod, podman restart policy in the
      // dev container, the operator's terminal in npm-run-dev-on-host) bring
      // the process back.
      child.on("error", (err) => {
        logger.warn({ err: err.message }, "systemd-run for group restart unavailable; relying on self-exit + supervisor (systemd / podman / dev watcher) to bring the process back");
      });
      child.unref();
    } catch (err: any) {
      logger.warn({ err: err?.message }, "systemd-run for group restart failed; falling back to self-exit");
    }
    setTimeout(() => { process.exit(0); }, 3000);
  }
}

// ─── nginx render env-derived inputs (duplicated from nginxApplyService) ───
// Kept here to avoid a transitive dependency on nginxApplyService which
// pulls in certInfo + privilegedSysadmin. The renderer itself only needs
// these two values, derivable from env vars Polaris already reads at boot.

function deriveServerNameForRender(): string {
  const publicUrl = process.env.POLARIS_PUBLIC_URL;
  if (publicUrl) {
    try { return new URL(publicUrl).hostname; } catch { /* fall through */ }
  }
  return "polaris.example.com";
}

function derivePolarisPortForRender(): number {
  const raw = process.env.PORT;
  if (!raw) return 3000;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}
