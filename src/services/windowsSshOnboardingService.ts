/**
 * src/services/windowsSshOnboardingService.ts — the "Windows SSH Deployment"
 * workflow behind Integrations → Polaris Agent.
 *
 * WHY THIS EXISTS. Polaris can already install the Polaris Agent on Windows
 * over SSH (agentInstallService.sshWindowsInstall) using an `ssh`-type
 * Credential whose config carries a `privateKey`. Both halves have worked for
 * a while. What was missing is everything AROUND them: the operator had to run
 * ssh-keygen themselves, paste the private half into the credential form, and
 * hand-write a script to push the public half onto every endpoint — with two
 * silent failure modes waiting (wrong authorized_keys file, wrong ACL; see
 * sshOnboardingScript.ts). This service closes that loop: Polaris generates
 * the keypair, owns the credential, and emits the onboarding script.
 *
 * KEY HANDLING mirrors the Web Push VAPID precedent
 * (notificationChannelService.generateVapidKeys): the private half is written
 * straight into Credential.config — where the db.ts Prisma extension seals it
 * at rest under POLARIS_SECRET_KEY — and is NEVER returned by any read path.
 * Only the public half and its fingerprint come back out.
 *
 * The consequence is deliberate and worth stating plainly: there is no escrow.
 * Losing POLARIS_SECRET_KEY (or restoring a backup onto a host with a
 * different one) means regenerating and re-running the onboarding script. That
 * is exactly why the generated script is idempotent — recovery is a re-run,
 * not a fleet rebuild.
 *
 * BLAST RADIUS. One keypair authorizes local-administrator SSH on every
 * Windows endpoint that trusts it. That is not worse than the shared WinRM
 * administrator password it replaces — key auth takes a reusable secret off
 * the wire entirely — but it is a fleet-wide admin credential and the UI says
 * so.
 */

import { createHash } from "node:crypto";
// ssh2 is CommonJS. cjs-module-lexer surfaces `Client` as a named export (which
// is why remoteExec.ts can `import { Client }`) but NOT `utils`, so a named
// import throws at module-load under Node's real ESM loader — even though the
// bundler used by Vitest interops it happily. Reach it off the default export.
import ssh2 from "ssh2";
const sshUtils = ssh2.utils;

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { createSettingStore } from "./settingsStore.js";
import {
  createCredential,
  getCredential,
  validateConfig,
  type CredentialRecord,
} from "./credentialService.js";
import {
  assertValidServerIp,
  assertValidUsername,
  buildWindowsOnboardingScript,
  buildWindowsOnboardingDetectionScript,
  type SshOnboardingAccountMode,
} from "./sshOnboardingScript.js";

/** Setting row holding the card's non-secret configuration. */
const SETTING_KEY = "windowsSshOnboarding";
/** Short TTL: this is an admin-page read, not a hot path. */
const SETTING_TTL_MS = 10_000;

/** Name of the Polaris-owned credential. Visible in the credential list and the install pickers. */
export const MANAGED_CREDENTIAL_NAME = "Windows SSH (Polaris-managed)";
/** Comment baked into the public key so it is identifiable in authorized_keys. */
const KEY_COMMENT = "polaris-agent-deploy";
const DEFAULT_USERNAME = "polaris-agent";

export interface WindowsSshOnboardingConfig {
  /** Credential this card owns. Null until the first generate. */
  credentialId: string | null;
  accountMode: SshOnboardingAccountMode;
  username: string;
  /** IPv4 address or CIDR; "" means the script leaves the firewall alone. */
  polarisServerIp: string;
  /** ISO timestamp of the last keypair generation, for display. */
  generatedAt: string | null;
}

export interface WindowsSshOnboardingState extends WindowsSshOnboardingConfig {
  credentialName: string | null;
  /** authorized_keys one-liner, or null when no keypair exists yet. */
  publicKey: string | null;
  /** "SHA256:..." — the same form `ssh-keygen -lf` prints, so it can be eyeballed. */
  fingerprint: string | null;
}

function parseConfig(raw: unknown): WindowsSshOnboardingConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode = o.accountMode === "create" ? "create" : "existing";
  return {
    credentialId: typeof o.credentialId === "string" && o.credentialId ? o.credentialId : null,
    accountMode: mode,
    username: typeof o.username === "string" && o.username ? o.username : DEFAULT_USERNAME,
    polarisServerIp: typeof o.polarisServerIp === "string" ? o.polarisServerIp : "",
    generatedAt: typeof o.generatedAt === "string" && o.generatedAt ? o.generatedAt : null,
  };
}

const store = createSettingStore<WindowsSshOnboardingConfig>({
  key: SETTING_KEY,
  ttlMs: SETTING_TTL_MS,
  parse: parseConfig,
});

/**
 * OpenSSH-style fingerprint of an authorized_keys line: SHA-256 over the raw
 * key blob, base64, trailing '=' padding stripped. Matches `ssh-keygen -lf`
 * so an operator can compare the two by eye.
 */
export function sshPublicKeyFingerprint(publicKey: string): string | null {
  const parts = String(publicKey ?? "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  try {
    const blob = Buffer.from(parts[1], "base64");
    if (blob.length === 0) return null;
    return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  } catch {
    return null;
  }
}

/**
 * Read the managed credential, tolerating a config that points at a row an
 * admin deleted from the Credentials page. Returns null rather than throwing —
 * the card should render "no keypair yet" and offer Generate, not a 500.
 */
async function loadManagedCredential(
  cfg: WindowsSshOnboardingConfig,
): Promise<CredentialRecord | null> {
  if (!cfg.credentialId) return null;
  try {
    // revealSecrets is NOT set: this path only ever needs the public half.
    return await getCredential(cfg.credentialId);
  } catch {
    return null;
  }
}

export async function getOnboardingState(): Promise<WindowsSshOnboardingState> {
  const cfg = await store.get();
  const cred = await loadManagedCredential(cfg);
  const config = (cred?.config ?? {}) as Record<string, unknown>;
  const publicKey = typeof config.publicKey === "string" && config.publicKey ? config.publicKey : null;
  return {
    ...cfg,
    // A dangling credentialId reads as "not generated yet" so Generate can recover it.
    credentialId: cred ? cfg.credentialId : null,
    credentialName: cred?.name ?? null,
    publicKey,
    fingerprint: publicKey ? sshPublicKeyFingerprint(publicKey) : null,
  };
}

export interface SaveOnboardingConfigInput {
  accountMode?: unknown;
  username?: unknown;
  polarisServerIp?: unknown;
}

export async function saveOnboardingConfig(
  input: SaveOnboardingConfigInput,
  actor: string,
): Promise<WindowsSshOnboardingState> {
  const current = await store.get();

  const accountMode: SshOnboardingAccountMode =
    input.accountMode === undefined
      ? current.accountMode
      : input.accountMode === "create" || input.accountMode === "existing"
        ? input.accountMode
        : (() => {
            throw new AppError(400, 'Account mode must be "create" or "existing"');
          })();

  const rawUsername = input.username === undefined ? current.username : String(input.username ?? "");
  // Validated against the SAME rules the script generator enforces, so a bad
  // value is rejected at save time rather than at download time.
  const username = assertValidUsername(rawUsername, accountMode);
  const polarisServerIp = assertValidServerIp(
    input.polarisServerIp === undefined ? current.polarisServerIp : String(input.polarisServerIp ?? ""),
  );

  const next: WindowsSshOnboardingConfig = { ...current, accountMode, username, polarisServerIp };
  const changed =
    next.accountMode !== current.accountMode ||
    next.username !== current.username ||
    next.polarisServerIp !== current.polarisServerIp;

  if (changed) {
    await store.save(next);
    await logEvent({
      action: "windows_ssh_onboarding.updated",
      resourceType: "setting",
      resourceName: SETTING_KEY,
      actor,
      message: `Updated Windows SSH deployment settings (account ${accountMode}: ${username})`,
      details: { accountMode, username, polarisServerIp: polarisServerIp || null },
    });
  }
  return getOnboardingState();
}

/**
 * Generate (or rotate) the deployment keypair and store it on the managed
 * credential, creating that credential on first use.
 *
 * Note the ordering: the key is generated BEFORE createCredential, not after.
 * validateSshConfig requires a password or a private key, so there is no way
 * to create an empty ssh credential and key it afterwards.
 */
export async function generateKeypair(actor: string): Promise<WindowsSshOnboardingState> {
  const cfg = await store.get();

  // ed25519: small, fast, and supported by both ssh2 and Windows OpenSSH.
  // generateKeyPairSync emits the OpenSSH private-key format ssh2.connect
  // accepts directly — no conversion, no shelling out to ssh-keygen.
  const pair = sshUtils.generateKeyPairSync("ed25519", { comment: KEY_COMMENT });
  const privateKey = String(pair.private);
  const publicKey = String(pair.public).trim();

  // Fail before touching the DB if the toolchain ever returns something the
  // connect path can't use — better a clean 500 here than a credential that
  // silently never authenticates.
  const parsed = sshUtils.parseKey(privateKey);
  if (parsed instanceof Error) {
    throw new AppError(500, `Generated SSH key failed to parse: ${parsed.message}`);
  }

  const existing = await loadManagedCredential(cfg);
  const rotating = Boolean(existing);
  let credentialId: string;

  if (existing) {
    // REPLACE the config rather than merging it. updateCredential() routes
    // through mergeConfigPreservingSecrets, which treats an empty string for a
    // secret field as "keep what's stored" — that's what lets the edit modal
    // round-trip a masked value without wiping it, but it also makes clearing
    // `password` impossible through that path. A stale password on a
    // Polaris-managed key credential is dead config that still reads as a live
    // secret in the UI, and remoteExec silently prefers privateKey anyway.
    //
    // So: validate explicitly, then write the whole config. Same shape as the
    // VAPID precedent in notificationChannelService.generateVapidKeys.
    const nextConfig = { username: cfg.username, privateKey, publicKey, port: 22 };
    validateConfig("ssh", nextConfig);
    await prisma.credential.update({
      where: { id: existing.id },
      data: { config: nextConfig as never },
    });
    credentialId = existing.id;
  } else {
    const created = await createCredential({
      name: await uniqueCredentialName(),
      type: "ssh",
      config: { username: cfg.username, privateKey, publicKey, port: 22 },
    });
    credentialId = created.id;
  }

  await store.save({ ...cfg, credentialId, generatedAt: new Date().toISOString() });

  // Warning level on purpose: rotating invalidates every endpoint that trusts
  // the old key until the onboarding script re-runs across the fleet.
  await logEvent({
    action: "credential.ssh_keypair_generated",
    resourceType: "credential",
    resourceId: credentialId,
    resourceName: existing?.name ?? MANAGED_CREDENTIAL_NAME,
    actor,
    level: "warning",
    message: rotating
      ? "Regenerated the Windows SSH deployment keypair — every endpoint must re-run the onboarding script before Polaris can reach it again"
      : "Generated the Windows SSH deployment keypair",
    details: { rotated: rotating, fingerprint: sshPublicKeyFingerprint(publicKey) },
  });

  return getOnboardingState();
}

/**
 * Credential names are unique. If an operator already has a credential by the
 * managed name (hand-made, or left behind by an earlier config row that was
 * cleared), suffix rather than 409 the whole generate.
 */
async function uniqueCredentialName(): Promise<string> {
  const taken = await prisma.credential.findMany({
    where: { name: { startsWith: MANAGED_CREDENTIAL_NAME } },
    select: { name: true },
  });
  const names = new Set(taken.map((r) => r.name));
  if (!names.has(MANAGED_CREDENTIAL_NAME)) return MANAGED_CREDENTIAL_NAME;
  for (let i = 2; i < 100; i++) {
    const candidate = `${MANAGED_CREDENTIAL_NAME} ${i}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new AppError(409, "Could not allocate a name for the managed SSH credential");
}

export type OnboardingScriptKind = "remediation" | "detection";

export interface OnboardingScriptResult {
  script: string;
  filename: string;
  kind: OnboardingScriptKind;
}

export async function getOnboardingScript(kind: OnboardingScriptKind): Promise<OnboardingScriptResult> {
  const state = await getOnboardingState();
  if (!state.publicKey) {
    throw new AppError(400, "Generate the deployment keypair before downloading the onboarding script");
  }
  if (kind === "detection") {
    return {
      kind,
      filename: "polaris-ssh-onboarding-detect.ps1",
      script: buildWindowsOnboardingDetectionScript({ publicKey: state.publicKey }),
    };
  }
  return {
    kind: "remediation",
    filename: "polaris-ssh-onboarding.ps1",
    script: buildWindowsOnboardingScript({
      publicKey: state.publicKey,
      username: state.username,
      accountMode: state.accountMode,
      polarisServerIp: state.polarisServerIp || undefined,
    }),
  };
}

/** Test seam — drop the TTL cache between cases. */
export function _invalidateCache(): void {
  store.invalidate();
}
