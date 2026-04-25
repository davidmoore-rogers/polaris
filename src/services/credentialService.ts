/**
 * src/services/credentialService.ts
 *
 * Named credential store for monitoring probes (SNMP v2c/v3, WinRM, SSH).
 * Mirrors the Integration model: plaintext at rest, masked at the API
 * boundary via `stripSecrets()`. ICMP doesn't use credentials so there's
 * no "icmp" type here.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

export type CredentialType = "snmp" | "winrm" | "ssh";

export interface SnmpV2cConfig {
  version: "v2c";
  community: string;
  port?: number;
}

export interface SnmpV3Config {
  version: "v3";
  username: string;
  securityLevel: "noAuthNoPriv" | "authNoPriv" | "authPriv";
  authProtocol?: "MD5" | "SHA";
  authKey?: string;
  privProtocol?: "DES" | "AES";
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

export type CredentialConfig = SnmpConfig | WinRmConfig | SshConfig;

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
  snmp:  ["community", "authKey", "privKey"],
  winrm: ["password"],
  ssh:   ["password", "privateKey"],
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
      if (config.authProtocol !== "MD5" && config.authProtocol !== "SHA") {
        throw new AppError(400, "SNMP v3 authProtocol must be MD5 or SHA when auth is enabled");
      }
      if (typeof config.authKey !== "string" || !config.authKey) {
        throw new AppError(400, "SNMP v3 authKey is required when auth is enabled");
      }
    }
    if (level === "authPriv") {
      if (config.privProtocol !== "DES" && config.privProtocol !== "AES") {
        throw new AppError(400, "SNMP v3 privProtocol must be DES or AES when authPriv is selected");
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

function validateConfig(type: CredentialType, config: Record<string, unknown>): void {
  if (type === "snmp")  return validateSnmpConfig(config);
  if (type === "winrm") return validateWinRmConfig(config);
  if (type === "ssh")   return validateSshConfig(config);
  throw new AppError(400, `Unknown credential type "${type}"`);
}

/**
 * Merge incoming config onto the stored one, preserving any secret field
 * whose incoming value is either the mask sentinel or empty. Lets the
 * edit modal round-trip a masked value without wiping the real secret.
 */
function mergeConfigPreservingSecrets(
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
  if (input.type !== "snmp" && input.type !== "winrm" && input.type !== "ssh") {
    throw new AppError(400, "Credential type must be snmp, winrm, or ssh");
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
