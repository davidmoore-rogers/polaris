/**
 * src/api/routes/auth.ts — Login / Logout / Session check / Azure SAML SSO
 */

import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { prisma } from "../../db.js";
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

const LoginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

// POST /api/v1/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = LoginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new AppError(401, "Invalid username or password");
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.authProvider = user.authProvider || "local";
    req.session.lastActivity = Date.now();

    // Update last login
    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

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

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.authProvider = "azure";
    req.session.lastActivity = Date.now();
    req.session.samlNameID = profile.nameID;
    req.session.samlSessionIndex = profile.sessionIndex;
    delete (req.session as any).samlRelayState;

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

export default router;
