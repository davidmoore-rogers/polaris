/**
 * src/services/credentialService.ts
 *
 * Named credential store for monitoring probes (SNMP v2c/v3, WinRM, SSH,
 * REST API). Mirrors the Integration model: plaintext at rest, masked at
 * the API boundary via `stripSecrets()`. ICMP doesn't use credentials so
 * there's no "icmp" type here.
 *
 * "restapi" credentials carry a baseUrl + bearer token pair so manually-
 * created assets can be probed via the same REST-API path FMG/FortiGate-
 * discovered firewalls use through their integration's stored token.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

export type CredentialType = "snmp" | "winrm" | "ssh" | "restapi";

export interface SnmpV2cConfig {
  version: "v2c";
  community: string;
  port?: number;
}

export type SnmpV3AuthProtocol = "MD5" | "SHA" | "SHA224" | "SHA256" | "SHA384" | "SHA512";
export type SnmpV3PrivProtocol = "DES" | "AES" | "AES256B" | "AES256R";

export const SNMP_V3_AUTH_PROTOCOLS: readonly SnmpV3AuthProtocol[] = [
  "MD5", "SHA", "SHA224", "SHA256", "SHA384", "SHA512",
];
export const SNMP_V3_PRIV_PROTOCOLS: readonly SnmpV3PrivProtocol[] = [
  "DES", "AES", "AES256B", "AES256R",
];

export interface SnmpV3Config {
  version: "v3";
  username: string;
  securityLevel: "noAuthNoPriv" | "authNoPriv" | "authPriv";
  authProtocol?: SnmpV3AuthProtocol;
  authKey?: string;
  privProtocol?: SnmpV3PrivProtocol;
  privKey?: string;
  port?: number;
}

export type SnmpConfig = SnmpV2cConfig | SnmpV3Config;

export interface WinRmConfig {
  username: string;
  password: string;
  port?: number;
  useHttps?: boolean;
}

export interface SshConfig {
  username: string;
  password?: string;
  privateKey?: string;
  port?: number;
}

/**
 * REST API credential — a base URL + bearer token. Used by the REST API
 * polling method when the asset's source doesn't already have a token
 * (i.e. manually-created assets, or any asset where the operator wants
 * to override with a different token). FMG/FortiGate-discovered firewalls
 * keep using the integration's stored token by default.
 *
 * verifyTls defaults to false (parity with FortiOS REST behaviour where
 * self-signed device certs are common); operators flip it on when their
 * target presents a real cert.
 */
export interface RestApiConfig {
  baseUrl: string;
  apiToken: string;
  verifyTls?: boolean;
}

export type CredentialConfig = SnmpConfig | WinRmConfig | SshConfig | RestApiConfig;

export interface CredentialRecord {
  id: string;
  name: string;
  type: CredentialType;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveCredentialInput {
  name: string;
  type: CredentialType;
  config: Record<string, unknown>;
}

export interface UpdateCredentialInput {
  name?: string;
  config?: Record<string, unknown>;
}

const MASK = "••••••••";

/**
 * Field names treated as secrets. Returned masked on every GET and
 * preserved from the stored value on PUT when the caller resubmits the
 * mask (or an empty string).
 */
const SECRET_FIELDS_BY_TYPE: Record<CredentialType, string[]> = {
  snmp:    ["community", "authKey", "privKey"],
  winrm:   ["password"],
  ssh:     ["password", "privateKey"],
  restapi: ["apiToken"],
};

function secretFieldsFor(type: string): string[] {
  return SECRET_FIELDS_BY_TYPE[type as CredentialType] ?? [];
}

export function stripSecrets(cred: CredentialRecord): CredentialRecord {
  const config = { ...(cred.config || {}) } as Record<string, unknown>;
  for (const field of secretFieldsFor(cred.type)) {
    const v = config[field];
    if (typeof v === "string" && v.length > 0) {
      config[field] = MASK;
    }
  }
  return { ...cred, config };
}

function isMaskedValue(v: unknown): boolean {
  return typeof v === "string" && (v === MASK || v.trim() === "");
}

function normalizeName(name: string): string {
  return name.trim();
}

function validateSnmpConfig(config: Record<string, unknown>): void {
  const version = config.version;
  if (version !== "v2c" && version !== "v3") {
    throw new AppError(400, "SNMP config requires version 'v2c' or 'v3'");
  }
  if (version === "v2c") {
    if (typeof config.community !== "string" || !config.community) {
      throw new AppError(400, "SNMP v2c requires a community string");
    }
  } else {
    if (typeof config.username !== "string" || !config.username) {
      throw new AppError(400, "SNMP v3 requires a username");
    }
    const level = config.securityLevel;
    if (level !== "noAuthNoPriv" && level !== "authNoPriv" && level !== "authPriv") {
      throw new AppError(400, "SNMP v3 requires securityLevel noAuthNoPriv, authNoPriv, or authPriv");
    }
    if (level === "authNoPriv" || level === "authPriv") {
      if (!SNMP_V3_AUTH_PROTOCOLS.includes(config.authProtocol as SnmpV3AuthProtocol)) {
        throw new AppError(
          400,
          `SNMP v3 authProtocol must be one of ${SNMP_V3_AUTH_PROTOCOLS.join(", ")} when auth is enabled`,
        );
      }
      if (typeof config.authKey !== "string" || !config.authKey) {
        throw new AppError(400, "SNMP v3 authKey is required when auth is enabled");
      }
    }
    if (level === "authPriv") {
      if (!SNMP_V3_PRIV_PROTOCOLS.includes(config.privProtocol as SnmpV3PrivProtocol)) {
        throw new AppError(
          400,
          `SNMP v3 privProtocol must be one of ${SNMP_V3_PRIV_PROTOCOLS.join(", ")} when authPriv is selected`,
        );
      }
      if (typeof config.privKey !== "string" || !config.privKey) {
        throw new AppError(400, "SNMP v3 privKey is required when authPriv is selected");
      }
    }
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "SNMP port must be between 1 and 65535");
    }
  }
}

function validateWinRmConfig(config: Record<string, unknown>): void {
  if (typeof config.username !== "string" || !config.username) {
    throw new AppError(400, "WinRM requires a username");
  }
  if (typeof config.password !== "string" || !config.password) {
    throw new AppError(400, "WinRM requires a password");
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "WinRM port must be between 1 and 65535");
    }
  }
}

function validateSshConfig(config: Record<string, unknown>): void {
  if (typeof config.username !== "string" || !config.username) {
    throw new AppError(400, "SSH requires a username");
  }
  const hasPassword = typeof config.password === "string" && config.password.length > 0;
  const hasKey      = typeof config.privateKey === "string" && config.privateKey.length > 0;
  if (!hasPassword && !hasKey) {
    throw new AppError(400, "SSH requires either a password or a private key");
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "SSH port must be between 1 and 65535");
    }
  }
}

function validateRestApiConfig(config: Record<string, unknown>): void {
  if (typeof config.baseUrl !== "string" || !config.baseUrl) {
    throw new AppError(400, "REST API credential requires a baseUrl");
  }
  // Defensive URL parse — operators may paste a hostname with no scheme,
  // a trailing path, or even a stray newline. We require an http(s) scheme
  // because the polling code can't talk anything else, and we trim trailing
  // slashes so the probe path concatenation doesn't double up. The trim
  // happens at validation time so the stored value is canonical.
  let u: URL;
  try { u = new URL(config.baseUrl.trim()); }
  catch { throw new AppError(400, "REST API baseUrl must be a valid URL (e.g. https://device.example/)"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new AppError(400, "REST API baseUrl must use http:// or https://");
  }
  config.baseUrl = u.toString().replace(/\/+$/, "");
  if (typeof config.apiToken !== "string" || !config.apiToken) {
    throw new AppError(400, "REST API credential requires an apiToken");
  }
  if (config.verifyTls !== undefined && typeof config.verifyTls !== "boolean") {
    throw new AppError(400, "REST API verifyTls must be a boolean");
  }
}

export function validateConfig(type: CredentialType, config: Record<string, unknown>): void {
  if (type === "snmp")    return validateSnmpConfig(config);
  if (type === "winrm")   return validateWinRmConfig(config);
  if (type === "ssh")     return validateSshConfig(config);
  if (type === "restapi") return validateRestApiConfig(config);
  throw new AppError(400, `Unknown credential type "${type}"`);
}

/**
 * Merge incoming config onto the stored one, preserving any secret field
 * whose incoming value is either the mask sentinel or empty. Lets the
 * edit modal round-trip a masked value without wiping the real secret.
 */
export function mergeConfigPreservingSecrets(
  type: CredentialType,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, ...incoming };
  for (const field of secretFieldsFor(type)) {
    if (isMaskedValue(incoming[field])) {
      merged[field] = existing[field];
    }
  }
  return merged;
}

async function findByName(name: string, excludeId?: string): Promise<CredentialRecord | null> {
  const found = await prisma.credential.findUnique({ where: { name } });
  if (!found) return null;
  if (excludeId && found.id === excludeId) return null;
  return found as unknown as CredentialRecord;
}

export async function listCredentials(): Promise<CredentialRecord[]> {
  const rows = await prisma.credential.findMany({ orderBy: { name: "asc" } });
  return (rows as unknown as CredentialRecord[]).map(stripSecrets);
}

export async function getCredential(id: string, opts?: { revealSecrets?: boolean }): Promise<CredentialRecord> {
  const row = await prisma.credential.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Credential not found");
  const cred = row as unknown as CredentialRecord;
  return opts?.revealSecrets ? cred : stripSecrets(cred);
}

export async function createCredential(input: SaveCredentialInput): Promise<CredentialRecord> {
  const name = normalizeName(input.name);
  if (!name) throw new AppError(400, "Credential name is required");
  if (input.type !== "snmp" && input.type !== "winrm" && input.type !== "ssh" && input.type !== "restapi") {
    throw new AppError(400, "Credential type must be snmp, winrm, ssh, or restapi");
  }
  if (!input.config || typeof input.config !== "object") {
    throw new AppError(400, "Credential config is required");
  }
  validateConfig(input.type, input.config);
  if (await findByName(name)) {
    throw new AppError(409, `A credential named "${name}" already exists`);
  }
  const created = await prisma.credential.create({
    data: { name, type: input.type, config: input.config as any },
  });
  return stripSecrets(created as unknown as CredentialRecord);
}

export async function updateCredential(id: string, input: UpdateCredentialInput): Promise<CredentialRecord> {
  const existing = await prisma.credential.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Credential not found");

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (!name) throw new AppError(400, "Credential name cannot be empty");
    if (await findByName(name, id)) {
      throw new AppError(409, `A credential named "${name}" already exists`);
    }
    data.name = name;
  }
  if (input.config) {
    const merged = mergeConfigPreservingSecrets(
      existing.type as CredentialType,
      (existing.config as Record<string, unknown>) || {},
      input.config,
    );
    validateConfig(existing.type as CredentialType, merged);
    data.config = merged;
  }
  const updated = await prisma.credential.update({ where: { id }, data });
  return stripSecrets(updated as unknown as CredentialRecord);
}

export async function deleteCredential(id: string): Promise<void> {
  const inUse = await prisma.asset.count({ where: { monitorCredentialId: id } });
  if (inUse > 0) {
    throw new AppError(
      409,
      `Credential is in use by ${inUse} asset${inUse === 1 ? "" : "s"}; clear monitoring there first`,
    );
  }
  try {
    await prisma.credential.delete({ where: { id } });
  } catch (err: any) {
    if (err?.code === "P2025") throw new AppError(404, "Credential not found");
    throw err;
  }
}
