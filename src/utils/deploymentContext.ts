/**
 * src/utils/deploymentContext.ts
 *
 * Best-effort heuristics for "where is Polaris running?" Used to pick the
 * right help text in operator-facing recommendation alerts (TimescaleDB,
 * pg-boss). Both heuristics are computed once at first call and cached;
 * false negatives are fine — the conservative branch of each alert just
 * shows a more general suggestion.
 *
 *   dbIsLocal()          — is DATABASE_URL pointing at this same host?
 *   runtimeIsContainer() — is Polaris running in Docker / Kubernetes?
 */

import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { URL } from "node:url";

let cachedDbIsLocal: boolean | null = null;
let cachedRuntimeIsContainer: boolean | null = null;

function collectLocalAddresses(): Set<string> {
  const out = new Set<string>(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const addr of list) {
      if (addr.address) out.add(addr.address.toLowerCase());
    }
  }
  return out;
}

export function dbIsLocal(): boolean {
  if (cachedDbIsLocal !== null) return cachedDbIsLocal;
  const url = process.env.DATABASE_URL;
  if (!url) {
    cachedDbIsLocal = false;
    return cachedDbIsLocal;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!host) {
      cachedDbIsLocal = true; // Unix socket / no host = local
      return cachedDbIsLocal;
    }
    const local = collectLocalAddresses();
    cachedDbIsLocal = local.has(host);
    return cachedDbIsLocal;
  } catch {
    cachedDbIsLocal = false;
    return cachedDbIsLocal;
  }
}

export function runtimeIsContainer(): boolean {
  if (cachedRuntimeIsContainer !== null) return cachedRuntimeIsContainer;
  // /.dockerenv is the most reliable signal Docker leaves behind in its images.
  if (existsSync("/.dockerenv")) {
    cachedRuntimeIsContainer = true;
    return cachedRuntimeIsContainer;
  }
  // Kubernetes injects this on every pod regardless of base image.
  if (process.env.KUBERNETES_SERVICE_HOST) {
    cachedRuntimeIsContainer = true;
    return cachedRuntimeIsContainer;
  }
  // POLARIS_STATE_DIR is set by Polaris's own Docker image (polaris-deploy -> env-vars.md). Strong
  // proxy when the other two miss.
  if (process.env.POLARIS_STATE_DIR) {
    cachedRuntimeIsContainer = true;
    return cachedRuntimeIsContainer;
  }
  // /proc/1/cgroup carries the container runtime name on Linux. Read once;
  // fail safe to false on any I/O error or non-Linux host.
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (/docker|containerd|kubepods|crio/.test(cgroup)) {
      cachedRuntimeIsContainer = true;
      return cachedRuntimeIsContainer;
    }
  } catch {
    // Not Linux, /proc not mounted, or no permissions. Treat as bare-metal.
  }
  cachedRuntimeIsContainer = false;
  return cachedRuntimeIsContainer;
}

export interface DeploymentContext {
  dbIsLocal: boolean;
  runtimeIsContainer: boolean;
}

export function getDeploymentContext(): DeploymentContext {
  return { dbIsLocal: dbIsLocal(), runtimeIsContainer: runtimeIsContainer() };
}
