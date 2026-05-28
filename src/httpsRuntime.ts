/**
 * src/httpsRuntime.ts — owns the Node HTTPS listener and its hot-rotation.
 *
 * This file is the LISTENER half of the former `httpsManager.ts`. The
 * cert-reading + parsing + caching half lives in `services/certInfo.ts` so
 * Phase 4's listener removal can be a clean delete without taking the
 * fingerprint reader with it.
 *
 * Proxy-mode behavior (POLARIS_PROXY_CERT_PATH set):
 *   - `initHttps()` returns immediately — no listener binds.
 *   - `applyHttps()` returns an "externally managed" result without doing work.
 *   - `stopHttps()` is a no-op.
 *   - `httpsRedirectMiddleware` passes through (nginx handles HTTP→HTTPS).
 *   - `isHttpsRunning()` returns `true` — HTTPS reachability IS real; we
 *     just aren't the process terminating it. Callers that meant "is Polaris
 *     reachable over HTTPS?" keep working unchanged. Callers that meant "is
 *     Node owning the listener?" must use `isHttpsExternallyManaged()`.
 *   - `getHttpsPort()` returns the port parsed from `POLARIS_PUBLIC_URL`
 *     (defaulting to 443 if no explicit port). This preserves the contract
 *     for `agentInstallService.inferOwnServerUrl()` etc.
 */

import https from "node:https";
import { constants as tlsConstants } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { getHttpsSettings, resolveHttpsCertificates } from "./services/serverSettingsService.js";
import { setRuntimeCertPem, clearRuntimeCertPem } from "./services/certInfo.js";
import { isProxyMode } from "./utils/proxyMode.js";
import { logger } from "./utils/logger.js";

let httpsServer: https.Server | null = null;
let expressApp: Express | null = null;
let redirectEnabled = false;
let httpsPort = 3443;

export function initHttps(app: Express): void {
  if (isProxyMode()) {
    // nginx terminates TLS — Polaris listens HTTP-only. Nothing to do here.
    return;
  }
  expressApp = app;
  applyHttps();
}

/**
 * Express middleware — mount early in app.ts.
 * When redirect is enabled and HTTPS is running, redirects HTTP → HTTPS.
 * In proxy mode this is a no-op: nginx owns HTTP→HTTPS redirection.
 */
export function httpsRedirectMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isProxyMode()) return next();
  if (!redirectEnabled || !httpsServer?.listening) return next();
  // Already HTTPS (behind a proxy or direct)
  if (req.secure || req.headers["x-forwarded-proto"] === "https") return next();
  // Skip API so admin can still manage settings over HTTP
  if (req.path.startsWith("/api/")) return next();
  const host = (req.headers.host || "localhost").replace(/:\d+$/, "");
  const target = `https://${host}${httpsPort === 443 ? "" : ":" + httpsPort}${req.originalUrl}`;
  res.redirect(301, target);
}

export async function applyHttps(): Promise<{ ok: boolean; message: string }> {
  if (isProxyMode()) {
    return {
      ok: false,
      message: "Polaris is fronted by an external proxy; cert is managed externally (POLARIS_PROXY_CERT_PATH)",
    };
  }

  const settings = await getHttpsSettings();
  httpsPort = settings.port;

  if (!settings.enabled) {
    redirectEnabled = false;
    clearRuntimeCertPem();
    await stopHttps();
    return { ok: true, message: "HTTPS disabled" };
  }

  const tlsData = await resolveHttpsCertificates();
  if (!tlsData) {
    clearRuntimeCertPem();
    await stopHttps();
    return { ok: false, message: "HTTPS enabled but certificate or key is missing" };
  }
  // Hand the leaf cert PEM to certInfo so getServerCertFingerprint() etc. can
  // hash it without reaching into Node's TLS internals.
  setRuntimeCertPem(tlsData.cert);

  const opts: https.ServerOptions = {
    cert: tlsData.cert,
    key: tlsData.key,
    minVersion: "TLSv1.2",
    // Disable known-insecure ciphers; allow only AEAD suites for TLS 1.2
    // TLS 1.3 cipher suites are always secure and managed by Node.js automatically
    ciphers: [
      "TLS_AES_256_GCM_SHA384",
      "TLS_CHACHA20_POLY1305_SHA256",
      "TLS_AES_128_GCM_SHA256",
      "ECDHE-ECDSA-AES256-GCM-SHA384",
      "ECDHE-RSA-AES256-GCM-SHA384",
      "ECDHE-ECDSA-CHACHA20-POLY1305",
      "ECDHE-RSA-CHACHA20-POLY1305",
      "ECDHE-ECDSA-AES128-GCM-SHA256",
      "ECDHE-RSA-AES128-GCM-SHA256",
    ].join(":"),
    honorCipherOrder: true,
    secureOptions:
      tlsConstants.SSL_OP_NO_SSLv2 |
      tlsConstants.SSL_OP_NO_SSLv3 |
      tlsConstants.SSL_OP_NO_TLSv1 |
      tlsConstants.SSL_OP_NO_TLSv1_1 |
      tlsConstants.SSL_OP_NO_RENEGOTIATION,
  };
  if (tlsData.ca.length > 0) {
    opts.ca = tlsData.ca;
  }

  // If already running, update TLS context without full restart
  if (httpsServer && httpsServer.listening) {
    try {
      httpsServer.setSecureContext(opts);
      // If port changed, need full restart
      const addr = httpsServer.address();
      if (addr && typeof addr === "object" && addr.port !== settings.port) {
        await stopHttps();
        return startHttps(opts, settings.port);
      }
      redirectEnabled = settings.redirectHttp;
      logger.info("HTTPS certificate updated (hot reload)");
      return { ok: true, message: `HTTPS certificate updated on port ${settings.port}` };
    } catch (err: any) {
      logger.error({ err }, "Failed to update HTTPS context, restarting");
      await stopHttps();
    }
  }

  const result = await startHttps(opts, settings.port);
  // Only enable redirect after HTTPS is confirmed running
  redirectEnabled = settings.redirectHttp && result.ok;
  return result;
}

function startHttps(
  opts: https.ServerOptions,
  port: number,
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    if (!expressApp) {
      resolve({ ok: false, message: "Express app not initialized" });
      return;
    }

    httpsServer = https.createServer(opts, expressApp);

    httpsServer.on("error", (err: any) => {
      logger.error({ err }, "HTTPS server error");
      if (err.code === "EADDRINUSE") {
        resolve({ ok: false, message: `Port ${port} is already in use` });
      } else if (err.code === "ERR_SSL_NO_PRIVATE_KEY" || err.message?.includes("key")) {
        resolve({ ok: false, message: "Invalid private key" });
      } else {
        resolve({ ok: false, message: err.message || "HTTPS server error" });
      }
    });

    httpsServer.listen(port, () => {
      logger.info({ port }, "HTTPS server listening");
      // Same Polaris Agent WS handler we attach to the HTTP server gets
      // mounted on HTTPS as well — that's how production talks to agents
      // (the agent's pinned cert IS this server's cert).
      void import("./api/routes/agentsWs.js").then((mod) => {
        mod.attachAgentWsUpgradeHandler(httpsServer!);
      }).catch((err) => logger.warn({ err }, "Failed to attach agent WS handler to HTTPS server"));
      resolve({ ok: true, message: `HTTPS server listening on port ${port}` });
    });
  });
}

async function stopHttps(): Promise<void> {
  if (!httpsServer) return;
  clearRuntimeCertPem();
  return new Promise((resolve) => {
    httpsServer!.close(() => {
      logger.info("HTTPS server stopped");
      httpsServer = null;
      resolve();
    });
    // Force-close idle connections after a short grace period
    setTimeout(() => {
      if (httpsServer) {
        httpsServer.closeAllConnections?.();
      }
    }, 2000);
  });
}

/**
 * "Is Polaris reachable over HTTPS?" — true in proxy mode (nginx terminates,
 * agents pin nginx's cert) and true when Node owns the listener and it's
 * actively listening. Callers that semantically meant "does Node own the
 * HTTPS listener?" must use {@link isHttpsExternallyManaged} instead.
 */
export function isHttpsRunning(): boolean {
  if (isProxyMode()) return true;
  return httpsServer !== null && httpsServer.listening;
}

/**
 * Companion to {@link isHttpsRunning}. Returns `true` ONLY in proxy mode,
 * signalling that TLS termination is owned by an external reverse proxy.
 * Use this when the answer to "should Polaris try to mutate cert state?"
 * matters — cert upload, hot-rotate, listener-restart paths must NOT do
 * any work when this returns true.
 */
export function isHttpsExternallyManaged(): boolean {
  return isProxyMode();
}

/**
 * Current HTTPS-reachable port. In Node-HTTPS mode this is whatever port
 * the listener is bound to. In proxy mode it's parsed from POLARIS_PUBLIC_URL
 * (defaulting to 443 if no explicit port), which is the port nginx exposes —
 * that's the right answer for agentInstallService.inferOwnServerUrl() etc.
 * which want a port to embed in agent.conf's server_url.
 */
export function getHttpsPort(): number | null {
  if (isProxyMode()) {
    const raw = process.env.POLARIS_PUBLIC_URL;
    if (!raw) return null; // validateRuntimeConfiguration() prevents this at boot
    try {
      const u = new URL(raw);
      if (u.port) return Number(u.port);
      return u.protocol === "https:" ? 443 : 80;
    } catch {
      return null;
    }
  }
  if (!httpsServer || !httpsServer.listening) return null;
  return httpsPort;
}
