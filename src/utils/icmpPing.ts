/**
 * src/utils/icmpPing.ts — single-echo ICMP reachability check via the system
 * `ping` binary. Extracted from monitoringService's probeIcmp so non-monitor
 * callers (the AD/Entra presence-verification pass) can ping a host without
 * pulling in the monitoring service. monitoringService.probeIcmp delegates
 * here and adapts the result to its ProbeResult shape.
 */

import { spawn } from "node:child_process";

export interface IcmpPingResult {
  success: boolean;
  /** Short human-readable reason on failure; absent on success. */
  error?: string;
}

export async function pingHost(host: string, timeoutMs: number): Promise<IcmpPingResult> {
  return await new Promise<IcmpPingResult>((resolve) => {
    const isWindows = process.platform === "win32";
    const args = isWindows
      ? ["-n", "1", "-w", String(timeoutMs), host]
      : ["-c", "1", "-W", String(Math.ceil(timeoutMs / 1000)), host];
    const child = spawn("ping", args, { stdio: ["ignore", "pipe", "pipe"] });
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch { /* already exited */ }
      resolve({ success: false, error: "ping timed out" });
    }, timeoutMs + 2_000);
    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === 0) resolve({ success: true });
      else resolve({ success: false, error: `ping exit ${code}` });
    });
  });
}
