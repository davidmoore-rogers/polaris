/**
 * src/services/notificationConfigService.ts
 *
 * Stored configuration for the outbound notification channels — SMTP email,
 * Microsoft 365 (Graph) email, and Web Push (VAPID). Each lives in a `Setting`
 * row. Secrets (SMTP password, M365 client secret, VAPID private key) are:
 *   - masked on read for the API (getMasked*),
 *   - preserved on write when the client sends back the mask (save*),
 *   - overridable by env var (the org pattern — secrets in env/Key Vault win
 *     over the stored value at send time).
 *
 * Channels call the raw getXConfig() (env-merged, secrets intact); the
 * Server Settings → Notifications routes call the getMaskedX / saveX pair.
 */

import { prisma } from "../db.js";

export const SMTP_SETTING_KEY = "notificationSmtp";
export const M365_SETTING_KEY = "notificationM365";
export const WEBPUSH_SETTING_KEY = "notificationWebPush";

export const MASK = "••••••••";

export type SmtpSecurity = "none" | "starttls" | "ssl";

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  from: string;
}

export interface M365Config {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fromUserId: string;
}

export interface WebPushConfig {
  enabled: boolean;
  publicKey: string;
  privateKey: string;
  subject: string; // mailto: or https: contact, per the VAPID spec
}

const SMTP_DEFAULT: SmtpConfig = { enabled: false, host: "", port: 587, security: "starttls", username: "", password: "", from: "" };
const M365_DEFAULT: M365Config = { enabled: false, tenantId: "", clientId: "", clientSecret: "", fromUserId: "" };
const WEBPUSH_DEFAULT: WebPushConfig = { enabled: false, publicKey: "", privateKey: "", subject: "" };

function isMaskOrEmpty(v: unknown): boolean {
  return typeof v !== "string" || v === MASK || v.trim() === "";
}

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row || row.value == null || typeof row.value !== "object") return { ...fallback };
  return { ...fallback, ...(row.value as object) } as T;
}

async function writeSetting(key: string, value: object): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as any },
    update: { value: value as any },
  });
}

// ─── SMTP ───────────────────────────────────────────────────────────────────
export async function getSmtpConfig(): Promise<SmtpConfig> {
  const cfg = await readSetting(SMTP_SETTING_KEY, SMTP_DEFAULT);
  const envPw = process.env.POLARIS_SMTP_PASSWORD;
  if (envPw) cfg.password = envPw;
  return cfg;
}

export async function getMaskedSmtpConfig(): Promise<SmtpConfig & { passwordSet: boolean }> {
  const cfg = await readSetting(SMTP_SETTING_KEY, SMTP_DEFAULT);
  const passwordSet = !!cfg.password || !!process.env.POLARIS_SMTP_PASSWORD;
  return { ...cfg, password: passwordSet ? MASK : "", passwordSet };
}

export async function saveSmtpConfig(input: Partial<SmtpConfig>): Promise<void> {
  const current = await readSetting(SMTP_SETTING_KEY, SMTP_DEFAULT);
  const password = isMaskOrEmpty(input.password) ? current.password : String(input.password);
  await writeSetting(SMTP_SETTING_KEY, {
    enabled: !!input.enabled,
    host: (input.host ?? current.host).trim(),
    port: Number(input.port ?? current.port) || 587,
    security: (input.security ?? current.security) as SmtpSecurity,
    username: (input.username ?? current.username).trim(),
    password,
    from: (input.from ?? current.from).trim(),
  });
}

// ─── Microsoft 365 ────────────────────────────────────────────────────────────
export async function getM365Config(): Promise<M365Config> {
  const cfg = await readSetting(M365_SETTING_KEY, M365_DEFAULT);
  const envSecret = process.env.POLARIS_M365_CLIENT_SECRET;
  if (envSecret) cfg.clientSecret = envSecret;
  return cfg;
}

export async function getMaskedM365Config(): Promise<M365Config & { clientSecretSet: boolean }> {
  const cfg = await readSetting(M365_SETTING_KEY, M365_DEFAULT);
  const clientSecretSet = !!cfg.clientSecret || !!process.env.POLARIS_M365_CLIENT_SECRET;
  return { ...cfg, clientSecret: clientSecretSet ? MASK : "", clientSecretSet };
}

export async function saveM365Config(input: Partial<M365Config>): Promise<void> {
  const current = await readSetting(M365_SETTING_KEY, M365_DEFAULT);
  const clientSecret = isMaskOrEmpty(input.clientSecret) ? current.clientSecret : String(input.clientSecret);
  await writeSetting(M365_SETTING_KEY, {
    enabled: !!input.enabled,
    tenantId: (input.tenantId ?? current.tenantId).trim(),
    clientId: (input.clientId ?? current.clientId).trim(),
    clientSecret,
    fromUserId: (input.fromUserId ?? current.fromUserId).trim(),
  });
}

// ─── Web Push (VAPID) ─────────────────────────────────────────────────────────
export async function getWebPushConfig(): Promise<WebPushConfig> {
  const cfg = await readSetting(WEBPUSH_SETTING_KEY, WEBPUSH_DEFAULT);
  if (process.env.POLARIS_VAPID_PUBLIC_KEY) cfg.publicKey = process.env.POLARIS_VAPID_PUBLIC_KEY;
  if (process.env.POLARIS_VAPID_PRIVATE_KEY) cfg.privateKey = process.env.POLARIS_VAPID_PRIVATE_KEY;
  if (process.env.POLARIS_VAPID_SUBJECT) cfg.subject = process.env.POLARIS_VAPID_SUBJECT;
  return cfg;
}

export async function getMaskedWebPushConfig(): Promise<Omit<WebPushConfig, "privateKey"> & { privateKeySet: boolean }> {
  const cfg = await getWebPushConfig();
  const { privateKey, ...rest } = cfg;
  return { ...rest, privateKeySet: !!privateKey };
}

export async function saveWebPushConfig(input: Partial<WebPushConfig>): Promise<void> {
  const current = await readSetting(WEBPUSH_SETTING_KEY, WEBPUSH_DEFAULT);
  await writeSetting(WEBPUSH_SETTING_KEY, {
    enabled: !!input.enabled,
    publicKey: (input.publicKey ?? current.publicKey).trim(),
    privateKey: isMaskOrEmpty(input.privateKey) ? current.privateKey : String(input.privateKey),
    subject: (input.subject ?? current.subject).trim(),
  });
}

/** Whether at least one email channel is configured + enabled. */
export async function anyEmailChannelEnabled(): Promise<boolean> {
  const [smtp, m365] = await Promise.all([getSmtpConfig(), getM365Config()]);
  return (smtp.enabled && !!smtp.host) || (m365.enabled && !!m365.tenantId);
}
