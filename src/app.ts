/**
 * src/app.ts — Full application server (extracted from index.ts)
 *
 * Only imported when DATABASE_URL is configured (setup is complete).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { router } from "./api/router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { errorHandler } from "./api/middleware/errorHandler.js";
import { logger } from "./utils/logger.js";
import { initHttps, httpsRedirectMiddleware } from "./httpsManager.js";
import { getHttpsSettings } from "./services/serverSettingsService.js";
import { isAzureSsoConfiguredAsync, getSsoSettings } from "./services/azureAuthService.js";
import "./jobs/pruneEvents.js";
import "./jobs/ouiRefresh.js";
import "./jobs/updateCheck.js";

const app = express();

// ─── Security headers ────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", "https://login.microsoftonline.com"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  })
);

// ─── Body parsing with size limits ───────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" })); // SAML callback posts form-encoded

// ─── Session ─────────────────────────────────────────────────────────────────
app.use(
  session({
    secret: process.env.SESSION_SECRET || "shelob-dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.FORCE_HTTPS === "true",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// ─── Rate limiting ───────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
});
app.use("/api/v1/auth/login", loginLimiter);
app.use("/api/v1/auth/azure/login", loginLimiter);

// HTTP → HTTPS redirect (enabled dynamically via server settings)
app.use(httpsRedirectMiddleware);

// Inactivity timeout — check and update last activity on every authenticated request
app.use(async (req, res, next) => {
  if (req.session?.userId) {
    const settings = await getSsoSettings().catch(() => ({ autoLogoutMinutes: 0 }));
    if (settings.autoLogoutMinutes > 0) {
      const lastActivity = req.session.lastActivity || 0;
      const idleMs = Date.now() - lastActivity;
      if (lastActivity > 0 && idleMs > settings.autoLogoutMinutes * 60 * 1000) {
        req.session.destroy(() => {});
        if (req.path.startsWith("/api/")) {
          return res.status(401).json({ error: "Session expired due to inactivity" });
        }
        return res.redirect("/login.html");
      }
    }
    req.session.lastActivity = Date.now();
  }
  next();
});

// Protect dashboard pages — redirect unauthenticated users to login
const protectedPages = ["/", "/index.html", "/blocks.html", "/subnets.html", "/reservations.html", "/users.html", "/integrations.html", "/assets.html", "/events.html", "/server-settings.html"];
const adminOnlyPages = ["/users.html", "/integrations.html", "/server-settings.html"];
app.use(async (req, res, next) => {
  if (!protectedPages.includes(req.path)) return next();
  if (!req.session?.userId) {
    // Skip login page: redirect straight to Azure SSO if configured
    if (await isAzureSsoConfiguredAsync()) {
      const settings = await getSsoSettings().catch(() => ({ skipLoginPage: false }));
      if (settings.skipLoginPage) {
        return res.redirect("/api/v1/auth/azure/login?prompt=none");
      }
    }
    return res.redirect("/login.html");
  }
  if (adminOnlyPages.includes(req.path) && req.session.role !== "admin") {
    return res.redirect("/");
  }
  return next();
});

app.use(express.static(path.resolve(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/v1", router);
app.use(errorHandler);

export async function startApp(): Promise<void> {
  const httpsSettings = await getHttpsSettings().catch(() => null);
  const PORT = process.env.PORT ?? httpsSettings?.httpPort ?? 3000;
  app.listen(PORT, () => {
    logger.info({ port: PORT }, "Shelob server listening");
    initHttps(app);
  });
}

export { app };
