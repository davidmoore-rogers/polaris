/**
 * src/utils/startupDiskCheck.ts
 *
 * Cross-platform "loud diagnostic" that runs once at app boot. Statfs's the
 * filesystems Polaris (and, when co-located, PostgreSQL) write to and emits
 * a structured log line at warn/error level for any volume below 10% free.
 *
 * Why this exists separately from the periodic `capacityWatch` job: when
 * Polaris keeps crash-looping because PostgreSQL is dead from a full disk,
 * the periodic job never gets a chance to run. The boot-time check fires
 * before Prisma connects, so the operator who SSHs into a flapping host
 * sees a clear "DB volume X has Y MB free" line in the journal/event log
 * instead of digging through a cryptic Prisma connection error.
 *
 * Deliberately non-fatal: refusing to start would prevent recovery in the
 * (common) case where the disk has 50 MB free, just enough for Postgres to
 * complete WAL replay if the operator clears a few log files. The log
 * message is the operationally useful artifact.
 *
 * Cross-platform via `node:fs/promises` — works identically on RHEL,
 * Ubuntu, and Windows. Each platform reports drives/mounts the same way
 * to `statfs()` and `stat()`.
 */

import { statfs, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "./logger.js";
import { BACKUP_DIR, STATE_DIR } from "./paths.js";

const APP_DIR = dirname(fileURLToPath(import.meta.url));

const RED_THRESHOLD_PCT = 0.10;   // <10% free → error log
const AMBER_THRESHOLD_PCT = 0.20; // 10–20% free → warn log

/**
 * Conventional PGDATA paths per platform. Used only when the DATABASE_URL
 * resolves to localhost (so we know we're checking the right machine) and
 * we haven't connected to the DB yet (so `SHOW data_directory` isn't an
 * option). When none of the candidates exist, the DB volume just doesn't
 * appear in the report — the periodic capacityWatch job will pick it up
 * authoritatively once the first query lands.
 */
const PG_DATA_DIR_CANDIDATES: string[] = process.platform === "win32"
  ? [
      "C:\\Program Files\\PostgreSQL\\17\\data",
      "C:\\Program Files\\PostgreSQL\\16\\data",
      "C:\\Program Files\\PostgreSQL\\15\\data",
      "C:\\Program Files\\PostgreSQL\\14\\data",
      "C:\\Program Files\\PostgreSQL\\13\\data",
    ]
  : [
      // RHEL / Fedora: /var/lib/pgsql/data (and version-suffixed PGDG paths)
      "/var/lib/pgsql/data",
      "/var/lib/pgsql/17/data",
      "/var/lib/pgsql/16/data",
      "/var/lib/pgsql/15/data",
      // Debian / Ubuntu: /var/lib/postgresql/<version>/main
      "/var/lib/postgresql/17/main",
      "/var/lib/postgresql/16/main",
      "/var/lib/postgresql/15/main",
      "/var/lib/postgresql/14/main",
    ];

function isDbLocal(): boolean {
  const url = process.env.DATABASE_URL || "";
  const m = url.match(/@([^:/?]+)/);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

async function pickFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    try {
      await stat(p);
      return p;
    } catch {
      // not present, keep going
    }
  }
  return null;
}

interface ProbedVolume {
  role: "app" | "state" | "backups" | "db";
  path: string;
  freeBytes: number;
  totalBytes: number;
  freePct: number;
  dev: number;
}

async function probe(role: ProbedVolume["role"], path: string): Promise<ProbedVolume | null> {
  try {
    const [fs, st] = await Promise.all([statfs(path), stat(path)]);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    const totalBytes = Number(fs.blocks) * Number(fs.bsize);
    return {
      role,
      path,
      freeBytes,
      totalBytes,
      freePct: totalBytes > 0 ? freeBytes / totalBytes : 1,
      dev: Number(st.dev),
    };
  } catch {
    return null;
  }
}

/**
 * Run the boot-time disk diagnostic and log per-volume results. Callers
 * should NOT await this if they don't need to — failures are caught
 * internally and the function never throws.
 */
export async function runStartupDiskCheck(): Promise<void> {
  try {
    const candidates: Array<{ role: ProbedVolume["role"]; path: string }> = [
      { role: "app", path: APP_DIR },
      { role: "state", path: STATE_DIR },
      { role: "backups", path: BACKUP_DIR },
    ];

    if (isDbLocal()) {
      const pgPath = await pickFirstExistingPath(PG_DATA_DIR_CANDIDATES);
      if (pgPath) candidates.push({ role: "db", path: pgPath });
    }

    const probed = (await Promise.all(candidates.map((c) => probe(c.role, c.path))))
      .filter((p): p is ProbedVolume => p !== null);

    // Dedupe by stat.dev so single-LV boxes don't emit four identical lines.
    const byDev = new Map<number, ProbedVolume & { roles: string[]; paths: string[] }>();
    for (const p of probed) {
      const existing = byDev.get(p.dev);
      if (existing) {
        if (!existing.roles.includes(p.role)) existing.roles.push(p.role);
        if (!existing.paths.includes(p.path)) existing.paths.push(p.path);
      } else {
        byDev.set(p.dev, { ...p, roles: [p.role], paths: [p.path] });
      }
    }

    for (const v of byDev.values()) {
      const freeMb = Math.round(v.freeBytes / (1024 * 1024));
      const totalMb = Math.round(v.totalBytes / (1024 * 1024));
      const ctx = {
        roles: v.roles,
        path: v.paths[0],
        freeMb,
        totalMb,
        freePct: Number((v.freePct * 100).toFixed(1)),
      };

      if (v.freePct < RED_THRESHOLD_PCT) {
        logger.error(
          ctx,
          `STARTUP DISK CHECK: critical free space on ${v.roles.join("+")} volume — ${freeMb}MB / ${totalMb}MB (${(v.freePct * 100).toFixed(1)}%)`,
        );
      } else if (v.freePct < AMBER_THRESHOLD_PCT) {
        logger.warn(
          ctx,
          `STARTUP DISK CHECK: low free space on ${v.roles.join("+")} volume — ${freeMb}MB / ${totalMb}MB (${(v.freePct * 100).toFixed(1)}%)`,
        );
      } else {
        logger.info(
          ctx,
          `Startup disk check ok: ${v.roles.join("+")} volume — ${freeMb}MB / ${totalMb}MB (${(v.freePct * 100).toFixed(1)}%)`,
        );
      }
    }
  } catch (err: any) {
    // Diagnostic only — never block boot.
    logger.debug({ err: err?.message }, "startupDiskCheck failed (non-fatal)");
  }
}
