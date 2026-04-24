/**
 * src/app.ts — Full application server (extracted from index.ts)
 *
 * Only imported when DATABASE_URL is configured (setup is complete).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import pg from "pg";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { router } from "./api/router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { errorHandler } from "./api/middleware/errorHandler.js";
import { csrfMiddleware } from "./api/middleware/csrf.js";
import { logger } from "./utils/logger.js";
import { initHttps, httpsRedirectMiddleware } from "./httpsManager.js";
import { getHttpsSettings } from "./services/serverSettingsService.js";
import { isAzureSsoConfiguredAsync, getSsoSettings } from "./services/azureAuthService.js";
import "./jobs/pruneEvents.js";
import "./jobs/ouiRefresh.js";
import "./jobs/updateCheck.js";
import "./jobs/discoveryScheduler.js";
import "./jobs/discoverySlowCheck.js";
import "./jobs/clampAssetAcquiredAt.js";
import "./jobs/decommissionStaleAssets.js";

const app = express();

// ─── Trust proxy (opt-in) ────────────────────────────────────────────────────
// Only enable when running behind a reverse proxy that sets X-Forwarded-For.
// Enabling this on a direct-to-internet deployment lets clients spoof their IP
// and bypass the login rate limiter, so it stays off unless TRUST_PROXY is set.
// Accepts a hop count (e.g. "1"), "loopback"/"linklocal"/"uniquelocal", or a
// CIDR list — see https://expressjs.com/en/guide/behind-proxies.html
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) {
  app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}

// ─── Session secret ──────────────────────────────────────────────────────────
// Hard-fail in production if SESSION_SECRET is unset; a predictable fallback
// lets attackers forge session cookies. Dev keeps a fallback for convenience.
function resolveSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is required when NODE_ENV=production. Set a long random value in .env before starting the server."
    );
  }
  return "shelob-dev-secret-change-in-production";
}
const SESSION_SECRET = resolveSessionSecret();

// ─── Security headers ────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Inline <script> blocks are DISALLOWED — all page JS is served
        // from external files under /js. This blocks the most dangerous
        // XSS vector (injected <script> tags that can define new functions,
        // fetch remote code, etc).
        scriptSrc: ["'self'"],
        // Inline on* handler attributes are still permitted via scriptSrcAttr
        // because many pages generate HTML with onclick="foo(...)" via
        // innerHTML. Migrating these to addEventListener delegation is a
        // larger follow-up; until then this keeps the feature working while
        // still closing the bigger <script>-tag hole above.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        // OpenStreetMap tile servers are whitelisted here so the Fortinet Map
        // page can render a real geographic basemap. Tiles load as <img>, not
        // fetch, so connectSrc stays 'self'-only.
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.tile.openstreetmap.org",
          "https://tile.openstreetmap.org",
        ],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", "https://login.microsoftonline.com"],
        upgradeInsecureRequests: null,
      },
    },
    // preload: true signals browser preload-list maintainers that we're OK
    // being included. The header alone is harmless; actual inclusion still
    // requires a separate submission to https://hstspreload.org/. Safe to
    // leave on as long as every subdomain served from this origin is also
    // HTTPS-only (includeSubDomains above makes that a hard requirement).
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  })
);

// ─── Response compression ────────────────────────────────────────────────────
app.use(compression());

// ─── Body parsing with size limits ───────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" })); // SAML callback posts form-encoded

// ─── Session ─────────────────────────────────────────────────────────────────
const PgStore = pgSession(session);
const sessionPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

app.use(
  session({
    store: new PgStore({
      pool: sessionPool,
      createTableIfMissing: true,
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // "auto" sets Secure when the request is HTTPS (including behind a
      // reverse proxy when TRUST_PROXY is set so X-Forwarded-Proto is
      // believed). Removes the need for a FORCE_HTTPS override.
      secure: "auto",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// ─── CSRF protection ─────────────────────────────────────────────────────────
// Must come after session middleware (reads/writes req.session) and before
// any route handler that performs writes.
app.use(csrfMiddleware);

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
const protectedPages = ["/", "/index.html", "/blocks.html", "/subnets.html", "/reservations.html", "/users.html", "/integrations.html", "/assets.html", "/events.html", "/server-settings.html", "/map.html"];
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

// Health check. Open by default because the first-run setup wizard polls
// this endpoint (from localhost) to detect when the main app has come up.
// Set HEALTH_TOKEN=<string> in .env to require `Authorization: Bearer <token>`
// on the endpoint — useful when Shelob is public-facing and you want to
// limit health pings to your own monitoring system.
app.get("/health", (req, res) => {
  const expected = process.env.HEALTH_TOKEN;
  if (expected) {
    const auth = req.get("authorization") || "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (supplied !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  res.json({ status: "ok" });
});
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
