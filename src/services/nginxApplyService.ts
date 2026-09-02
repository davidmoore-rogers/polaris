/**
 * src/services/nginxApplyService.ts
 *
 * Orchestrator that combines proxyConfig persistence, the nginx renderer,
 * privileged sysadmin calls, certInfo cache invalidation, and the bootstrap
 * parser into the four user-facing operations the GUI exposes:
 *
 *   applyProxyConfig({...changes}?)      — save (if changes given), render,
 *                                          stage, sudo apply, record hash.
 *   rotateCertAndKey(certPem, keyPem)    — validate pair, stage, sudo apply,
 *                                          invalidate certInfo cache.
 *   bootstrapProxyConfig()               — first-boot seed of proxyConfig
 *                                          from the live nginx config (one-
 *                                          shot, only runs in proxy mode).
 *   getDriftStatus()                     — compare live file hash against
 *                                          lastAppliedHash for the GUI
 *                                          banner.
 *
 * Trust + flow notes:
 *   - The privileged wrapper does the atomic-rename + nginx -t + reload; we
 *     just stage files and parse its output.
 *   - Cert validation is libcrypto-only (SPKI compare) — we do NOT try to
 *     run `nginx -t` against a staged cert path because that requires
 *     rewriting the live config. Instead we rely on nginx's graceful-reload
 *     semantics: if the new cert is bad, old workers keep serving the old
 *     cert and the wrapper exit code + journalctl tail surface the failure.
 */

import { readFile } from "node:fs/promises";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";
import { renderNginxConfig } from "./nginxRenderer.js";
import { parseNginxConfig } from "./nginxConfigParser.js";
import { deriveApiDocsNginxAllow, getApiDocsSettings } from "./apiDocsAccessService.js";
import {
  runNginxApply,
  stageNginxConfig,
  stageCertAndKey,
  isWrapperAvailable,
} from "./privilegedSysadmin.js";
import {
  getProxyConfig,
  saveProxyConfig,
  proxyConfigRowExists,
} from "./proxyConfigService.js";
import { invalidateCache as invalidateCertInfoCache, getServerCertFingerprint } from "./certInfo.js";
import { isProxyMode } from "../utils/proxyMode.js";
import { deriveNginxServerName, derivePolarisPort } from "../utils/publicUrl.js";
import { resolveDashPort } from "../utils/dashConfig.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";
import type { ProxyConfig } from "../types/proxyConfig.js";

const LIVE_NGINX_CONF = "/etc/nginx/conf.d/polaris.conf";

export interface ApplyResult {
  ok: boolean;
  /** sha256 of the rendered config that was applied (or attempted). */
  hash: string;
  /** Wrapper stdout+stderr — surfaced to the UI on failure. */
  wrapperOutput: string;
  /** Output of `verify-listening` — only present on success. */
  listening?: string;
}

export interface CertRotateResult {
  ok: boolean;
  fingerprint?: string;
  wrapperOutput: string;
}

export interface DriftStatus {
  managedMode: boolean;
  /** sha256 of /etc/nginx/conf.d/polaris.conf right now, or null if unreadable. */
  liveHash: string | null;
  /** Whatever Polaris recorded the last time it wrote the file. */
  expectedHash: string | null;
  /** Markers of customization beyond the 6 controls (location blocks, custom headers, etc.). */
  driftMarkers: string[];
}

// ─── apply: render + stage + sudo apply + record hash ─────────────────────

export async function applyProxyConfig(changes?: Partial<ProxyConfig>): Promise<ApplyResult> {
  if (!isWrapperAvailable()) {
    throw new AppError(503, "polaris-nginx-apply wrapper is not installed; run the in-app updater or re-run setup-rhel.sh");
  }
  // Persist changes first (validation lives inside saveProxyConfig).
  const cfg = changes ? await saveProxyConfig(changes) : await getProxyConfig();
  if (!cfg.managedMode) {
    throw new AppError(409, "proxyConfig is in adopt-required mode — operator must click 'Adopt managed mode' before apply");
  }

  const { contents, sha256 } = renderNginxConfig({
    config: cfg,
    serverName: deriveNginxServerName(),
    polarisPort: derivePolarisPort(),
    dashPort: resolveDashPort(),
    apiDocsAllow: deriveApiDocsNginxAllow(await getApiDocsSettings()),
  });

  stageNginxConfig(contents);
  const result = await runNginxApply({ kind: "apply-config" });
  if (result.exitCode !== 0) {
    logger.warn({ exitCode: result.exitCode, output: result.output }, "nginx apply-config failed");
    return { ok: false, hash: sha256, wrapperOutput: result.output };
  }

  await saveProxyConfig({
    lastAppliedAt: new Date().toISOString(),
    lastAppliedHash: sha256,
  });

  const verify = await runNginxApply({ kind: "verify-listening", port: cfg.httpsPort });
  return {
    ok: true,
    hash: sha256,
    wrapperOutput: result.output,
    listening: verify.exitCode === 0 ? verify.output : `(verify-listening failed: ${verify.output})`,
  };
}

// ─── cert rotation: SPKI pair check + stage + sudo apply ──────────────────

export async function rotateCertAndKey(certPem: string, keyPem: string): Promise<CertRotateResult> {
  if (!isWrapperAvailable()) {
    throw new AppError(503, "polaris-nginx-apply wrapper is not installed");
  }
  validateCertKeyPair(certPem, keyPem);

  stageCertAndKey(certPem, keyPem);
  const result = await runNginxApply({ kind: "rotate-cert" });
  invalidateCertInfoCache();

  if (result.exitCode !== 0) {
    logger.warn({ exitCode: result.exitCode, output: result.output }, "cert rotation failed");
    return { ok: false, wrapperOutput: result.output };
  }

  // Compute the new fingerprint so the route handler can return it without
  // waiting for certInfo's next read.
  const x509 = new X509Certificate(certPem);
  const fingerprint = `sha256:${createHash("sha256").update(x509.raw).digest("hex")}`;
  return { ok: true, fingerprint, wrapperOutput: result.output };
}

/**
 * Inspect the supplied cert+key pair without touching anything on disk.
 * Returns the new cert's fingerprint, hostnames, expiry, plus the current
 * (pre-rotation) fingerprint so the GUI's orchestration step can later
 * retire it via /server-settings/agents/cert-pins/bulk-remove.
 *
 * The Phase-2 dual-pin model lives in [src/api/routes/serverSettings.ts]
 * (/agents/cert-pins/*) — agents accept a union of canonical + staged
 * fingerprints, so cert rotation is zero-downtime as long as the operator
 * stages the new pin before swapping. The GUI orchestrates that flow;
 * this preflight is intentionally narrow (validation + identifying info).
 */
export function preflightCertRotation(certPem: string, keyPem: string): {
  newFingerprint: string;
  newCn: string | null;
  newDnsSans: string[];
  newExpiresAt: string | null;
  currentFingerprint: string | null;
} {
  validateCertKeyPair(certPem, keyPem);

  const x509 = new X509Certificate(certPem);
  const newFingerprint = `sha256:${createHash("sha256").update(x509.raw).digest("hex")}`;
  const cn = extractCn(x509.subject ?? "");
  const dnsSans = extractDnsSans(x509.subjectAltName ?? "");
  const expiresAt = parseExpiry(x509.validTo);

  return {
    newFingerprint,
    newCn: cn,
    newDnsSans: dnsSans,
    newExpiresAt: expiresAt,
    currentFingerprint: getServerCertFingerprint(),
  };
}

function validateCertKeyPair(certPem: string, keyPem: string): void {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    throw new AppError(400, "Cert PEM does not parse as a valid X.509 certificate");
  }
  const notAfter = Date.parse(cert.validTo);
  if (Number.isFinite(notAfter) && notAfter < Date.now()) {
    throw new AppError(400, `Certificate has already expired (validTo=${cert.validTo})`);
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(keyPem);
  } catch {
    throw new AppError(400, "Key PEM does not parse as a valid private key");
  }
  let publicFromKey;
  try {
    publicFromKey = createPublicKey(privateKey);
  } catch {
    throw new AppError(400, "Could not derive a public key from the provided private key");
  }
  // Compare SPKI bytes — the cert's public key must match the public key
  // derived from the private key, which proves the pair belongs together.
  const certPubSpki = createPublicKey({ key: cert.publicKey.export({ format: "pem", type: "spki" }) as string, format: "pem" })
    .export({ format: "der", type: "spki" });
  const keyPubSpki = publicFromKey.export({ format: "der", type: "spki" });
  if (!certPubSpki.equals(keyPubSpki)) {
    throw new AppError(400, "Private key does not match the certificate's public key");
  }
}

// ─── bootstrap: first-boot seed of proxyConfig from live config ──────────

export async function bootstrapProxyConfig(): Promise<void> {
  if (!isProxyMode()) return;
  if (await proxyConfigRowExists()) return;

  let liveText: string | null = null;
  try {
    liveText = await readFile(LIVE_NGINX_CONF, "utf8");
  } catch (err: any) {
    logger.info({ err: err?.message }, "proxyConfig bootstrap: live nginx config not readable; seeding defaults with managedMode=false");
  }

  const { config: parsed, drift } = liveText
    ? parseNginxConfig(LIVE_NGINX_CONF)
    : { config: undefined, drift: ["live nginx config not found"] };

  await saveProxyConfig({
    ...(parsed ?? {}),
    managedMode: false,
    lastAppliedAt: null,
    lastAppliedHash: null,
  });

  if (drift.length > 0) {
    logger.warn(
      { drift },
      "proxyConfig bootstrap: live nginx config has customizations beyond what Polaris manages — GUI will show drift banner until operator clicks 'Adopt managed mode'",
    );
  } else {
    logger.info("proxyConfig bootstrap: seeded from live nginx config (managedMode=false; operator must adopt before applying changes)");
  }
}

// ─── drift status: compare live file against lastAppliedHash ─────────────

export async function getDriftStatus(): Promise<DriftStatus> {
  const cfg = await getProxyConfig();
  let liveHash: string | null = null;
  let driftMarkers: string[] = [];
  try {
    const liveText = await readFile(LIVE_NGINX_CONF, "utf8");
    liveHash = createHash("sha256").update(liveText).digest("hex");
    if (cfg.lastAppliedHash === null || liveHash !== cfg.lastAppliedHash) {
      const { drift } = parseNginxConfig(LIVE_NGINX_CONF);
      driftMarkers = drift;
    }
  } catch {
    driftMarkers = ["live nginx config not readable"];
  }
  return {
    managedMode: cfg.managedMode,
    liveHash,
    expectedHash: cfg.lastAppliedHash,
    driftMarkers,
  };
}

// ─── X.509 field helpers (copy of certInfo internals — not worth exporting) ─

function extractCn(subject: string): string | null {
  for (const line of subject.split(/[\r\n]+/)) {
    const m = line.match(/^CN=(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

function extractDnsSans(subjectAltName: string): string[] {
  const out: string[] = [];
  for (const raw of subjectAltName.split(",")) {
    const m = raw.trim().match(/^DNS:(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function parseExpiry(validTo: string): string | null {
  const t = Date.parse(validTo);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}
