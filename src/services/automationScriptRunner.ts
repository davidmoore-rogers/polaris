/**
 * src/services/automationScriptRunner.ts
 *
 * Server-side executor for pending AutomationScriptRun rows (runOn="server").
 * Driven by the runAutomationScripts job (5s tick, web/all role). NEVER runs
 * inline in the engine or the delivery drain — script execution is queued
 * work with its own claim pass, exactly like the delivery pipeline.
 *
 * Execution model (SECURITY-SENSITIVE — this executes operator-authored code
 * as the polaris service user):
 *   - claim: pending→running via updateMany on a bounded id set (restart-safe;
 *     a concurrently-claimed row simply isn't in the update count), with a
 *     stuck-running sweep (running > timeout + 60s ⇒ status "timeout").
 *   - execute: the script body is written to a 0600 temp file under the state
 *     dir and passed to the interpreter via execFile — the args string is a
 *     SINGLE argv entry, never shell-interpolated; alert context rides env
 *     vars (POLARIS_ALERT_ID / POLARIS_RULE / POLARIS_ASSET). Kill on
 *     timeout; stdout/stderr captured with a 64 KB cap; temp file always
 *     deleted.
 *   - record: exitCode/status/output/completedAt + one audit Event per run
 *     (`automation.script.run`, warning on failure/timeout).
 *   - sweep: prunes completed runs older than the retention window.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { STATE_DIR } from "../utils/paths.js";
import { logEvent } from "./eventLogService.js";
import { pruneOldRuns } from "./automationScriptService.js";

const CONCURRENCY = 2;
const CLAIM_BATCH = 10;
const OUTPUT_CAP_BYTES = 64 * 1024;
const STUCK_GRACE_MS = 60_000;
const SCRIPT_TMP_DIR = resolve(STATE_DIR, "data", "automation-scripts-tmp");

/** Interpreter → [binary, argv prefix]. The temp file path + rendered args are
 *  appended as discrete argv entries — no shell ever parses them. */
function interpreterArgv(interpreter: string, scriptPath: string, args: string | null): { bin: string; argv: string[] } | null {
  const tail = args !== null && args !== "" ? [args] : [];
  switch (interpreter) {
    case "bash": return { bin: "bash", argv: [scriptPath, ...tail] };
    case "sh": return { bin: "sh", argv: [scriptPath, ...tail] };
    case "python3": return { bin: "python3", argv: [scriptPath, ...tail] };
    case "powershell": {
      const bin = process.platform === "win32" ? "powershell.exe" : "pwsh";
      return { bin, argv: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...tail] };
    }
    case "cmd":
      if (process.platform !== "win32") return null;
      return { bin: "cmd.exe", argv: ["/d", "/s", "/c", scriptPath, ...tail] };
    default:
      return null;
  }
}

function scriptFileExtension(interpreter: string): string {
  switch (interpreter) {
    case "powershell": return ".ps1";
    case "cmd": return ".cmd";
    case "python3": return ".py";
    default: return ".sh";
  }
}

interface ExecResult {
  status: "succeeded" | "failed" | "timeout";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Execute one claimed run row. Exported for tests (fake interpreter). */
export async function executeServerScript(run: {
  id: string;
  scriptId: string | null;
  args: string | null;
  timeoutSec: number;
  notificationId: string | null;
  ruleId: string | null;
  assetId: string | null;
}): Promise<ExecResult> {
  const script = run.scriptId ? await prisma.automationScript.findUnique({ where: { id: run.scriptId } }) : null;
  if (!script) return { status: "failed", exitCode: null, stdout: "", stderr: "script no longer exists in the registry" };
  if (!script.enabled) return { status: "failed", exitCode: null, stdout: "", stderr: "script is disabled" };

  await mkdir(SCRIPT_TMP_DIR, { recursive: true });
  const scriptPath = resolve(SCRIPT_TMP_DIR, `run-${run.id}-${randomUUID().slice(0, 8)}${scriptFileExtension(script.interpreter)}`);
  const spec = interpreterArgv(script.interpreter, scriptPath, run.args);
  if (!spec) return { status: "failed", exitCode: null, stdout: "", stderr: `interpreter "${script.interpreter}" is not available on this platform` };

  try {
    await writeFile(scriptPath, script.body, { encoding: "utf8", mode: 0o600 });
    return await new Promise<ExecResult>((resolveExec) => {
      execFile(
        spec.bin,
        spec.argv,
        {
          timeout: run.timeoutSec * 1000,
          killSignal: "SIGKILL",
          maxBuffer: OUTPUT_CAP_BYTES,
          env: {
            ...process.env,
            POLARIS_ALERT_ID: run.notificationId ?? "",
            POLARIS_RULE: run.ruleId ?? "",
            POLARIS_ASSET: run.assetId ?? "",
          },
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const out = String(stdout ?? "").slice(0, OUTPUT_CAP_BYTES);
          const errOut = String(stderr ?? "").slice(0, OUTPUT_CAP_BYTES);
          if (!err) {
            resolveExec({ status: "succeeded", exitCode: 0, stdout: out, stderr: errOut });
            return;
          }
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
          // A maxBuffer kill also sets killed=true — classify it as a failure
          // (output cap exceeded), not a timeout.
          const bufferExceeded = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/.test(e.message);
          const timedOut = !bufferExceeded && (e.killed === true || e.signal === "SIGKILL" || e.signal === "SIGTERM");
          resolveExec({
            status: timedOut ? "timeout" : "failed",
            exitCode: typeof e.code === "number" ? e.code : null,
            stdout: out,
            stderr: bufferExceeded ? `output exceeded the ${OUTPUT_CAP_BYTES / 1024} KB cap` : errOut || e.message.slice(0, 1000),
          });
        },
      );
    });
  } catch (err) {
    return { status: "failed", exitCode: null, stdout: "", stderr: (err as Error).message.slice(0, 1000) };
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}

/** One runner tick: stuck sweep → claim → execute (bounded) → record. */
export async function runPendingServerScripts(): Promise<{ started: number; completed: number }> {
  const now = new Date();

  // Stuck-running sweep: a run whose window (timeout + grace) elapsed without
  // completing — e.g. the process died mid-run — flips to timeout.
  const stuck = await prisma.automationScriptRun.findMany({
    where: { status: "running", runOn: "server", startedAt: { not: null } },
    select: { id: true, startedAt: true, timeoutSec: true, scriptName: true },
  });
  for (const s of stuck) {
    if (s.startedAt && now.getTime() - s.startedAt.getTime() > s.timeoutSec * 1000 + STUCK_GRACE_MS) {
      await prisma.automationScriptRun.update({
        where: { id: s.id, status: "running" },
        data: { status: "timeout", completedAt: now, stderr: "run abandoned (process restart or wedge) — swept by the runner" },
      });
    }
  }

  // Claim a bounded batch pending→running. updateMany's WHERE re-checks
  // status so a row another process claimed is silently skipped.
  const candidates = await prisma.automationScriptRun.findMany({
    where: { status: "pending", runOn: "server" },
    orderBy: { requestedAt: "asc" },
    take: CLAIM_BATCH,
    select: { id: true },
  });
  if (candidates.length === 0) {
    // Piggyback the retention sweep on idle ticks (cheap deleteMany).
    await pruneOldRuns().catch(() => {});
    return { started: 0, completed: 0 };
  }
  const ids = candidates.map((c) => c.id);
  await prisma.automationScriptRun.updateMany({
    where: { id: { in: ids }, status: "pending" },
    data: { status: "running", startedAt: now },
  });
  const claimed = await prisma.automationScriptRun.findMany({
    where: { id: { in: ids }, status: "running" },
  });

  let completed = 0;
  for (let i = 0; i < claimed.length; i += CONCURRENCY) {
    const chunk = claimed.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (run) => ({ run, res: await executeServerScript(run) })));
    for (const { run, res } of results) {
      await prisma.automationScriptRun.update({
        where: { id: run.id },
        data: { status: res.status, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, completedAt: new Date() },
      });
      completed++;
      await logEvent({
        action: "automation.script.run",
        resourceType: "automation-script",
        resourceId: run.scriptId ?? undefined,
        resourceName: run.scriptName,
        actor: run.requestedBy ?? "system:automation",
        level: res.status === "succeeded" ? "info" : "warning",
        message: `Automation script "${run.scriptName}" ${res.status} on server (exit ${res.exitCode ?? "n/a"})`,
        details: {
          runId: run.id,
          scriptId: run.scriptId,
          ruleId: run.ruleId,
          notificationId: run.notificationId,
          exitCode: res.exitCode,
          runOn: "server",
          status: res.status,
        },
      }).catch(() => {});
    }
  }

  logger.debug({ started: claimed.length, completed }, "automation script runner tick");
  return { started: claimed.length, completed };
}
