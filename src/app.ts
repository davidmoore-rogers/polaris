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
import { resolveTrustProxy } from "./utils/trustProxy.js";
import { validateRuntimeConfiguration } from "./utils/runtimeConfig.js";
import { isProxyMode } from "./utils/proxyMode.js";
import { UPLOADS_DIR } from "./utils/paths.js";
import { isAzureSsoConfiguredAsync, getSsoSettings } from "./services/azureAuthService.js";
import { isOidcEnabled } from "./services/oidcAuthService.js";
import {
  renderMetrics,
  startHttpRequestTimer,
  incHttpInFlight,
  decHttpInFlight,
  statusToClass,
} from "./metrics.js";
// Background jobs are NOT statically imported here — importing a job module
// runs its self-start side effect, which must be gated by process role. They
// are dynamically imported per-role in startBackgroundJobs() below.
import { roleConfig, type RoleConfig } from "./utils/role.js";
import { startDiscoveryScheduler } from "./jobs/discoveryScheduler.js";
import { ensureRegistryLoaded } from "./services/oidRegistry.js";
import { detectTimescale, migrateToHypertables } from "./services/timescaleService.js";
import { initializeQueue, startPgbossWorkers, startDiscoveryWorker, startQueueProducer, stopPgbossWorkers } from "./services/queueService.js";
import { runDiscovery } from "./api/routes/integrations.js";
import { startSampleWriteBuffer, shutdownFlushSampleBuffers } from "./services/sampleWriteBuffer.js";
import { startProbePatchBuffer, shutdownFlushProbePatchBuffer } from "./services/probePatchBuffer.js";
import { runStartupDiskCheck } from "./utils/startupDiskCheck.js";
import { runSchemaSanityCheck } from "./utils/schemaSanityCheck.js";
import { getDbConnectionMode } from "./utils/dbConnections.js";
import { startMetricsOnlyServer } from "./utils/metricsServer.js";
import { recordDbConnectionMode, setDbPoolRoleCapacity } from "./metrics.js";
import { startFmgActivityHeartbeat } from "./services/fmgActivityService.js";

// Fail-fast environment validation runs BEFORE any listener binds, before
// pg-boss init, before sample buffers start. Throws on misconfiguration
// (e.g. POLARIS_PROXY_CERT_PATH set without POLARIS_PUBLIC_URL) so systemd's
// Restart=on-failure cycles the unit cleanly instead of leaving a half-
// initialized listener open. See src/utils/runtimeConfig.ts.
validateRuntimeConfiguration();

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

// Process role gates which subsystems boot here (see src/utils/role.ts).
// Unset POLARIS_ROLE => "all" => every capability on => today's single-process
// behavior. web = HTTP + singleton schedulers + migrations; monitor = pg-boss
// monitor consumers + write buffers; discovery = pg-boss discovery consumer.
const cfg = roleConfig();
logger.info(
  {
    role: cfg.role,
    runsHttp: cfg.runsHttp,
    runsMonitorConsumers: cfg.runsMonitorConsumers,
    runsDiscoveryConsumers: cfg.runsDiscoveryConsumers,
    runsSchedulers: cfg.runsSchedulers,
    runsMigrations: cfg.runsMigrations,
  },
  `Polaris process role: ${cfg.role}`,
);

// Capacity Advisor sanity check: the web role sizes pools + max_connections
// using POLARIS_MONITOR_REPLICAS to know the group's process count. Pre-Phase-3
// fresh installs (and any -nodb install before this fix) didn't write the var,
// so the advisor silently degrades to single-process math and over-recommends
// per-process DATABASE_POOL_SIZE / under-recommends max_connections. Warn loudly
// when we detect the gap so operators can `echo POLARIS_MONITOR_REPLICAS=N >>
// /opt/polaris/.env` and restart.
if (cfg.role === "web") {
  const replicasRaw = (process.env.POLARIS_MONITOR_REPLICAS ?? "").trim();
  const replicas = Number.parseInt(replicasRaw, 10);
  if (!replicasRaw || !Number.isFinite(replicas) || replicas < 1) {
    logger.warn(
      { POLARIS_MONITOR_REPLICAS: replicasRaw || "(unset)" },
      "POLARIS_MONITOR_REPLICAS is unset on the web role — Capacity Advisor will assume single-process and mis-size DATABASE_POOL_SIZE + PG max_connections. Set it to the number of polaris-monitor@N units enabled (matches --monitor-replicas at install time) in /opt/polaris/.env and restart polaris.target.",
    );
  }
}

// Stamp this process's configured connection capacity under its role label so
// /metrics exposes the per-role footprint — in a multi-process deployment no
// single process sees the whole group, so the Capacity Advisor / Prometheus
// sums these (across roles + monitor-replica instances) against max_connections.
{
  const envInt = (name: string, dflt: number): number => {
    const n = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const prismaPool = envInt("DATABASE_POOL_SIZE", 25);
  const pgbossPool = envInt("POLARIS_PGBOSS_POOL_SIZE", 20);
  setDbPoolRoleCapacity(cfg.role, prismaPool + pgbossPool);
}

// Warm the monitor-queue mode cache at startup so the dispatcher in
// `monitorAssets.ts` and the capacity snapshot both see the same value, then
// start the pg-boss surfaces this role needs: monitor consumers
// (runsMonitorConsumers), the discovery consumer (runsDiscoveryConsumers), and
// the producer connection so schedulers can publish (runsSchedulers).
// initializeQueue() runs in every role (cheap cache warm). Non-fatal — failure
// leaves Polaris on the cursor (default) queue.
void (async () => {
  try {
    await initializeQueue();
    if (cfg.runsMonitorConsumers) {
      await startPgbossWorkers().catch((err) => {
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
      });
    }
    if (cfg.runsDiscoveryConsumers) {
      await startDiscoveryWorker(runDiscovery).catch((err) => {
        logger.warn({ err: err?.message }, "pg-boss discovery worker start failed");
      });
      // Snapshot per-FmgWorker lane state to the DB every 2 s so the web role
      // can surface "active FMG calls" on the integration card without holding
      // the worker instances itself. See services/fmgActivityService.ts.
      startFmgActivityHeartbeat();
    }
    // Producer connection: schedulers (monitor producer ticks, discovery
    // scheduler) publish jobs, so the web/all role needs a live boss to send
    // through even when it consumes nothing. No-op in cursor mode.
    if (cfg.runsSchedulers && !cfg.runsMonitorConsumers) {
      await startQueueProducer().catch((err) => {
        logger.warn({ err: err?.message }, "pg-boss producer init failed; publishing disabled");
      });
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, "Queue initialization failed; defaulting to cursor mode");
  }
})();

// Sample-write + probe-patch buffers batch the per-probe sample inserts and
// state updates. The monitor consumers produce them via SNMP/REST probes, AND
// the web role produces them via the Polaris Agent `/samples` + `/probe-now`
// endpoints (mounted on the HTTP listener) — both roles must run the flush
// tick or agent-sourced rows sit in the in-process buffer and only land on
// graceful shutdown. runsWriteBuffers is true for monitor + web (+ all).
if (cfg.runsWriteBuffers) {
  // Sample-write buffer: batches the six append-only sample tables (monitor /
  // telemetry / temperature / interface / storage / ipsec tunnel) into one
  // createMany per 2-second flush window instead of one create per work item.
  startSampleWriteBuffer();
  // Probe-patch buffer: the STATE side of recordProbeResult — one bulk UPDATE
  // FROM VALUES per 2 s window covers every asset's monitorStatus / counters /
  // last-at timestamps instead of one prisma.asset.update per probe.
  startProbePatchBuffer();
}

// Standalone /metrics listener for the non-HTTP roles (monitor, discovery).
// Web/all serve /metrics from the main Express app, so this only fires when
// runsHttp is false AND the operator has set POLARIS_METRICS_PORT. Without
// this, every metric stamped from inside a monitor worker or discovery
// consumer lives in a process Prometheus never scrapes — the symptom is the
// "no data" panels for probe / work-duration / sample-write / discovery /
// FMG-proxy-lane on the Grafana dashboard.
if (!cfg.runsHttp) {
  const rawPort = Number.parseInt(process.env.POLARIS_METRICS_PORT ?? "", 10);
  if (Number.isFinite(rawPort) && rawPort > 0) {
    const bind = process.env.POLARIS_METRICS_BIND || "127.0.0.1";
    void startMetricsOnlyServer(rawPort, bind).catch((err) => {
      logger.error(
        { err: err?.message, port: rawPort, bind },
        "Failed to start metrics-only HTTP listener",
      );
    });
  }
}

// Start role-appropriate background jobs (dynamic imports so a job module's
// self-start side effect only fires in the role that should run it).
void startBackgroundJobs(cfg);

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
  .then(() => {
    // The hypertable conversion is schema DDL — run it only where migrations
    // run (web/all), so monitor/discovery replicas don't race on the same
    // ACCESS EXCLUSIVE locks. Detection itself runs in every role (read-only,
    // warms the prune/capacity cache).
    if (cfg.runsMigrations) {
      return migrateToHypertables().catch((err) => {
        logger.warn({ err: err?.message }, "TimescaleDB hypertable migration failed");
      });
    }
  })
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

// ─── Trust proxy ────────────────────────────────────────────────────────────
// Resolution: operator-set TRUST_PROXY wins; otherwise proxy mode auto-defaults
// to "1" (first-hop trust); otherwise unset (direct-to-internet, no X-Forwarded-*
// honored — required for that mode because clients can otherwise spoof their IP
// and bypass the login rate limiter). See src/utils/trustProxy.ts.
const trustProxy = resolveTrustProxy();
if (trustProxy !== undefined) {
  app.set("trust proxy", /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy);
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
        // fetch, so they don't appear in connectSrc.
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.tile.openstreetmap.org",
          "https://tile.openstreetmap.org",
          "https://*.basemaps.cartocdn.com",
          // RainViewer precipitation-radar tiles for the Site Map widget's
          // weather overlay (loaded as <img>, served from tilecache.rainviewer.com).
          "https://*.rainviewer.com",
        ],
        // The Google Fonts hosts are fetch()ed (not just <link>-loaded) by the
        // asset-details Screenshot button: html-to-image inlines the page's
        // webfonts (CSS from fonts.googleapis.com, woff2 from fonts.gstatic.com)
        // into its DOM snapshot as data: URLs so the captured PNG renders in
        // Inter/Roboto Mono. Capture degrades gracefully to fallback fonts when
        // these hosts are unreachable (e.g. no-internet deployments).
        connectSrc: [
          "'self'",
          "https://fonts.googleapis.com",
          "https://fonts.gstatic.com",
          // Site Map widget weather overlay: RainViewer radar frame index +
          // Open-Meteo current-temperature lookups (both fetch()ed). Sends
          // only approximate site lat/long; degrades gracefully when offline.
          "https://api.rainviewer.com",
          "https://api.open-meteo.com",
        ],
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

// HTTP → HTTPS redirect lived here in pre-Phase-4 Node-HTTPS mode. After
// Phase 4, nginx owns redirects (configured in deploy/nginx/polaris.conf
// via the optional `listen 80;` server block operators can enable); local
// dev runs HTTP-only on 127.0.0.1 so there's nothing to redirect from.

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
// `Mobile` covers Chrome/Firefox on phones (including every Android phone
// browser — Android phone UAs always carry the `Mobile` token, which is
// also why the old `Android.*Mobile` alternative was redundant and a
// polynomial-ReDoS hazard on attacker-supplied UA strings), and
// `iPhone`/`iPod` covers Safari on iPhone. iPad is intentionally excluded —
// modern iPad Safari requests desktop layouts by default, and the desktop
// UI works fine on a tablet-class screen.
const PHONE_UA_REGEX = /(Mobile|iPhone|iPod)/i;
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
const protectedPages = ["/", "/index.html", "/ipam.html", "/blocks.html", "/subnets.html", "/reservations.html", "/users.html", "/integrations.html", "/assets.html", "/events.html", "/notifications.html", "/server-settings.html", "/map.html"];

// Page-level gating — each protected page requires at least `read` on the
// matching function key. Maps to the same matrix the API guards use, so
// hiding a page also hides the API surface it consumes. A user without
// the requisite permission bounces to "/". Pages not in the map are
// reachable to any authenticated user (the per-tile cards / API requests
// handle their own permission state).
const pageRequiredPermission: Record<string, { key: string; level: "read" | "write" }> = {
  "/users.html":           { key: "users",                level: "read" },
  "/integrations.html":    { key: "integrations",         level: "read" },
  "/notifications.html":   { key: "notifications",        level: "read" },
  "/server-settings.html": { key: "serverSettingsSystem", level: "read" },
};
const PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 } as const;
app.use(async (req, res, next) => {
  if (!protectedPages.includes(req.path)) return next();
  if (!req.session?.userId) {
    // Skip login page: redirect unauthenticated users straight to SSO. Honors
    // either configured provider — SAML (Azure) takes precedence, OIDC is the
    // fallback. The flag is only ever set by an SSO-authenticated admin (see
    // the guard on PUT /auth/azure/settings), so reaching here means at least
    // one of these branches resolves; the final /login.html catch covers the
    // edge case where SSO was torn down after the flag was set.
    const settings = await getSsoSettings().catch(() => ({ skipLoginPage: false }));
    if (settings.skipLoginPage) {
      if (await isAzureSsoConfiguredAsync()) {
        return res.redirect("/api/v1/auth/azure/login?prompt=none");
      }
      if (await isOidcEnabled()) {
        return res.redirect("/api/v1/auth/oidc/login");
      }
    }
    return res.redirect("/login.html");
  }
  const required = pageRequiredPermission[req.path];
  if (required) {
    // Old-session self-heal: a session issued before the dynamic-roles
    // cutover has `userId` but no `roleSnapshot`, so the lookup below
    // would silently return "none" and bounce the operator home. Defer
    // to `ensureRoleSnapshot` which loads the user's role from
    // DB and stamps the session in place. One DB hit per surviving old
    // session; the snapshot path is hot after that.
    const { ensureRoleSnapshot } = await import("./api/middleware/permissions.js");
    const snap = await ensureRoleSnapshot(req).catch(() => null);
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
  // database doesn't have (or vice versa). Runs before listen() in EVERY role
  // so a broken deploy doesn't run workers against a mismatched schema either.
  await runSchemaSanityCheck();

  // Non-HTTP roles (monitor / discovery) don't bind a port — their pg-boss
  // workers + intervals (started at module load) keep the event loop alive.
  if (!cfg.runsHttp) {
    logger.info({ role: cfg.role }, "Non-HTTP role — skipping Express listen; running workers only");
    return;
  }

  // Phase 4: Node HTTPS is gone. Polaris always listens HTTP-only.
  //   - Proxy mode (POLARIS_PROXY_CERT_PATH set): nginx terminates TLS on
  //     443 and proxies to 127.0.0.1:PORT — bind localhost-only so nothing
  //     else on the network can reach us.
  //   - "all" mode (POLARIS_ROLE unset, npm run dev): bind all interfaces
  //     on PORT for dev ergonomics. No HTTPS, no cert, no Setting.https.
  // PORT picks env override > 3000 default; no more Setting.https.httpPort
  // fallback since the Setting key was retired in this same release.
  const PORT_RAW = process.env.PORT ?? 3000;
  const PORT = typeof PORT_RAW === "number" ? PORT_RAW : Number.parseInt(String(PORT_RAW), 10) || 3000;
  const httpServer = isProxyMode()
    ? app.listen(PORT, "127.0.0.1", () => {
        logger.info({ port: PORT, bind: "127.0.0.1" }, "Polaris server listening (proxy mode)");
      })
    : app.listen(PORT, () => {
        logger.info({ port: PORT }, "Polaris server listening (dev / all-role HTTP-only)");
      });
  // Attach the Polaris Agent WebSocket upgrade handler. Same server
  // surface as the REST API — agents reach /api/v1/agents/ws over the
  // same port and (in production) the same HTTPS cert their pin verifies.
  const { attachAgentWsUpgradeHandler } = await import("./api/routes/agentsWs.js");
  attachAgentWsUpgradeHandler(httpServer);
}

/**
 * Dynamically import the background-job modules appropriate to this role.
 * Importing a job module runs its self-start side effect, so gating the
 * imports is what gates the jobs. All singleton schedulers + one-shot
 * migrations are pinned to the web/all role (runsSchedulers / runsMigrations);
 * monitor and discovery roles import none of them. Order mirrors the historical
 * static-import order; each job's own async work runs concurrently as before.
 */
async function startBackgroundJobs(cfg: RoleConfig): Promise<void> {
  const importJob = async (path: string): Promise<void> => {
    try { await import(path); }
    catch (err: any) { logger.warn({ err: err?.message, job: path }, "background job import failed"); }
  };

  if (cfg.runsMigrations) {
    // One-shot startup migrations / seeds / backfills — idempotent, marker-keyed.
    for (const p of [
      "./jobs/normalizeManufacturers.js",
      "./jobs/seedAssetTypes.js",
      "./jobs/seedManufacturerProfiles.js",
      "./jobs/backfillManufacturerProfileMemoryComposition.js",
      "./jobs/migrateMonitorSettingsHierarchy.js",
      "./jobs/renameMonitorClassKeys.js",
      "./jobs/migrateSampleRetentionToEntities.js",
      "./jobs/migrateMonitorStatusRename.js",
      "./jobs/migrateAutoMonitorInterfacesShape.js",
      "./jobs/migrateSystemInfoCadenceLinkage.js",
      "./jobs/migrateMonitorSettingsPerClass.js",
      "./jobs/backfillAssetSources.js",
      "./jobs/scrubLegacySidGuidTags.js",
      "./jobs/backfillFortigateEndpointSources.js",
      "./jobs/fixInfraAssetTypes.js",
      "./jobs/mergeFortiswitchEndpointGhosts.js",
      "./jobs/backfillDependencyTree.js",
      "./jobs/backfillMonitorStatusChangedAt.js",
      "./jobs/rasterizeStoredSvgIcons.js",
      "./jobs/clampAssetAcquiredAt.js",
      "./jobs/bootstrapProxyConfig.js",
    ]) await importJob(p);
  }

  if (cfg.runsSchedulers) {
    // Periodic schedulers + reconcilers — singletons; the monitor PRODUCER
    // (monitorAssets) lives here too (it publishes work the monitor-role
    // consumers drain; in cursor mode it runs the in-process loop).
    for (const p of [
      "./jobs/monitorAssets.js",
      "./jobs/expireReservations.js",
      "./jobs/pruneEvents.js",
      "./jobs/ouiRefresh.js",
      "./jobs/updateCheck.js",
      "./jobs/discoverySlowCheck.js",
      "./jobs/decommissionStaleAssets.js",
      "./jobs/flagStaleReservations.js",
      "./jobs/capacityWatch.js",
      "./jobs/hostMetricsCollector.js",
      "./jobs/evaluateNotificationRules.js",
      "./jobs/escalateNotifications.js",
      "./jobs/deliverNotifications.js",
      "./jobs/resolvePolarisPushedConflicts.js",
      "./jobs/resolveStaleReservationConflicts.js",
      "./jobs/cleanupStaleDnsResolvedReleased.js",
      "./jobs/mergeDuplicateHostnameAssets.js",
      "./jobs/dependencyReconciler.js",
      "./jobs/retryQueuedReservationPushes.js",
      "./jobs/reconcileMapRegions.js",
      "./jobs/reconcileTagAssignments.js",
      "./jobs/reconcileDnsResolvedReservations.js",
      "./jobs/runSampleRollup.js",
      "./jobs/reclaimBloatedChunks.js",
      "./jobs/autoBuildAgents.js",
      "./jobs/discoveryRunReaper.js",
      // integrationConnectionTester DISABLED 2026-06-02: the 10-min synthetic
      // /sys/status probe fired false-positive `integration.test.failed`
      // warnings on FMG (a transient RPC -11 "no valid session" — session reap
      // or a concurrent call on the shared API-key session — which the tester
      // hardcodes to "Invalid or expired API token" and stamps as lastTestOk=
      // false). A manual Test Connection seconds later always succeeds. Probe
      // disabled here (file kept) pending the planned removal + health-derived-
      // from-real-discovery-traffic redesign. NOTE: with the probe off, nothing
      // auto-refreshes lastTestOk — a stuck `false` must be cleared by one
      // manual Test Connection (discovery scheduler still gates on lastTestOk).
      // "./jobs/integrationConnectionTester.js",
    ]) await importJob(p);
    // discoveryScheduler exports an explicit starter (it was refactored off the
    // self-start pattern so the discovery worker handler can be injected).
    startDiscoveryScheduler();
  }
}

export { app };
