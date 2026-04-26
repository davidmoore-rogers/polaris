/**
 * src/api/routes/auth.ts — Login / Logout / Session check / Azure SAML SSO
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import { isLocked, recordFailure, clearLockout } from "../../utils/loginLockout.js";
import * as mfaPending from "../../utils/mfaPending.js";
import {
  verifyCode as verifyTotpCode,
  consumeBackupCode,
  generateSecret as generateTotpSecret,
  generateBackupCodes,
  buildEnrollment,
} from "../../services/totpService.js";
import { AppError } from "../../utils/errors.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  isAzureSsoConfiguredAsync,
  generateRelayState,
  getSamlLoginUrl,
  validateSamlResponse,
  getSamlLogoutUrl,
  findOrProvisionSamlUser,
  getSsoSettings,
  updateSsoSettings,
} from "../../services/azureAuthService.js";
import { logEvent } from "./events.js";

const router = Router();

// Rotate the session ID on login to prevent fixation: if an attacker planted
// a session ID on the client pre-auth, the post-auth identity binds to a new
// ID the attacker doesn't know.
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

const LoginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

// POST /api/v1/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = LoginSchema.parse(req.body);

    // Per-username lockout check — runs before the DB lookup so a locked
    // account short-circuits without the caller learning anything else.
    const lock = isLocked(username);
    if (lock.locked) {
      logEvent({
        action: "auth.login.locked",
        resourceType: "user",
        resourceName: username,
        level: "warning",
        message: `Login attempt on locked account "${username}"`,
        details: { ip: req.ip, lockedUntil: lock.until?.toISOString() },
      });
      throw new AppError(
        423,
        `Account temporarily locked due to too many failed attempts. Try again after ${lock.until?.toLocaleTimeString() ?? "later"}.`,
      );
    }

    const user = await prisma.user.findUnique({ where: { username } });

    // Constant-time verify: passing null stored hash still runs a dummy
    // argon2 verify so response time is identical for unknown usernames.
    const { valid, needsRehash } = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !valid) {
      const tripped = recordFailure(username);
      if (tripped.lockedNow) {
        logEvent({
          action: "auth.login.lockout",
          resourceType: "user",
          resourceName: username,
          level: "warning",
          message: `Account "${username}" locked after ${tripped.failures} failed attempts`,
          details: { ip: req.ip, lockedUntil: tripped.until?.toISOString() },
        });
      }
      logEvent({
        action: "auth.login.failed",
        resourceType: "user",
        resourceName: username,
        level: "warning",
        message: `Failed local login for "${username}"`,
        details: {
          ip: req.ip,
          userAgent: req.get("user-agent") || undefined,
          failures: tripped.failures,
        },
      });
      throw new AppError(401, "Invalid username or password");
    }

    // Good password — clear the failure counter now; if TOTP fails later,
    // recordFailure() on the /login/totp path will start the counter fresh.
    clearLockout(username);

    // Re-hash on successful login if stored params are weaker than current target.
    const updateData: { lastLogin: Date; passwordHash?: string } = { lastLogin: new Date() };
    if (needsRehash) {
      updateData.passwordHash = await hashPassword(password);
    }
    await prisma.user.update({ where: { id: user.id }, data: updateData });

    // If TOTP is enabled on this (local) account, don't issue the session
    // yet — hand the caller an opaque pending-MFA token instead and wait
    // for the second-step /login/totp call.
    if (user.authProvider === "local" && user.totpEnabledAt) {
      const pendingToken = mfaPending.issue(user.id, user.username);
      logEvent({
        action: "auth.login.password_ok",
        resourceType: "user",
        resourceId: user.id,
        resourceName: user.username,
        actor: user.username,
        message: `Password accepted for ${user.username}; awaiting TOTP`,
        details: { ip: req.ip },
      });
      return res.json({ mfaRequired: true, pendingToken });
    }

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.authProvider = user.authProvider || "local";
    req.session.mfaVerified = false;
    req.session.lastActivity = Date.now();

    logEvent({
      action: "auth.login.local",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `Local login: ${user.username}`,
      details: { ip: req.ip, userAgent: req.get("user-agent") || undefined, rehashed: needsRehash || undefined },
    });

    res.json({ ok: true, username: user.username, role: user.role });
  } catch (err) {
    next(err);
  }
});

const TotpLoginSchema = z.object({
  pendingToken: z.string().min(1),
  code:         z.string().min(1),
  isBackupCode: z.boolean().optional(),
});

// POST /api/v1/auth/login/totp — second-step of the two-phase login
router.post("/login/totp", async (req, res, next) => {
  try {
    const { pendingToken, code, isBackupCode } = TotpLoginSchema.parse(req.body);

    // Peek first so we can correctly attribute failures to the right user
    // without prematurely consuming a token that might still be valid.
    const pending = mfaPending.peek(pendingToken);
    if (!pending) {
      throw new AppError(401, "Session expired — please sign in again.");
    }

    // Apply the shared login lockout here too, so an attacker can't grind
    // codes after a stolen password without hitting the same 5-failure ceiling.
    const lock = isLocked(pending.username);
    if (lock.locked) {
      logEvent({
        action: "auth.login.locked",
        resourceType: "user",
        resourceId: pending.userId,
        resourceName: pending.username,
        level: "warning",
        message: `TOTP attempt on locked account "${pending.username}"`,
        details: { ip: req.ip, lockedUntil: lock.until?.toISOString() },
      });
      throw new AppError(
        423,
        `Account temporarily locked due to too many failed attempts. Try again after ${lock.until?.toLocaleTimeString() ?? "later"}.`,
      );
    }

    const user = await prisma.user.findUnique({ where: { id: pending.userId } });
    if (!user || !user.totpSecret || !user.totpEnabledAt) {
      // User or their TOTP config disappeared between steps — fail closed.
      mfaPending.consume(pendingToken);
      throw new AppError(401, "Session expired — please sign in again.");
    }

    let verified = false;
    let remainingBackupCodes: string[] | null = null;

    if (isBackupCode) {
      const remaining = await consumeBackupCode(user.totpBackupCodes, code);
      if (remaining !== null) {
        verified = true;
        remainingBackupCodes = remaining;
      }
    } else {
      verified = verifyTotpCode(user.totpSecret, code);
    }

    if (!verified) {
      const tripped = recordFailure(pending.username);
      logEvent({
        action: "auth.login.totp_failed",
        resourceType: "user",
        resourceId: user.id,
        resourceName: user.username,
        level: "warning",
        message: `Failed ${isBackupCode ? "backup-code" : "TOTP"} attempt for ${user.username}`,
        details: { ip: req.ip, failures: tripped.failures },
      });
      if (tripped.lockedNow) {
        // Drop the pending token so they can't keep trying to grind codes
        // against the same password-verified state after the lockout expires.
        mfaPending.consume(pendingToken);
      }
      throw new AppError(401, "Invalid verification code");
    }

    // Success: consume the pending token, persist any backup-code removal,
    // issue the real session, clear failure counter.
    mfaPending.consume(pendingToken);
    clearLockout(pending.username);

    const postVerifyData: { lastLogin: Date; totpBackupCodes?: string[] } = { lastLogin: new Date() };
    if (remainingBackupCodes) postVerifyData.totpBackupCodes = remainingBackupCodes;
    await prisma.user.update({ where: { id: user.id }, data: postVerifyData });

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.authProvider = user.authProvider || "local";
    req.session.mfaVerified = true;
    req.session.lastActivity = Date.now();

    logEvent({
      action: "auth.login.local",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `Local login (with TOTP): ${user.username}`,
      details: {
        ip: req.ip,
        userAgent: req.get("user-agent") || undefined,
        method: isBackupCode ? "backup_code" : "totp",
        backupCodesRemaining: remainingBackupCodes ? remainingBackupCodes.length : undefined,
      },
    });

    res.json({ ok: true, username: user.username, role: user.role });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/logout
router.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

// GET /api/v1/auth/me
router.get("/me", (req, res) => {
  if (req.session?.userId) {
    res.json({
      authenticated: true,
      username: req.session.username,
      role: req.session.role,
      authProvider: req.session.authProvider || "local",
    });
  } else {
    res.json({ authenticated: false });
  }
});

// ─── Azure SAML SSO ──────────────────────────────────────────────────────────

// GET /api/v1/auth/azure/config — public, login page checks this
router.get("/azure/config", async (_req, res) => {
  const settings = await getSsoSettings();
  const enabled = !!(settings.enabled && settings.idpEntityId && settings.idpLoginUrl && settings.idpCertificate);
  let brand = "generic";
  if (settings.idpLoginUrl && /microsoftonline\.com|login\.microsoft\.com/i.test(settings.idpLoginUrl)) {
    brand = "microsoft";
  } else if (settings.idpLoginUrl && /accounts\.google\.com/i.test(settings.idpLoginUrl)) {
    brand = "google";
  } else if (settings.idpLoginUrl && /okta\.com/i.test(settings.idpLoginUrl)) {
    brand = "okta";
  }
  res.json({
    enabled,
    brand,
    skipLoginPage: settings.skipLoginPage,
    autoLogoutMinutes: settings.autoLogoutMinutes,
  });
});

// GET /api/v1/auth/azure/login — redirects to IdP SAML login
router.get("/azure/login", async (req, res) => {
  const configured = await isAzureSsoConfiguredAsync();
  if (!configured) {
    return res.redirect("/login.html?error=azure_not_configured");
  }
  try {
    const relayState = generateRelayState();
    req.session.samlRelayState = relayState;
    const url = await getSamlLoginUrl(relayState);
    res.redirect(url);
  } catch (err: any) {
    res.redirect(`/login.html?error=${encodeURIComponent(err.message || "sso_error")}`);
  }
});

// POST /api/v1/auth/azure/callback — handles SAML Response from IdP
router.post("/azure/callback", async (req, res) => {
  try {
    // Validate relay state when available (SameSite=Lax cookies are not
    // sent on cross-site POST, so the session may be empty here — the
    // signed SAML response provides the primary authentication guarantee)
    const returnedState = req.body.RelayState || "";
    if (req.session.samlRelayState && returnedState !== req.session.samlRelayState) {
      return res.redirect("/login.html?error=invalid_state");
    }

    const profile = await validateSamlResponse(req.body);
    const user = await findOrProvisionSamlUser(profile);

    // Regenerate after the relay-state check above has consumed the pre-auth
    // session; the new session drops the old ID (and samlRelayState with it).
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.authProvider = "azure";
    // IdP is responsible for MFA on Azure SAML users; their session is
    // implicitly "mfa-verified" as far as Polaris is concerned.
    req.session.mfaVerified = true;
    req.session.lastActivity = Date.now();
    req.session.samlNameID = profile.nameID;
    req.session.samlSessionIndex = profile.sessionIndex;

    logEvent({
      action: "auth.login.azure",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `SAML SSO login: ${user.username} (${user.email || "no email"})`,
    });

    res.redirect("/");
  } catch (err: any) {
    logEvent({
      action: "auth.login.azure.failed",
      resourceType: "user",
      level: "error",
      message: `SAML SSO callback failed: ${err.message}`,
    });
    res.redirect(`/login.html?error=${encodeURIComponent(err.message || "sso_callback_error")}`);
  }
});

// POST /api/v1/auth/azure/logout — SAML single logout
router.post("/azure/logout", requireAuth, async (req, res) => {
  try {
    const nameID = req.session.samlNameID;
    const sessionIndex = req.session.samlSessionIndex;

    if (nameID && sessionIndex && await isAzureSsoConfiguredAsync()) {
      const relayState = generateRelayState();
      const logoutUrl = await getSamlLogoutUrl(nameID, sessionIndex, relayState);
      req.session.destroy(() => {});
      res.clearCookie("connect.sid");
      return res.json({ ok: true, logoutUrl });
    }

    // No SAML session — just destroy local session
    req.session.destroy(() => {});
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  } catch (err: any) {
    req.session.destroy(() => {});
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  }
});

// POST /api/v1/auth/azure/test — validate SAML config (admin only)
router.post("/azure/test", requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const settings = await getSsoSettings();
    const results: { certificate: any; idpLoginUrl: any } = {
      certificate: { ok: false, message: "No certificate provided" },
      idpLoginUrl: { ok: false, message: "No IdP Login URL provided" },
    };

    // ── Validate certificate ──
    if (settings.idpCertificate) {
      try {
        const crypto = await import("node:crypto");
        // Wrap bare base64 in PEM headers if needed
        let pem = settings.idpCertificate.trim();
        if (!pem.startsWith("-----BEGIN")) {
          pem = `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----`;
        }
        const cert = new crypto.X509Certificate(pem);
        const now = new Date();
        const validFrom = new Date(cert.validFrom);
        const validTo = new Date(cert.validTo);
        const expired = now > validTo;
        const notYetValid = now < validFrom;
        const daysLeft = Math.floor((validTo.getTime() - now.getTime()) / 86400000);

        results.certificate = {
          ok: !expired && !notYetValid,
          subject: cert.subject,
          issuer: cert.issuer,
          validFrom: cert.validFrom,
          validTo: cert.validTo,
          expired,
          daysLeft,
          message: expired
            ? `Certificate expired on ${cert.validTo}`
            : notYetValid
            ? `Certificate not valid until ${cert.validFrom}`
            : `Valid — expires in ${daysLeft} days (${cert.validTo})`,
        };
      } catch (certErr: any) {
        results.certificate = {
          ok: false,
          message: `Invalid certificate: ${certErr.message}`,
        };
      }
    }

    // ── Check IdP Login URL reachability ──
    if (settings.idpLoginUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(settings.idpLoginUrl, {
          method: "HEAD",
          signal: controller.signal,
          redirect: "manual",
        });
        clearTimeout(timeout);
        // 200, 302, 405 are all fine — means the IdP endpoint is alive
        results.idpLoginUrl = {
          ok: true,
          status: resp.status,
          message: `Reachable (HTTP ${resp.status})`,
        };
      } catch (urlErr: any) {
        const msg = urlErr.name === "AbortError"
          ? "Connection timed out (8s)"
          : urlErr.cause?.code === "ENOTFOUND"
          ? `Host not found — ${new URL(settings.idpLoginUrl).hostname}`
          : urlErr.message || "Connection failed";
        results.idpLoginUrl = { ok: false, message: msg };
      }
    }

    const allOk = results.certificate.ok && results.idpLoginUrl.ok;
    res.json({ ok: allOk, results });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/auth/azure/settings — admin only
router.get("/azure/settings", requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const settings = await getSsoSettings();
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/auth/azure/settings — admin only
router.put("/azure/settings", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const settings = await updateSsoSettings(req.body);
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// ─── OIDC Settings ──────────────────────────────────────────────────────────

router.get("/oidc/settings", requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "oidc" } });
    res.json(row?.value ?? { enabled: false, discoveryUrl: "", clientId: "", clientSecret: "", scopes: "openid profile email" });
  } catch (err) { next(err); }
});

router.put("/oidc/settings", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const value = {
      enabled: !!req.body.enabled,
      discoveryUrl: (req.body.discoveryUrl || "").trim(),
      clientId: (req.body.clientId || "").trim(),
      clientSecret: (req.body.clientSecret || "").trim(),
      scopes: (req.body.scopes || "openid profile email").trim(),
    };
    await prisma.setting.upsert({
      where: { key: "oidc" },
      update: { value: value as any },
      create: { key: "oidc", value: value as any },
    });
    res.json(value);
  } catch (err) { next(err); }
});

// ─── LDAP Settings ──────────────────────────────────────────────────────────

router.get("/ldap/settings", requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "ldap" } });
    const val: any = row?.value ?? {};
    res.json({
      enabled: val.enabled || false,
      url: val.url || "",
      bindDn: val.bindDn || "",
      bindPassword: val.bindPassword ? "********" : "",
      searchBase: val.searchBase || "",
      searchFilter: val.searchFilter || "(sAMAccountName={{username}})",
      tlsVerify: val.tlsVerify !== false,
      displayNameAttr: val.displayNameAttr || "displayName",
      emailAttr: val.emailAttr || "mail",
    });
  } catch (err) { next(err); }
});

router.put("/ldap/settings", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const current = await prisma.setting.findUnique({ where: { key: "ldap" } });
    const cur: any = current?.value ?? {};
    const value = {
      enabled: !!req.body.enabled,
      url: (req.body.url || "").trim(),
      bindDn: (req.body.bindDn || "").trim(),
      bindPassword: req.body.bindPassword === "********" ? (cur.bindPassword || "") : (req.body.bindPassword || "").trim(),
      searchBase: (req.body.searchBase || "").trim(),
      searchFilter: (req.body.searchFilter || "(sAMAccountName={{username}})").trim(),
      tlsVerify: req.body.tlsVerify !== false,
      displayNameAttr: (req.body.displayNameAttr || "displayName").trim(),
      emailAttr: (req.body.emailAttr || "mail").trim(),
    };
    await prisma.setting.upsert({
      where: { key: "ldap" },
      update: { value: value as any },
      create: { key: "ldap", value: value as any },
    });
    res.json({ ...value, bindPassword: value.bindPassword ? "********" : "" });
  } catch (err) { next(err); }
});

// ─── TOTP self-management ───────────────────────────────────────────────────
// Endpoints for the logged-in user to enroll / confirm / disable their own
// second factor. Admin-initiated reset for *another* user lives under
// /users/:id/totp (see routes/users.ts).

const TotpConfirmSchema = z.object({ code: z.string().min(1) });
const TotpDisableSchema = z.object({ code: z.string().min(1), isBackupCode: z.boolean().optional() });

// POST /api/v1/auth/totp/enroll — start enrollment for the current user
router.post("/totp/enroll", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId!;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, "User not found");
    if (user.authProvider !== "local") {
      throw new AppError(400, "Two-factor auth is managed by your identity provider for SSO accounts.");
    }

    // Starting fresh enrollment always discards any half-configured state.
    // If TOTP is already fully enabled, the caller must disable it first —
    // we don't silently replace a working setup.
    if (user.totpEnabledAt) {
      throw new AppError(409, "Two-factor auth is already enabled. Disable it before re-enrolling.");
    }

    const secret = generateTotpSecret();
    const { otpauthUri, qrSvg } = await buildEnrollment(secret, user.username);
    await prisma.user.update({ where: { id: userId }, data: { totpSecret: secret } });

    res.json({ secret, otpauthUri, qrSvg });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/totp/confirm — finalize enrollment by proving the user
// configured their authenticator correctly (verify first 6-digit code)
router.post("/totp/confirm", requireAuth, async (req, res, next) => {
  try {
    const { code } = TotpConfirmSchema.parse(req.body);
    const userId = req.session.userId!;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpSecret) {
      throw new AppError(400, "No enrollment in progress — start by generating a QR code.");
    }
    if (user.totpEnabledAt) {
      throw new AppError(409, "Two-factor auth is already enabled.");
    }
    if (!verifyTotpCode(user.totpSecret, code)) {
      throw new AppError(401, "Invalid code. Try again with a fresh value from your authenticator app.");
    }

    const { plaintext, hashes } = await generateBackupCodes();
    await prisma.user.update({
      where: { id: userId },
      data: { totpEnabledAt: new Date(), totpBackupCodes: hashes },
    });

    // Mark the current session mfa-verified so the user doesn't have to
    // log out and back in just because they enrolled.
    req.session.mfaVerified = true;

    logEvent({
      action: "auth.totp.enrolled",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `TOTP enabled for ${user.username}`,
    });

    res.json({ ok: true, backupCodes: plaintext });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/auth/totp — self-disable. Requires a valid current TOTP or
// backup code so a stolen session can't silently drop MFA.
router.delete("/totp", requireAuth, async (req, res, next) => {
  try {
    const { code, isBackupCode } = TotpDisableSchema.parse(req.body);
    const userId = req.session.userId!;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, "User not found");
    if (!user.totpEnabledAt || !user.totpSecret) {
      throw new AppError(400, "Two-factor auth is not currently enabled.");
    }

    let verified = false;
    if (isBackupCode) {
      const remaining = await consumeBackupCode(user.totpBackupCodes, code);
      verified = remaining !== null;
    } else {
      verified = verifyTotpCode(user.totpSecret, code);
    }
    if (!verified) throw new AppError(401, "Invalid code.");

    await prisma.user.update({
      where: { id: userId },
      data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: [] },
    });

    logEvent({
      action: "auth.totp.disabled",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `TOTP disabled for ${user.username} (self)`,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/auth/totp/status — current user's enrollment state
router.get("/totp/status", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId! },
      select: { authProvider: true, totpSecret: true, totpEnabledAt: true, totpBackupCodes: true },
    });
    if (!user) throw new AppError(404, "User not found");
    res.json({
      authProvider: user.authProvider,
      enabled: !!user.totpEnabledAt,
      enrolling: !!user.totpSecret && !user.totpEnabledAt,
      backupCodesRemaining: user.totpBackupCodes?.length ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
