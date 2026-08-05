/**
 * src/utils/publicUrl.ts — derived properties of POLARIS_PUBLIC_URL.
 *
 * Replaces httpsRuntime.getHttpsPort() (now deleted) — Phase 4 removed
 * Node-terminated HTTPS entirely, so there's no listener port to ask about;
 * the only "port" anyone needs is the public-facing port that nginx (or
 * whatever reverse proxy fronts the install) is listening on, which is
 * encoded in POLARIS_PUBLIC_URL.
 *
 * Used by agentInstallService to stamp agent.conf's server_url at install
 * time. If POLARIS_PUBLIC_URL is unset (local dev, no reverse proxy), the
 * helper returns null and the install flow refuses — there's no cert pin
 * to derive an agent from anyway.
 */

/**
 * Parse the port out of `POLARIS_PUBLIC_URL`. Returns:
 *  - the explicit port if the URL has one (e.g. `https://x.example.com:8443` → 8443)
 *  - 443 if the URL is https:// with no explicit port
 *  - 80 if the URL is http:// with no explicit port (uncommon — used in dev)
 *  - null if the env var is unset or malformed
 *
 * Stable across the life of the process (env vars don't change at runtime),
 * so callers can call this freely without caching.
 */
export function getPublicUrlPort(): number | null {
  const raw = process.env.POLARIS_PUBLIC_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Hostname for nginx `server_name` when rendering the managed proxy config —
 * POLARIS_PUBLIC_URL's hostname, else the documented placeholder. The
 * fallback covers dev boxes / unit tests; production proxy mode requires
 * POLARIS_PUBLIC_URL (see the runtimeConfig boot guard). Shared by
 * nginxApplyService and updateService's restart-time config sync.
 */
export function deriveNginxServerName(): string {
  const publicUrl = process.env.POLARIS_PUBLIC_URL;
  if (publicUrl) {
    try { return new URL(publicUrl).hostname; } catch { /* fall through */ }
  }
  return "polaris.example.com";
}

/** The local HTTP port Polaris listens on (PORT, bounds-checked, default 3000). */
export function derivePolarisPort(): number {
  const raw = process.env.PORT;
  if (!raw) return 3000;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}
