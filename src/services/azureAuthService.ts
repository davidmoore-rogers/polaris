/**
 * src/services/azureAuthService.ts — Azure AD SSO via SAML 2.0
 *
 * IdP configuration (Entity ID, Login/Logout URLs, Certificate) is stored
 * in the Setting table (key "sso") and managed through the Users page
 * Settings modal.
 */

import { SAML, type SamlConfig, type Profile, ValidateInResponseTo } from "@node-saml/node-saml";
import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import bcrypt from "bcrypt";

// ─── SSO Settings (stored in Setting table) ─────────────────────────────────

export interface SsoSettings {
  enabled: boolean;
  spEntityId: string;
  idpEntityId: string;
  idpLoginUrl: string;
  idpLogoutUrl: string;
  idpCertificate: string;
  wantResponseSigned: boolean;
  skipLoginPage: boolean;
  autoLogoutMinutes: number;
}

const SSO_DEFAULTS: SsoSettings = {
  enabled: false,
  spEntityId: "",
  idpEntityId: "",
  idpLoginUrl: "",
  idpLogoutUrl: "",
  idpCertificate: "",
  wantResponseSigned: false,
  skipLoginPage: false,
  autoLogoutMinutes: 0,
};

// Simple in-memory cache to avoid DB reads on every request
let _ssoCache: { value: SsoSettings; expiry: number } | null = null;

export async function getSsoSettings(): Promise<SsoSettings> {
  if (_ssoCache && Date.now() < _ssoCache.expiry) return _ssoCache.value;
  const row = await prisma.setting.findUnique({ where: { key: "sso" } });
  const value = row?.value
    ? { ...SSO_DEFAULTS, ...(row.value as Record<string, any>) }
    : { ...SSO_DEFAULTS };
  _ssoCache = { value, expiry: Date.now() + 30000 };
  return value;
}

export async function updateSsoSettings(updates: Partial<SsoSettings>): Promise<SsoSettings> {
  const current = await getSsoSettings();
  const merged: SsoSettings = {
    enabled: updates.enabled !== undefined ? updates.enabled : current.enabled,
    spEntityId: updates.spEntityId !== undefined ? updates.spEntityId.trim() : current.spEntityId,
    idpEntityId: updates.idpEntityId !== undefined ? updates.idpEntityId.trim() : current.idpEntityId,
    idpLoginUrl: updates.idpLoginUrl !== undefined ? updates.idpLoginUrl.trim() : current.idpLoginUrl,
    idpLogoutUrl: updates.idpLogoutUrl !== undefined ? updates.idpLogoutUrl.trim() : current.idpLogoutUrl,
    idpCertificate: updates.idpCertificate !== undefined ? updates.idpCertificate.trim() : current.idpCertificate,
    wantResponseSigned: updates.wantResponseSigned !== undefined ? updates.wantResponseSigned : current.wantResponseSigned,
    skipLoginPage: updates.skipLoginPage !== undefined ? updates.skipLoginPage : current.skipLoginPage,
    autoLogoutMinutes:
      updates.autoLogoutMinutes !== undefined
        ? Math.max(0, Math.min(1440, updates.autoLogoutMinutes))
        : current.autoLogoutMinutes,
  };
  await prisma.setting.upsert({
    where: { key: "sso" },
    update: { value: merged as any },
    create: { key: "sso", value: merged as any },
  });
  _ssoCache = { value: merged, expiry: Date.now() + 30000 };

  // Invalidate cached SAML client so it gets rebuilt with new config
  _samlClient = null;

  return merged;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export function isAzureSsoConfigured(): boolean {
  if (_ssoCache && Date.now() < _ssoCache.expiry) {
    const s = _ssoCache.value;
    return !!(s.enabled && s.idpEntityId && s.idpLoginUrl && s.idpCertificate);
  }
  return false;
}

export async function isAzureSsoConfiguredAsync(): Promise<boolean> {
  const s = await getSsoSettings();
  return !!(s.enabled && s.idpEntityId && s.idpLoginUrl && s.idpCertificate);
}

// ─── SAML Client ─────────────────────────────────────────────────────────────

let _samlClient: SAML | null = null;

async function getSamlClient(): Promise<SAML> {
  if (_samlClient) return _samlClient;

  const settings = await getSsoSettings();
  if (!settings.idpEntityId || !settings.idpLoginUrl || !settings.idpCertificate) {
    throw new Error("SAML SSO is not configured");
  }
  if (!settings.spEntityId) {
    throw new Error("SAML SSO requires an Application URL — set it in Authentication Settings");
  }

  const baseUrl = settings.spEntityId.replace(/\/+$/, "");
  const config: SamlConfig = {
    idpCert: settings.idpCertificate,
    issuer: baseUrl,
    callbackUrl: `${baseUrl}/api/v1/auth/azure/callback`,
    entryPoint: settings.idpLoginUrl,
    logoutUrl: settings.idpLogoutUrl || settings.idpLoginUrl,
    idpIssuer: settings.idpEntityId,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: settings.wantResponseSigned,
    disableRequestedAuthnContext: true,
    validateInResponseTo: ValidateInResponseTo.never,
  };

  _samlClient = new SAML(config);
  return _samlClient;
}

// ─── SAML Auth Flow ──────────────────────────────────────────────────────────

export function generateRelayState(): string {
  return randomBytes(24).toString("hex");
}

export async function getSamlLoginUrl(relayState: string): Promise<string> {
  const client = await getSamlClient();
  return client.getAuthorizeUrlAsync(relayState, undefined, {});
}

export async function validateSamlResponse(body: Record<string, string>): Promise<Profile> {
  const client = await getSamlClient();
  const { profile } = await client.validatePostResponseAsync(body);
  if (!profile) throw new Error("SAML assertion validation failed — no profile returned");
  return profile;
}

export async function getSamlLogoutUrl(nameID: string, sessionIndex: string, relayState: string): Promise<string> {
  const client = await getSamlClient();
  const user: Profile = {
    issuer: "",
    nameID,
    nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    sessionIndex,
  };
  return client.getLogoutUrlAsync(user, relayState, {});
}

// ─── User Provisioning ───────────────────────────────────────────────────────

export async function findOrProvisionSamlUser(profile: Profile) {
  // SAML profile attributes — Azure AD typically sends these
  const nameID: string = profile.nameID || "";
  const email: string =
    (profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] as string) ||
    (profile.email as string) ||
    (profile.mail as string) ||
    nameID;
  const displayName: string =
    (profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] as string) ||
    (profile["http://schemas.microsoft.com/identity/claims/displayname"] as string) ||
    (profile.displayName as string) ||
    "";
  const oid: string =
    (profile["http://schemas.microsoft.com/identity/claims/objectidentifier"] as string) ||
    (profile.nameID as string) ||
    "";

  if (!oid) throw new Error("SAML assertion missing user identifier");

  // Look up by Azure OID
  const existing = await prisma.user.findUnique({ where: { azureOid: oid } });
  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        displayName: displayName || existing.displayName,
        email: email || existing.email,
        lastLogin: new Date(),
      },
    });
  }

  // Derive a username from the email
  let username = email.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!username) username = `azure-${oid.slice(0, 8)}`;

  // Handle username collision
  const collision = await prisma.user.findUnique({ where: { username } });
  if (collision) {
    username = `${username}-azure`;
    const collision2 = await prisma.user.findUnique({ where: { username } });
    if (collision2) username = `azure-${oid.slice(0, 12)}`;
  }

  // Create with a random password hash (SAML users never use it)
  const placeholderHash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);

  return prisma.user.create({
    data: {
      username,
      passwordHash: placeholderHash,
      role: "readonly",
      authProvider: "azure",
      azureOid: oid,
      displayName: displayName || null,
      email: email || null,
      lastLogin: new Date(),
    },
  });
}
