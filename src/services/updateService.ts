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
import { logger } from "../utils/logger.js";

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, "..", "..");
const STATUS_FILE = join(APP_DIR, ".update-status.json");
const BACKUP_DIR = join(APP_DIR, "backups");

export interface UpdateStatus {
  state:
    | "idle"
    | "checking"
    | "available"
    | "up-to-date"
    | "applying"
    | "complete"
    | "failed"
    | "restarting";
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
}

let _status: UpdateStatus = { state: "idle" };
let _applying = false;

function readPackageVersion(): string {
  try {
    for (const rel of ["../../package.json", "../package.json"]) {
      const p = join(__dirname, rel);
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8")).version || "0.0.0";
    }
  } catch {}
  return "0.0.0";
}

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
    saved.latestVersion = readPackageVersion();
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
  return { ..._status, steps: _status.steps ? [..._status.steps] : undefined };
}

export function clearUpdateStatus() {
  _status = { state: "idle" };
  try {
    if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
  } catch {}
}

/**
 * Check if a newer version is available on the remote.
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  _status = { state: "checking", currentVersion: readPackageVersion() };

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
        currentVersion: readPackageVersion(),
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

    // Try to read the remote package.json version
    let latestVersion = "unknown";
    try {
      const { stdout: remotePkg } = await execAsync(
        `git show origin/HEAD:package.json 2>/dev/null || git show origin/main:package.json 2>/dev/null || git show origin/master:package.json`,
        { cwd: APP_DIR }
      );
      latestVersion = JSON.parse(remotePkg).version || "unknown";
    } catch {}

    _status = {
      state: "available",
      currentVersion: readPackageVersion(),
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
      currentVersion: readPackageVersion(),
    };
    return _status;
  }
}

/**
 * Apply the available update. Runs asynchronously in the background.
 */
export async function applyUpdate(): Promise<void> {
  if (_applying) return;
  _applying = true;

  const connUrl = process.env.DATABASE_URL || "";

  const steps: NonNullable<UpdateStatus["steps"]> = [
    { name: "Backup database", status: "pending", message: "" },
    { name: "Pull latest code", status: "pending", message: "" },
    { name: "Install dependencies", status: "pending", message: "" },
    { name: "Build TypeScript", status: "pending", message: "" },
    { name: "Run migrations", status: "pending", message: "" },
    { name: "Restart service", status: "pending", message: "" },
  ];

  _status = {
    state: "applying",
    currentVersion: readPackageVersion(),
    currentCommit: _status.currentCommit,
    latestVersion: _status.latestVersion,
    latestCommit: _status.latestCommit,
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
    setStep(0, "running");
    try {
      mkdirSync(BACKUP_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const backupFile = join(BACKUP_DIR, `shelob-pre-update-${readPackageVersion()}-${ts}.sql.gz`);

      await execAsync(
        `pg_dump "${connUrl}" --no-owner --no-acl --clean --if-exists`,
        { cwd: APP_DIR, timeout: 120000, maxBuffer: 100 * 1024 * 1024 }
      ).then(async ({ stdout }) => {
        // gzip the output
        const { gzipSync } = await import("node:zlib");
        const compressed = gzipSync(Buffer.from(stdout));
        writeFileSync(backupFile, compressed);
      });

      _status.backupFile = backupFile;
      const sizeKb = Math.round(
        (existsSync(backupFile) ? readFileSync(backupFile).length : 0) / 1024
      );
      setStep(0, "done", `Backup created (${sizeKb} KB)`);
    } catch (err: any) {
      // Non-fatal — warn but continue
      setStep(0, "done", "Backup skipped: " + (err.message || "pg_dump not available"));
      logger.warn({ err }, "Pre-update backup failed — continuing without backup");
    }

    // ── Step 2: Pull latest code ──
    setStep(1, "running");
    try {
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

    // ── Step 4: Build TypeScript ──
    setStep(3, "running");
    try {
      await execAsync("npx tsc", { cwd: APP_DIR, timeout: 120000 });
      setStep(3, "done");
    } catch (err: any) {
      failUpdate(3, "TypeScript build failed: " + (err.stderr || err.message).slice(0, 500));
      return;
    }

    // ── Step 5: Run migrations ──
    setStep(4, "running");
    try {
      await execAsync("npx prisma migrate deploy", {
        cwd: APP_DIR,
        timeout: 120000,
      });
      setStep(4, "done");
    } catch (err: any) {
      failUpdate(4, "Migration failed: " + (err.stderr || err.message).slice(0, 500));
      return;
    }

    // ── Step 6: Restart service ──
    setStep(5, "running", "Restarting...");
    _status.state = "restarting";
    _status.latestVersion = readPackageVersion();
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
 */
function restartService() {
  const isWindows = process.platform === "win32";

  if (isWindows) {
    // NSSM restart — spawn detached so it survives parent exit
    const child = spawn("cmd.exe", ["/c", "C:\\nssm\\nssm.exe restart Shelob"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    setTimeout(() => { process.exit(0); }, 5000);
  } else {
    // Exit with non-zero code so systemd Restart=on-failure restarts us
    logger.info("Exiting for systemd restart...");
    process.exit(1);
  }
}
