/**
 * src/services/certInfo.ts — single source of truth for the leaf cert that
 * agents will pin against, regardless of WHERE TLS is terminated.
 *
 * Two modes:
 *   - **proxy mode** (POLARIS_PROXY_CERT_PATH set): reads the PEM from disk.
 *     The cert nginx serves IS what agents pin. Layered cache + last-known-
 *     good fallback survives cert-rotation atomic-rename windows.
 *   - **Node-HTTPS mode** (legacy): httpsRuntime hands us the in-memory PEM
 *     via setRuntimeCertPem() whenever the listener (re)loads its cert.
 *
 * Public API is mode-agnostic — every caller of getServerCertFingerprint() /
 * getServerCertHostnames() / getServerCertExpiry() gets the right value
 * automatically.
 *
 * Design review notes folded in:
 *   §5 (layered cache): hash file bytes as the cache key, only re-parse on
 *       content change. parseFromBytes is the expensive step.
 *   §6 (zero-byte / atomic-rename): bounded retry (100ms x 1), suppress
 *       repeat warnings while the failure persists, return last-known-good.
 */

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, X509Certificate } from "node:crypto";
import { isProxyMode } from "../utils/proxyMode.js";
import { logger } from "../utils/logger.js";

interface CachedCert {
  /** SHA-256 of the raw file bytes — cache key for "do I need to re-parse?". */
  sha256: string;
  /** sha256:<hex> of the cert's DER bytes — what agents pin against. */
  fingerprint: string;
  cn: string | null;
  dnsSans: string[];
  ipSans: string[];
  /** ISO 8601 expiry date, or null if unparseable. */
  expiresAt: string | null;
  parsedAt: number;
}

// ─── Mode state ─────────────────────────────────────────────────────────────

let runtimePem: string | Buffer | null = null;

/**
 * In Node-HTTPS mode, the httpsRuntime listener calls this every time it
 * (re)loads its cert. In proxy mode this is never called (or if it is, it's
 * silently ignored — proxy mode reads from disk).
 */
export function setRuntimeCertPem(pem: string | Buffer | null): void {
  if (isProxyMode()) return; // proxy mode is the source of truth — don't accept overrides
  runtimePem = pem;
}

export function clearRuntimeCertPem(): void {
  runtimePem = null;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

let lastGood: CachedCert | null = null;
// Suppress repeated warn logs while a failure persists. Reset on next success.
let warnSuppressed = false;

/**
 * Read + parse the active cert (whichever mode), returning a fresh
 * CachedCert OR `lastGood` on transient failures. Never throws.
 */
function readActiveCert(): CachedCert | null {
  const bytes = readPemBytes();
  if (!bytes || bytes.length === 0) {
    return lastGood;
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (lastGood && lastGood.sha256 === sha256) {
    return lastGood; // unchanged — no re-parse
  }

  const parsed = parseFromBytes(bytes, sha256);
  if (parsed) {
    lastGood = parsed;
    if (warnSuppressed) {
      logger.info("Cert read+parse succeeded after prior failure — clearing warn suppression");
      warnSuppressed = false;
    }
    return parsed;
  }

  return lastGood; // parse failed; return previous good (may be null on first read)
}

/**
 * Read the raw PEM bytes from whichever source applies. Bounded retry
 * (100ms × 1) on ENOENT / zero-byte / read error so a certbot-style atomic
 * rename window doesn't poison the cache.
 */
function readPemBytes(): Buffer | null {
  if (isProxyMode()) {
    const path = process.env.POLARIS_PROXY_CERT_PATH!;
    const first = tryReadFile(path);
    if (first && first.length > 0) return first;
    // Atomic-rename window: a single 100ms retry covers most rename gaps
    // without turning a real config error into a multi-second hang.
    sleepSync(100);
    const second = tryReadFile(path);
    if (second && second.length > 0) return second;
    if (!warnSuppressed) {
      logger.warn({ path }, "Cert file unreadable or empty after retry — returning last-known-good (may be null)");
      warnSuppressed = true;
    }
    return null;
  }

  // Node-HTTPS mode: PEM was handed in by httpsRuntime
  if (!runtimePem) return null;
  return Buffer.isBuffer(runtimePem) ? runtimePem : Buffer.from(runtimePem);
}

function tryReadFile(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Synchronous sleep — fine here because we're already on the slow path
 * (file read failed) and the alternative is to make every cert accessor
 * async, which ripples through 20+ callers. 100ms is the bounded constant.
 */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  // Use Atomics.wait on a shared buffer? Not worth it for 100ms. Spinwait.
  // Note: Node's event loop is blocked here, but only on the failure path
  // which is rare and short-lived.
  while (Date.now() < end) { /* spin */ }
}
// Quiet the linter — the sleep import is here so callers that want async
// sleep can still get it from this module if we ever flip the API.
void sleep;

function parseFromBytes(bytes: Buffer, sha256: string): CachedCert | null {
  try {
    const x509 = new X509Certificate(bytes);
    const fingerprint = `sha256:${createHash("sha256").update(x509.raw).digest("hex")}`;
    const { cn, dnsSans, ipSans } = extractSubjectAndSans(x509);
    const expiresAt = parseValidTo(x509.validTo);
    return {
      sha256,
      fingerprint,
      cn,
      dnsSans,
      ipSans,
      expiresAt,
      parsedAt: Date.now(),
    };
  } catch (err) {
    if (!warnSuppressed) {
      logger.warn({ err: (err as Error).message }, "Cert PEM parse failed — returning last-known-good (may be null)");
      warnSuppressed = true;
    }
    return null;
  }
}

function extractSubjectAndSans(x509: X509Certificate): { cn: string | null; dnsSans: string[]; ipSans: string[] } {
  let cn: string | null = null;
  for (const line of (x509.subject ?? "").split(/[\r\n]+/)) {
    const m = line.match(/^CN=(.+)$/);
    if (m) { cn = m[1].trim(); break; }
  }
  const dnsSans: string[] = [];
  const ipSans: string[] = [];
  for (const raw of (x509.subjectAltName ?? "").split(",")) {
    const piece = raw.trim();
    if (!piece) continue;
    const dnsMatch = piece.match(/^DNS:(.+)$/);
    if (dnsMatch) { dnsSans.push(dnsMatch[1].trim()); continue; }
    const ipMatch = piece.match(/^IP(?:\s+Address)?:(.+)$/);
    if (ipMatch) { ipSans.push(ipMatch[1].trim()); continue; }
  }
  return { cn, dnsSans, ipSans };
}

function parseValidTo(validTo: string): string | null {
  // X509Certificate.validTo is the cert's notAfter as a UTC string —
  // "Nov 17 12:00:00 2027 GMT" shape. Date can parse it.
  const t = Date.parse(validTo);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * SHA-256 fingerprint of the active leaf cert as `sha256:<lowercase-hex>`.
 * Baked into each Polaris Agent's `agent.conf` at install time so the
 * agent's Go TLS client can pin Polaris's cert and skip the system CA
 * trust chain entirely (defends against CA-compromise / MITM scenarios).
 *
 * Returns null when no cert is available: in Node-HTTPS mode, the listener
 * isn't running yet; in proxy mode, the cert file is unreadable AND no
 * previous good fingerprint is cached (e.g. very first boot, mid-rotation).
 */
export function getServerCertFingerprint(): string | null {
  return readActiveCert()?.fingerprint ?? null;
}

/**
 * Hostnames the active leaf cert is valid for: CN + DNS SANs + IP SANs.
 * Used by agentInstallService.inferOwnServerUrl() to derive a default
 * server_url for agent.conf when neither POLARIS_PUBLIC_URL nor the
 * operator override Setting is set.
 */
export function getServerCertHostnames(): { cn: string | null; dnsSans: string[]; ipSans: string[] } | null {
  const c = readActiveCert();
  if (!c) return null;
  return { cn: c.cn, dnsSans: c.dnsSans, ipSans: c.ipSans };
}

/**
 * ISO 8601 expiry date of the active leaf cert, or null if no cert or
 * the notAfter field is unparseable. Surfaced in the Server Settings →
 * Identification informational pane so operators see when nginx's cert
 * is about to expire even though Polaris doesn't manage it.
 */
export function getServerCertExpiry(): string | null {
  return readActiveCert()?.expiresAt ?? null;
}

/**
 * Test-only: drop the cache. Vitest test isolation needs to flip env vars
 * between tests, which means the cached fingerprint from a prior test
 * would otherwise leak. Don't call from production code.
 */
export function __resetCertInfoCacheForTests(): void {
  lastGood = null;
  warnSuppressed = false;
  runtimePem = null;
}
