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
