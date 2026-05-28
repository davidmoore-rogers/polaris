/**
 * src/utils/proxyMode.ts — single source of truth for "is Polaris fronted by
 * an external reverse proxy (nginx) that terminates TLS?"
 *
 * Reads `POLARIS_PROXY_CERT_PATH` lazily on every call. Forbidden:
 * snapshotting this at module load — Vitest tests flip the env var per-test,
 * future runtime config reloads need a fresh read, and CLI tooling boots in
 * arbitrary order. There is exactly one rule: "is this env var set?". Any
 * future "what cert is nginx serving?" lookup goes through `certInfo.ts`,
 * not through a cached boolean here.
 */

export function isProxyMode(): boolean {
  return Boolean(process.env.POLARIS_PROXY_CERT_PATH);
}
