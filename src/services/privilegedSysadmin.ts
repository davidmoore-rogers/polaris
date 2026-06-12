/**
 * src/services/privilegedSysadmin.ts
 *
 * Thin TypeScript wrapper around `sudo /usr/local/sbin/polaris-nginx-apply`.
 * The wrapper script (deploy/scripts/polaris-nginx-apply.sh) is the entire
 * privileged surface granted to the polaris OS user — see the comments at
 * the top of that file. All subcommand + arg validation lives in the shell
 * wrapper; this module is just process glue.
 *
 * The caller writes staged files to /run/polaris-nginx-stage/ (writable by
 * polaris) via stageNginxConfig() / stageCertAndKey() before calling
 * runNginxApply().
 *
 * Output is captured stdout+stderr interleaved (limited to 64 KB to keep
 * pathological cases bounded). Failures surface as a non-zero exitCode in
 * the result; throwing is reserved for sudo-or-spawn errors before the
 * wrapper even runs.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const WRAPPER_PATH = "/usr/local/sbin/polaris-nginx-apply";
const STAGE_DIR = "/run/polaris-nginx-stage";
const DEFAULT_TIMEOUT_MS = 35_000; // wrapper caps each op at 30s; we add 5s headroom.
const MAX_OUTPUT_BYTES = 64 * 1024;

export type NginxApplySubcommand =
  | { kind: "apply-config" }
  | { kind: "rotate-cert" }
  | { kind: "reload" }
  | { kind: "verify-listening"; port: number };

export interface WrapperResult {
  exitCode: number;
  /** stdout + stderr interleaved, truncated at MAX_OUTPUT_BYTES. */
  output: string;
  durationMs: number;
  truncated: boolean;
}

export async function runNginxApply(
  cmd: NginxApplySubcommand,
  opts: { timeoutMs?: number } = {},
): Promise<WrapperResult> {
  const args: string[] = [WRAPPER_PATH];
  switch (cmd.kind) {
    case "apply-config":
    case "rotate-cert":
    case "reload":
      args.push(cmd.kind);
      break;
    case "verify-listening":
      if (!Number.isInteger(cmd.port) || cmd.port < 1 || cmd.port > 65535) {
        throw new AppError(500, `verify-listening: invalid port ${cmd.port}`);
      }
      args.push("verify-listening", String(cmd.port));
      break;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  return await new Promise<WrapperResult>((resolve, reject) => {
    const child = spawn("sudo", ["-n", "--", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let truncated = false;
    const append = (chunk: Buffer): void => {
      if (truncated) return;
      const text = chunk.toString("utf8");
      const room = MAX_OUTPUT_BYTES - output.length;
      if (text.length <= room) {
        output += text;
      } else {
        output += text.slice(0, room);
        truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? -1,
        output,
        durationMs: Date.now() - start,
        truncated,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Write the rendered nginx config to the staging area where polaris-nginx-apply
 * (running as root) will pick it up. Caller invokes runNginxApply({kind:"apply-config"})
 * immediately after.
 */
export function stageNginxConfig(contents: string): void {
  ensureStageDir();
  const path = `${STAGE_DIR}/polaris.conf`;
  writeFileSync(path, contents, { mode: 0o640 });
}

export function stageCertAndKey(certPem: string, keyPem: string): void {
  ensureStageDir();
  writeFileSync(`${STAGE_DIR}/cert.pem`, certPem, { mode: 0o640 });
  writeFileSync(`${STAGE_DIR}/key.pem`, keyPem, { mode: 0o640 });
}

function ensureStageDir(): void {
  if (existsSync(STAGE_DIR)) return;
  // systemd-tmpfiles creates this on boot via deploy/tmpfiles.d/polaris-nginx.conf;
  // mkdirSync here is a dev/test fallback for hosts where tmpfiles didn't run.
  try {
    mkdirSync(STAGE_DIR, { recursive: true, mode: 0o750 });
    chmodSync(STAGE_DIR, 0o750);
  } catch (err: any) {
    logger.warn({ err: err?.message, dir: STAGE_DIR }, "Could not create staging dir; subsequent stage* calls will fail");
  }
}

/**
 * True iff the privileged wrapper is installed on this host. Used by route
 * handlers to short-circuit with a clear error on dev boxes where Phase 2's
 * setup-script changes haven't been applied yet.
 */
export function isWrapperAvailable(): boolean {
  return existsSync(WRAPPER_PATH);
}
