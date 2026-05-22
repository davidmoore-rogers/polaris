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
import { UPLOADS_DIR } from "./utils/paths.js";
import { isAzureSsoConfiguredAsync, getSsoSettings } from "./services/azureAuthService.js";
import {
  renderMetrics,
  startHttpRequestTimer,
  incHttpInFlight,
  decHttpInFlight,
  statusToClass,
} from "./metrics.js";
import "./jobs/expireReservations.js";
import "./jobs/pruneEvents.js";
import "./jobs/ouiRefresh.js";
import "./jobs/updateCheck.js";
import "./jobs/discoveryScheduler.js";
import "./jobs/discoverySlowCheck.js";
import "./jobs/clampAssetAcquiredAt.js";
import "./jobs/decommissionStaleAssets.js";
import "./jobs/monitorAssets.js";
import "./jobs/normalizeManufacturers.js";
import "./jobs/seedAssetTypes.js";
import "./jobs/seedManufacturerProfiles.js";
import "./jobs/backfillManufacturerProfileMemoryComposition.js";
import "./jobs/migrateMonitorSettingsHierarchy.js";
import "./jobs/renameMonitorClassKeys.js";
import "./jobs/migrateRetentionTiers.js";
import "./jobs/consolidateSampleRetention.js";
import "./jobs/migrateMonitorStatusRename.js";
import "./jobs/migrateAutoMonitorInterfacesShape.js";
import "./jobs/migrateSystemInfoCadenceLinkage.js";
import "./jobs/migrateMonitorSettingsPerClass.js";
import "./jobs/backfillAssetSources.js";
import "./jobs/flagStaleReservations.js";
import "./jobs/capacityWatch.js";
import "./jobs/resolvePolarisPushedConflicts.js";
import "./jobs/resolveStaleReservationConflicts.js";
import "./jobs/scrubLegacySidGuidTags.js";
import "./jobs/cleanupStaleDnsResolvedReleased.js";
import "./jobs/backfillFortigateEndpointSources.js";
import "./jobs/fixInfraAssetTypes.js";
import "./jobs/mergeFortiswitchEndpointGhosts.js";
import "./jobs/mergeDuplicateHostnameAssets.js";
import "./jobs/backfillDependencyTree.js";
import "./jobs/backfillMonitorStatusChangedAt.js";
import "./jobs/backfillMonitorOverride.js";
import "./jobs/rasterizeStoredSvgIcons.js";
import "./jobs/dependencyReconciler.js";
import "./jobs/retryQueuedReservationPushes.js";
import "./jobs/reconcileMapRegions.js";
import "./jobs/reconcileDnsResolvedReservations.js";
import "./jobs/runSampleRollup.js";
import "./jobs/autoBuildAgents.js";
import { ensureRegistryLoaded } from "./services/oidRegistry.js";
import { detectTimescale, migrateToHypertables } from "./services/timescaleService.js";
import { initializeQueue, startPgbossWorkers, stopPgbossWorkers } from "./services/queueService.js";
import { startSampleWriteBuffer, shutdownFlushSampleBuffers } from "./services/sampleWriteBuffer.js";
import { startProbePatchBuffer, shutdownFlushProbePatchBuffer } from "./services/probePatchBuffer.js";
import { runStartupDiskCheck } from "./utils/startupDiskCheck.js";
import { runSchemaSanityCheck } from "./utils/schemaSanityCheck.js";
import { getDbConnectionMode } from "./utils/dbConnections.js";
import { recordDbConnectionMode } from "./metrics.js";

// Stamp the detected DB connection topology once at boot so operators (and
// `/metrics` scrapes) can confirm Polaris recognized their PgBouncer setup
// without reading logs. The mode is constant for the life of the process.
{
  const mode = getDbConnectionMode();
  recordDbConnectionMode(mode);
  if (mode === "pgbouncer") {
    logger.info(
      "DB connection mode: PgBouncer detected. Application queries through DATABASE_URL; pg-boss / pg_dump / pg_stat_activity through POLARIS_DB_DIRECT_URL.",
    );
  } else {
    logger.info("DB connection mode: direct to PostgreSQL.");
  }
}

// Warm the symbolic-OID registry once at startup so the first monitor tick
// can resolve vendor MIB symbols without paying a load on the hot path. Errors
// are non-fatal — the registry will lazily reload on the next resolve() call.
ensureRegistryLoaded().catch((err) => {
  logger.warn({ err: err?.message }, "OID registry warm-up failed");
});

// Warm the monitor-queue mode cache at startup so the dispatcher in
// `monitorAssets.ts` and the capacity snapshot both see the same value.
// When the boot-time mode is "pgboss", also spin up the pg-boss worker
// pools — they pull jobs the publisher submits from monitorAssets.ts.
// Non-fatal — failure leaves Polaris on the cursor (default) queue.
initializeQueue()
  .then(() =>
    startPgbossWorkers().catch((err) => {
      const msg = String(err?.message || "");
      // Distinguish the most common operator-actionable failure (the role
      // Polaris connects as doesn't own the pgboss schema) from generic
      // pg-boss errors. The actionable error gets a multi-line log entry
      // with the SQL the DBA needs to run; everything else stays a plain
      // warn line.
      if (/permission denied for schema pgboss/i.test(msg)) {
        logger.error(
          { err: msg },
          "pg-boss worker start failed — the polaris DB role does not own the pgboss schema.\n" +
          "Polaris will fall back to in-process cursor mode (suitable for small/medium fleets only).\n" +
          "To enable pg-boss for large fleets, run the following on the polaris database as a Postgres\n" +
          "superuser (psql ... or via your managed-Postgres console), replacing $DB_USER with the\n" +
          "polaris role:\n" +
          "  ALTER SCHEMA pgboss OWNER TO $DB_USER;\n" +
          "  GRANT ALL ON SCHEMA pgboss TO $DB_USER;\n" +
          "  GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO $DB_USER;\n" +
          "  GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO $DB_USER;\n" +
          "  GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO $DB_USER;\n" +
          "  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO $DB_USER;\n" +
          "  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO $DB_USER;\n" +
          "  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO $DB_USER;\n" +
          "Then restart the polaris service.",
        );
      } else {
        logger.warn({ err: msg }, "pg-boss worker start failed; staying on cursor");
      }
    }),
  )
  .catch((err) => {
    logger.warn({ err: err?.message }, "Queue initialization failed; defaulting to cursor mode");
  });

// Start the monitor sample-write buffer. Cuts per-probe DB-pool acquisitions
// by batching the six append-only sample tables (monitor / telemetry /
// temperature / interface / storage / ipsec tunnel) into one createMany
// per 2-second flush window instead of one create per work item.
startSampleWriteBuffer();

// Start the probe-patch buffer. Companion to the sample-write buffer for
// the STATE side of recordProbeResult — one bulk UPDATE FROM VALUES per
// 2 s window covers every asset's monitorStatus / counters / last-at
// timestamps instead of one prisma.asset.update per probe.
startProbePatchBuffer();

// Graceful shutdown on SIGTERM/SIGINT so in-flight jobs can drain and the
// final buffer flushes land before the process exits. No-op when
// pg-boss never started.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    Promise.allSettled([
      shutdownFlushSampleBuffers(),
      shutdownFlushProbePatchBuffer(),
      stopPgbossWorkers(),
    ]).finally(() => process.exit(0));
  });
}

// Detect TimescaleDB once at startup so the prune layer + capacity service
// can dispatch on hypertable status without paying a probe on every call.
// When detected, also convert the six sample tables to hypertables and
// apply the compression policy (idempotent — safe to re-run). Existing data
// is migrated in place during the conversion via `migrate_data => TRUE`,
// taking a brief ACCESS EXCLUSIVE lock per table; the operator sees a
// "Converting sample table to hypertable" log line for each.
//
// Non-fatal — failure leaves Polaris on plain-Postgres prune for the
// affected table(s). Detection is awaited because the migrate step depends
// on the cache being warm; the migrate itself runs as a fire-and-forget
// chain so it doesn't block listen().
detectTimescale()
  .then(() =>
    migrateToHypertables().catch((err) => {
      logger.warn({ err: err?.message }, "TimescaleDB hypertable migration failed");
    }),
  )
  .catch((err) => {
    logger.warn({ err: err?.message }, "TimescaleDB detection failed");
  });

// Boot-time disk diagnostic. Logs a clear "X volume has Y MB free" line for
// every filesystem Polaris/Postgres write to, at info/warn/error level
// depending on free percentage. Catches the "polaris flapping because /var
// is full" case before the operator has to dig through Prisma errors.
// Non-fatal — never blocks startup; the periodic capacityWatch job and
// Maintenance tab carry the same signal at runtime.
void runStartupDiskCheck();

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
  return "polaris-dev-secret-change-in-production";
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
        // OpenStreetMap tile servers (light theme) AND CartoDB Dark Matter
        // (dark theme) are whitelisted here so the Device Map page can render
        // a real geographic basemap in both themes. Tiles load as <img>, not
        // fetch, so connectSrc stays 'self'-only.
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.tile.openstreetmap.org",
          "https://tile.openstreetmap.org",
          "https://*.basemaps.cartocdn.com",
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

// ─── HTTP request metrics ────────────────────────────────────────────────────
// Tracks `polaris_http_request_duration_seconds` (by method/route/status_class)
// and `polaris_http_in_flight`. Skips /metrics and /health to avoid scrape
// requests showing up as application traffic. The matched Express route
// template is captured at response-finish time so cardinality stays bounded
// — unmatched paths roll up to "unmatched" instead of one series per URL.
app.use((req, res, next) => {
  if (req.path === "/metrics" || req.path === "/health") return next();
  incHttpInFlight();
  const stopTimer = startHttpRequestTimer();
  let observed = false;
  const finalize = () => {
    if (observed) return;
    observed = true;
    decHttpInFlight();
    // req.route is populated only when Express matched a route. Combine with
    // baseUrl so /api/v1/assets/:id renders correctly instead of just "/:id".
    const route = req.route?.path
      ? (req.baseUrl ?? "") + (typeof req.route.path === "string" ? req.route.path : "unmatched")
      : "unmatched";
    stopTimer(req.method, route, statusToClass(res.statusCode));
  };
  res.once("finish", finalize);
  res.once("close", finalize);
  next();
});

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

// Mobile UA redirect — phone-class user-agents that hit the dashboard root
// get bounced to /mobile.html, which is the dedicated phone SPA. We only
// redirect "/" and "/index.html" — every other page (assets, subnets, the
// SSO callback handler, etc.) stays untouched so phones can still access
// the desktop UI directly when they need to. The `?desktop=1` query param
// is the escape hatch the mobile app uses on its "Desktop view" link.
//
// `Mobile` covers Chrome/Firefox on phones, `iPhone`/`iPod` covers Safari
// on iPhone, and the `Android.*Mobile` form catches Android browsers that
// don't ship the bare token. iPad is intentionally excluded — modern iPad
// Safari requests desktop layouts by default, and the desktop UI works
// fine on a tablet-class screen.
const PHONE_UA_REGEX = /(Mobile|iPhone|iPod|Android.*Mobile)/i;
app.use((req, res, next) => {
  if (req.path !== "/" && req.path !== "/index.html") return next();
  if (req.query.desktop === "1") return next();
  const ua = req.get("user-agent") || "";
  if (PHONE_UA_REGEX.test(ua)) {
    return res.redirect("/mobile.html");
  }
  return next();
});

// Protect dashboard pages — redirect unauthenticated users to login
const protectedPages = ["/", "/index.html", "/ipam.html", "/blocks.html", "/subnets.html", "/reservations.html", "/users.html", "/integrations.html", "/assets.html", "/events.html", "/server-settings.html", "/map.html"];

// Page-level gating — each protected page requires at least `read` on the
// matching function key. Maps to the same matrix the API guards use, so
// hiding a page also hides the API surface it consumes. A user without
// the requisite permission bounces to "/". Pages not in the map are
// reachable to any authenticated user (the per-tile cards / API requests
// handle their own permission state).
const pageRequiredPermission: Record<string, { key: string; level: "read" | "write" }> = {
  "/users.html":           { key: "users",                level: "read" },
  "/integrations.html":    { key: "integrations",         level: "read" },
  "/server-settings.html": { key: "serverSettingsSystem", level: "read" },
};
const PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 } as const;
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
  const required = pageRequiredPermission[req.path];
  if (required) {
    // Old-session self-heal: a session issued before the dynamic-roles
    // cutover has `userId` but no `roleSnapshot`, so the lookup below
    // would silently return "none" and bounce the operator home. Defer
    // to `ensureSessionRoleSnapshot` which loads the user's role from
    // DB and stamps the session in place. One DB hit per surviving old
    // session; the snapshot path is hot after that.
    const { ensureSessionRoleSnapshot } = await import("./api/middleware/permissions.js");
    const snap = await ensureSessionRoleSnapshot(req).catch(() => null);
    const perms = (snap?.permissions ?? req.session.roleSnapshot?.permissions ?? {}) as Record<string, "none" | "read" | "write" | "fullwrite">;
    const actual = perms[required.key] ?? "none";
    if (PERM_RANK[actual] < PERM_RANK[required.level]) {
      return res.redirect("/");
    }
  }
  return next();
});

// Legacy IPAM URL redirects. /blocks.html and /subnets.html were folded
// into /ipam.html with tabs in the 2026-05 dashboard rework. We serve a
// tiny HTML stub that loads an external script which does the redirect
// client-side so any existing fragment (e.g. /subnets.html#ip=<sid>@<ip>
// from the assets-page deep link) is preserved across the hop —
// server-side 302 would either drop the original fragment (when the
// Location carries one) or fail to set the tab (when it doesn't), and we
// can't see the fragment server-side. The script lives in an external
// file (public/js/legacy-ipam-redirect.js) because the strict CSP
// scriptSrc: 'self' blocks inline <script> blocks — without the external
// file the stub would render blank and never redirect. Must precede
// express.static so the stubs win over the still-present
// public/blocks.html and public/subnets.html files.
function legacyIpamRedirect() {
  return (_req: any, res: any) => {
    res.set("Cache-Control", "no-store");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Polaris</title></head><body><script src="/js/legacy-ipam-redirect.js"></script></body></html>`);
  };
}
app.get("/blocks.html", legacyIpamRedirect());
app.get("/subnets.html", legacyIpamRedirect());

// Serve uploaded logos from the state directory. On legacy installs (no
// POLARIS_STATE_DIR set) this resolves to <project>/public/uploads — the
// same files the express.static(public) mount below also serves, so the
// explicit mount is a redundant no-op. On the Docker image it points at
// /app/state/public/uploads so logos persist across container rebuilds.
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(path.resolve(__dirname, "..", "public")));

// Health check. Open by default because the first-run setup wizard polls
// this endpoint (from localhost) to detect when the main app has come up.
// Set HEALTH_TOKEN=<string> in .env to require `Authorization: Bearer <token>`
// on the endpoint — useful when Polaris is public-facing and you want to
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

// Prometheus metrics endpoint. Same Bearer-token convention as /health: open
// by default, gated by METRICS_TOKEN when set. Exports default Node.js
// process / event-loop metrics plus Polaris-specific monitor / probe
// histograms and counters defined in src/metrics.ts.
app.get("/metrics", async (req, res) => {
  const expected = process.env.METRICS_TOKEN;
  if (expected) {
    const auth = req.get("authorization") || "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (supplied !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  const { contentType, body } = await renderMetrics();
  res.setHeader("Content-Type", contentType);
  res.send(body);
});
// API responses are session/state-dependent and must never be cached. Without
// this header, browsers fall back to heuristic caching of JSON responses,
// which surfaces visibly when /auth/me gets cached pre-login and then
// re-served as a 304 after login completes — the mobile flow then thinks
// the user isn't authenticated and bounces back to the login screen.
// `no-store` disables both browser cache AND any intermediate proxy cache.
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api/v1", router);
app.use(errorHandler);

export async function startApp(): Promise<void> {
  // Boot-time Prisma-client-vs-DB schema check. Fails fast with a clear
  // recovery message when the running client references columns the
  // database doesn't have (or vice versa). Runs before listen() so a
  // broken deploy doesn't bind a port and accept traffic it can't serve.
  await runSchemaSanityCheck();

  const httpsSettings = await getHttpsSettings().catch(() => null);
  const PORT = process.env.PORT ?? httpsSettings?.httpPort ?? 3000;
  const httpServer = app.listen(PORT, () => {
    logger.info({ port: PORT }, "Polaris server listening");
    initHttps(app);
  });
  // Attach the Polaris Agent WebSocket upgrade handler. Same server
  // surface as the REST API — agents reach /api/v1/agents/ws over the
  // same port and (in production) the same HTTPS cert their pin verifies.
  const { attachAgentWsUpgradeHandler } = await import("./api/routes/agentsWs.js");
  attachAgentWsUpgradeHandler(httpServer);
}

export { app };
