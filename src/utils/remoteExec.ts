/**
 * src/utils/remoteExec.ts — shared SSH / WinRM remote-execution primitives.
 *
 * Extracted verbatim from agentInstallService.ts (which re-imports from here)
 * so the agentless processes-stream collectors (agentlessProcessService) can
 * run remote commands without depending on the installer module. Behavior is
 * unchanged: password-or-key SSH connect with a 30s ready timeout, KILL-on-
 * timeout exec, and the UTF-16-LE -EncodedCommand PowerShell wrapper that
 * sidesteps every cmd.exe/WS-Man quoting rule.
 */

import { Client as SshClient } from "ssh2";
import { winrmRunOne, type WinRmConnection, type CommandResult } from "./winrm.js";

export interface ExecResult { exitCode: number | null; stdout: string; stderr: string }

/**
 * Open one SSH session from a credential config ({username, password |
 * privateKey, port?}), run `fn`, and always close the client. Rejects on
 * connect/auth failure.
 */
export function withSshClient<T>(
  host: string,
  config: Record<string, unknown>,
  fn: (client: SshClient) => Promise<T>,
): Promise<T> {
  const username = String(config.username || "");
  const password = typeof config.password === "string" ? config.password : "";
  const privateKey = typeof config.privateKey === "string" ? config.privateKey : "";
  const port = Number.isFinite(Number(config.port)) ? Number(config.port) : 22;
  if (!username || (!password && !privateKey)) {
    return Promise.reject(new Error("SSH credential is missing username or password/privateKey"));
  }

  return new Promise<T>((resolve, reject) => {
    const client = new SshClient();
    let settled = false;
    const finish = (err: Error | null, val?: T) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(val as T);
    };

    client.on("ready", async () => {
      try {
        const v = await fn(client);
        finish(null, v);
      } catch (err: any) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    client.on("error", (err) => finish(err));

    const opts: any = { host, port, username, readyTimeout: 30_000 };
    if (privateKey) opts.privateKey = privateKey;
    else opts.password = password;
    try {
      client.connect(opts);
    } catch (err: any) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Run one command on an open SSH client, killing the channel on timeout. */
export function sshExec(client: SshClient, cmd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      const timer = setTimeout(() => {
        try { stream.signal("KILL"); } catch { /* ignore */ }
        reject(new Error(`Remote command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      stream.on("close", (code: number) => {
        clearTimeout(timer);
        exitCode = code ?? null;
        resolve({ exitCode, stdout, stderr });
      });
      stream.on("data",   (d: Buffer) => { stdout += d.toString("utf8"); });
      stream.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    });
  });
}

/** SFTP-write a small file (installer staging). */
export function sftpPut(client: SshClient, remotePath: string, body: Buffer, mode: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath, { mode });
      stream.on("error", reject);
      stream.on("close", () => resolve());
      stream.end(body);
    });
  });
}

/** Connect + run one command in a single call (credential-config flavor). */
export function sshRunOne(
  host: string,
  credConfig: Record<string, unknown>,
  cmd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return withSshClient(host, credConfig, (client) => sshExec(client, cmd, timeoutMs));
}

/**
 * Run a PowerShell script over WinRM via -EncodedCommand (UTF-16-LE base64 —
 * immune to cmd.exe/WS-Man quoting). Keep scripts compact: WinRS routes the
 * command line through cmd.exe, whose ceiling is 8191 chars; base64(utf16le)
 * inflates the script ~2.7x, so ~2.5 KB of source is the practical limit.
 */
export function winrmRunPowershell(conn: WinRmConnection, script: string): Promise<CommandResult> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return winrmRunOne(conn, "powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encoded,
  ]);
}
