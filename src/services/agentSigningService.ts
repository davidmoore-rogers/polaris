/**
 * src/services/agentSigningService.ts — Azure Trusted Signing for agent binaries
 *
 * Owns the `agent.codeSigning` Setting (operator config for signing the two
 * Windows agent binaries with Azure Trusted Signing via jsign), the
 * `agent.signing.lastFailure` Setting (the durable failure stamp behind the
 * sidebar "unsigned binaries" alert — in-memory build state has a 1h TTL,
 * which is too short for an alert an operator may not see for days), and the
 * jsign invocation itself.
 *
 * Secret discipline mirrors notificationChannelService: `clientSecret` is
 * masked (`••••••••` + `clientSecretSet`) on read and preserved on write when
 * the client echoes the mask or a blank back.
 *
 * Auth: client-credentials token minted directly against Entra ID
 * (login.microsoftonline.com, scope https://codesigning.azure.net/.default) —
 * no Azure CLI dependency. The token reaches jsign via `--storepass
 * env:POLARIS_SIGNING_TOKEN` (jsign's env: indirection), never via argv, so
 * it can't show up in process listings or error output. jsign auto-enables
 * RFC3161 timestamping for TRUSTEDSIGNING (the certs live ~3 days, so a
 * missing countersignature would expire the signature almost immediately).
 *
 * Signing is FAIL-OPEN by design (operator decision): a failure marks the
 * sign step failed + stamps the failure Setting + warns via Event, but the
 * build completes and ships unsigned binaries — never blocks agent rollout.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { prisma } from "../db.js";
import { STATE_DIR } from "../utils/paths.js";
import { SECRET_MASK, isMaskedSecret } from "../utils/secretMask.js";

const execFileAsync = promisify(execFile);

// ─── Setting keys + constants ─────────────────────────────────────────

export const AGENT_SIGNING_SETTING_KEY = "agent.codeSigning";
export const SIGNING_FAILURE_SETTING_KEY = "agent.signing.lastFailure";

/** The shared UI mask sentinel — see src/utils/secretMask.ts. */
export const MASK = SECRET_MASK;

/** Env var jsign reads the access token from (`--storepass env:<name>`). */
export const SIGNING_TOKEN_ENV = "POLARIS_SIGNING_TOKEN";

/**
 * Where resolveJsignJar() looks when the operator hasn't set an explicit
 * path. MUST stay in lockstep with where the deploy surfaces drop the jar:
 * Dockerfile + setup-{rhel,ubuntu}.sh → /opt/polaris/tools/jsign.jar;
 * setup-windows.ps1 → <app dir>\tools\jsign.jar (covered by the cwd probe);
 * POLARIS_STATE_DIR layouts → <state>/tools/jsign.jar.
 */
export const JSIGN_JAR_CANDIDATES: string[] = [
  resolvePath(process.cwd(), "tools", "jsign.jar"),
  resolvePath(STATE_DIR, "tools", "jsign.jar"),
  "/opt/polaris/tools/jsign.jar",
];

// ─── Config shape + mask/merge ────────────────────────────────────────

export interface AgentSigningConfig {
  enabled: boolean;
  /** Trusted Signing endpoint, e.g. https://eus.codesigning.azure.net */
  endpoint: string;
  accountName: string;
  /** Certificate profile name within the account. */
  profileName: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Explicit jsign jar path; "" = probe JSIGN_JAR_CANDIDATES. */
  jsignJarPath: string;
}

export interface MaskedSigningConfig extends Omit<AgentSigningConfig, "clientSecret"> {
  clientSecret: string; // MASK or ""
  clientSecretSet: boolean;
}

export const DEFAULT_SIGNING_CONFIG: AgentSigningConfig = {
  enabled: false,
  endpoint: "",
  accountName: "",
  profileName: "",
  tenantId: "",
  clientId: "",
  clientSecret: "",
  jsignJarPath: "",
};

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? { ...(v as Record<string, unknown>) } : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Mask the secret; report whether one is stored. Pure. */
export function maskSigningConfig(cfg: AgentSigningConfig): MaskedSigningConfig {
  const set = cfg.clientSecret.length > 0;
  return { ...cfg, clientSecret: set ? MASK : "", clientSecretSet: set };
}

/**
 * Merge an incoming (possibly partial, possibly mask-echoing) config onto the
 * stored one. Blank/masked incoming secret keeps the stored secret; strings
 * are trimmed; the endpoint loses any trailing slash; UI-only `clientSecretSet`
 * never persists. Pure.
 */
export function mergeSigningConfig(
  incoming: Record<string, unknown>,
  current: AgentSigningConfig,
): AgentSigningConfig {
  const inc = asObject(incoming);
  const secret = str(inc.clientSecret);
  return {
    enabled: typeof inc.enabled === "boolean" ? inc.enabled : current.enabled,
    endpoint: (inc.endpoint !== undefined ? str(inc.endpoint) : current.endpoint).replace(/\/+$/, ""),
    accountName: inc.accountName !== undefined ? str(inc.accountName) : current.accountName,
    profileName: inc.profileName !== undefined ? str(inc.profileName) : current.profileName,
    tenantId: inc.tenantId !== undefined ? str(inc.tenantId) : current.tenantId,
    clientId: inc.clientId !== undefined ? str(inc.clientId) : current.clientId,
    clientSecret: secret === "" || isMaskedSecret(secret) ? current.clientSecret : secret,
    jsignJarPath: inc.jsignJarPath !== undefined ? str(inc.jsignJarPath) : current.jsignJarPath,
  };
}

// ─── Setting persistence ──────────────────────────────────────────────

export async function getSigningConfigRaw(): Promise<AgentSigningConfig> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: AGENT_SIGNING_SETTING_KEY } });
    return mergeSigningConfig(asObject(row?.value), DEFAULT_SIGNING_CONFIG);
  } catch {
    return { ...DEFAULT_SIGNING_CONFIG };
  }
}

export async function getSigningConfigMasked(): Promise<MaskedSigningConfig> {
  return maskSigningConfig(await getSigningConfigRaw());
}

/**
 * Merge-and-save. Returns the masked result. Disabling signing also clears
 * the failure stamp — a deliberate operator opt-out shouldn't leave a stale
 * "unsigned binaries" alert in everyone's sidebar. Event emission is the
 * route's job (it knows the actor + what changed).
 */
export async function updateSigningConfig(input: Record<string, unknown>): Promise<MaskedSigningConfig> {
  const current = await getSigningConfigRaw();
  const next = mergeSigningConfig(input, current);
  await prisma.setting.upsert({
    where: { key: AGENT_SIGNING_SETTING_KEY },
    update: { value: next as object },
    create: { key: AGENT_SIGNING_SETTING_KEY, value: next as object },
  });
  if (!next.enabled && current.enabled) {
    await clearSigningFailure();
  }
  return maskSigningConfig(next);
}

// ─── Failure stamp (drives the sidebar alert) ─────────────────────────

export interface SigningFailure {
  /** ISO timestamp of the failure — the client's dismissal key. */
  at: string;
  buildId: string;
  version: string;
  /** The windows binaries that failed to sign (filenames). */
  files: string[];
  /** Scrubbed one-line reason. */
  error: string;
}

export async function recordSigningFailure(failure: SigningFailure): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SIGNING_FAILURE_SETTING_KEY },
    update: { value: failure as unknown as object },
    create: { key: SIGNING_FAILURE_SETTING_KEY, value: failure as unknown as object },
  });
}

export async function clearSigningFailure(): Promise<void> {
  await prisma.setting.delete({ where: { key: SIGNING_FAILURE_SETTING_KEY } }).catch(() => {});
}

/** Read the current failure stamp (null = last signed build was clean / never failed). */
export async function getSigningAlert(): Promise<{ failure: SigningFailure | null }> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: SIGNING_FAILURE_SETTING_KEY } });
    const v = asObject(row?.value);
    if (typeof v.at !== "string" || v.at === "") return { failure: null };
    return {
      failure: {
        at: v.at,
        buildId: str(v.buildId),
        version: str(v.version),
        files: Array.isArray(v.files) ? v.files.filter((f): f is string => typeof f === "string") : [],
        error: str(v.error),
      },
    };
  } catch {
    return { failure: null };
  }
}

// ─── Entra ID token (client credentials) ──────────────────────────────

/** AAD resource scope for Azure Trusted Signing. */
export const SIGNING_TOKEN_SCOPE = "https://codesigning.azure.net/.default";

/** Shape the client-credentials request. Pure — unit-testable without network. */
export function buildTokenRequest(cfg: Pick<AgentSigningConfig, "tenantId" | "clientId" | "clientSecret">): {
  url: string;
  body: URLSearchParams;
} {
  return {
    url: `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`,
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: SIGNING_TOKEN_SCOPE,
    }),
  };
}

/**
 * Mint an access token for the Trusted Signing API. Errors surface the AAD
 * error code/description but never the client secret.
 */
export async function fetchSigningToken(cfg: AgentSigningConfig): Promise<string> {
  const { url, body } = buildTokenRequest(cfg);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new Error(`Entra ID token request failed: ${scrubSecrets(err?.message ?? String(err), [cfg.clientSecret])}`);
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body — fall through to the status check */
  }
  if (!res.ok || typeof payload.access_token !== "string") {
    const detail = str(payload.error_description) || str(payload.error) || `HTTP ${res.status}`;
    throw new Error(`Entra ID token request rejected: ${scrubSecrets(detail, [cfg.clientSecret])}`);
  }
  return payload.access_token;
}

// ─── jsign availability + invocation ──────────────────────────────────

/** First existing jar: explicit config path, else the candidate list. */
export async function resolveJsignJar(cfg: Pick<AgentSigningConfig, "jsignJarPath">): Promise<string | null> {
  const candidates = cfg.jsignJarPath ? [cfg.jsignJarPath] : JSIGN_JAR_CANDIDATES;
  for (const p of candidates) {
    try {
      const st = await stat(p);
      if (st.isFile()) return p;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

export interface SigningAvailability {
  enabled: boolean;
  /** All required config fields present (endpoint/account/profile/tenant/client/secret). */
  configured: boolean;
  javaOk: boolean;
  javaVersion?: string;
  jarPath?: string;
  /** enabled + configured + javaOk + jar found. */
  ok: boolean;
  error?: string;
}

export function isSigningConfigured(cfg: AgentSigningConfig): boolean {
  return Boolean(
    cfg.endpoint && cfg.accountName && cfg.profileName && cfg.tenantId && cfg.clientId && cfg.clientSecret,
  );
}

/**
 * Everything the UI + build path need to know about whether signing can run
 * right now. Like goAvailable(): not cached — operators expect "install Java
 * and reload" to just work, and the probes are cheap.
 */
export async function signingAvailability(cfg?: AgentSigningConfig): Promise<SigningAvailability> {
  const config = cfg ?? (await getSigningConfigRaw());
  const configured = isSigningConfigured(config);

  let javaOk = false;
  let javaVersion: string | undefined;
  try {
    // `java -version` prints to STDERR by long-standing JDK convention.
    const { stderr, stdout } = await execFileAsync("java", ["-version"], { timeout: 5_000 });
    javaOk = true;
    javaVersion = (stderr || stdout).split("\n")[0]?.trim();
  } catch {
    javaOk = false;
  }

  const jarPath = (await resolveJsignJar(config)) ?? undefined;

  let error: string | undefined;
  if (!config.enabled) error = "Code signing is disabled";
  else if (!configured) error = "Signing configuration is incomplete";
  else if (!javaOk) error = "Java runtime not found on PATH (install Java 17+ headless)";
  else if (!jarPath) error = `jsign jar not found (looked at: ${(config.jsignJarPath ? [config.jsignJarPath] : JSIGN_JAR_CANDIDATES).join(", ")})`;

  return {
    enabled: config.enabled,
    configured,
    javaOk,
    javaVersion,
    jarPath,
    ok: config.enabled && configured && javaOk && !!jarPath,
    error,
  };
}

/**
 * jsign argv for one file. The token is deliberately NOT part of the argv —
 * `--storepass env:POLARIS_SIGNING_TOKEN` makes jsign read it from the child
 * env, keeping it out of process listings. No --tsaurl: jsign auto-enables
 * RFC3161 timestamping for TRUSTEDSIGNING. Pure.
 */
export function buildJsignArgs(opts: {
  jarPath: string;
  endpoint: string;
  accountName: string;
  profileName: string;
  filePath: string;
}): string[] {
  return [
    "-jar", opts.jarPath,
    "--storetype", "TRUSTEDSIGNING",
    "--keystore", opts.endpoint,
    "--storepass", `env:${SIGNING_TOKEN_ENV}`,
    "--alias", `${opts.accountName}/${opts.profileName}`,
    opts.filePath,
  ];
}

/** Remove secret material from text destined for step errors / Events / logs. Pure. */
export function scrubSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out;
}

/**
 * Minimal structural view of BuildState so this module doesn't import
 * agentBuildService (which imports us — avoid the cycle). cancelBuild()
 * reaches through `activeChild` to SIGTERM a running jsign exactly like a
 * running `go build`.
 */
export interface SigningProcessSlot {
  cancelled?: boolean;
  activeChild?: ChildProcess;
}

export class SigningCancelledError extends Error {
  constructor() {
    super("Signing cancelled");
    this.name = "SigningCancelledError";
  }
}

/** Sign one PE file in place with jsign. Mirrors runGoBuild's child handling. */
export function signFile(
  slot: SigningProcessSlot,
  opts: { jarPath: string; endpoint: string; accountName: string; profileName: string; token: string; filePath: string },
): Promise<void> {
  const args = buildJsignArgs(opts);
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      "java",
      args,
      {
        timeout: 120_000,
        env: { ...process.env, [SIGNING_TOKEN_ENV]: opts.token },
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        slot.activeChild = undefined;
        if (err) {
          if (slot.cancelled) return reject(new SigningCancelledError());
          const detail = scrubSecrets((stderr || stdout || err.message || "").trim(), [opts.token]);
          return reject(new Error(detail || "jsign exited non-zero"));
        }
        resolve();
      },
    );
    slot.activeChild = child;
  });
}

/**
 * Test-button dry run: availability probe + a REAL token fetch (proves the
 * tenant/client/secret triple and that Entra ID is reachable). Doesn't invoke
 * jsign — there's nothing to sign outside a build.
 */
export async function testSigningSetup(): Promise<{ ok: boolean; message: string }> {
  const cfg = await getSigningConfigRaw();
  if (!isSigningConfigured(cfg)) {
    return { ok: false, message: "Signing configuration is incomplete — fill in every field first" };
  }
  const avail = await signingAvailability(cfg);
  if (!avail.javaOk) return { ok: false, message: "Java runtime not found on PATH (install Java 17+ headless)" };
  if (!avail.jarPath) return { ok: false, message: "jsign jar not found — set the jar path or install it to a default location" };
  try {
    await fetchSigningToken(cfg);
  } catch (err: any) {
    return { ok: false, message: err?.message ?? "Token request failed" };
  }
  return {
    ok: true,
    message: `Ready: token acquired, ${avail.javaVersion ?? "java"} + ${avail.jarPath}. Signing runs on the next agent build.`,
  };
}
