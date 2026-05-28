/**
 * tests/integration/security-middleware-behind-proxy.test.ts
 *
 * Asserts the Express security middleware chain behaves correctly when
 * Polaris is fronted by an external reverse proxy that injects
 * X-Forwarded-* headers:
 *  - req.secure is true when X-Forwarded-Proto: https arrives + trust proxy is set
 *  - req.ip reflects the real client IP from X-Forwarded-For (not nginx)
 *  - Set-Cookie carries the Secure flag on session-style cookies (cookie.secure: "auto")
 *  - helmet's HSTS + CSP + X-Content-Type-Options are present on responses
 *  - compression middleware still gzips when Accept-Encoding: gzip
 *
 * Focused test: spins up a minimal Express app with the same security
 * middleware stack Polaris uses (helmet, compression, session-like cookie,
 * trust proxy via resolveTrustProxy). No DB, no full app boot — fast and
 * deterministic. The full Polaris app's wiring of the same middleware is
 * asserted by the existing test suite running unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import compression from "compression";
import request from "supertest";
import { resolveTrustProxy } from "../../src/utils/trustProxy.js";

const savedCert = process.env.POLARIS_PROXY_CERT_PATH;

beforeEach(() => {
  delete process.env.POLARIS_PROXY_CERT_PATH;
});

afterEach(() => {
  if (savedCert === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
  else process.env.POLARIS_PROXY_CERT_PATH = savedCert;
});

function buildApp(opts: { proxyMode: boolean }) {
  if (opts.proxyMode) {
    // Set the env BEFORE resolveTrustProxy() so it sees proxy mode and
    // returns "1". The afterEach hook restores env between tests so this
    // doesn't leak into siblings.
    process.env.POLARIS_PROXY_CERT_PATH = "/tmp/proxy-mode-marker-file";
  }
  const app = express();
  const tp = resolveTrustProxy();
  if (tp !== undefined) app.set("trust proxy", /^\d+$/.test(String(tp)) ? Number(tp) : tp);

  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"] } },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }));
  app.use(compression());
  app.use(session({
    secret: "test-secret-not-for-prod",
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, secure: "auto", sameSite: "lax", maxAge: 60000 },
  }));

  app.get("/probe", (req, res) => {
    res.json({
      secure:          req.secure,
      ip:              req.ip,
      protocol:        req.protocol,
      xForwardedProto: req.headers["x-forwarded-proto"] || null,
      xForwardedFor:   req.headers["x-forwarded-for"] || null,
    });
  });

  app.get("/large", (_req, res) => {
    // Large enough to be worth compressing (well above compression's 1024-byte threshold).
    res.json({ payload: "x".repeat(2000) });
  });

  return app;
}

describe("Security middleware behind a reverse proxy", () => {
  it("req.secure is true when X-Forwarded-Proto=https arrives in proxy mode", async () => {
    const app = buildApp({ proxyMode: true });
    const resp = await request(app)
      .get("/probe")
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-For", "203.0.113.5");
    expect(resp.status).toBe(200);
    expect(resp.body.secure).toBe(true);
    expect(resp.body.protocol).toBe("https");
    expect(resp.body.ip).toBe("203.0.113.5");
  });

  it("req.secure is false in proxy mode when X-Forwarded-Proto is missing (nginx misconfig)", async () => {
    const app = buildApp({ proxyMode: true });
    const resp = await request(app).get("/probe");
    expect(resp.body.secure).toBe(false);
  });

  it("session cookie carries Secure flag when X-Forwarded-Proto=https is honored", async () => {
    const app = buildApp({ proxyMode: true });
    const resp = await request(app)
      .get("/probe")
      .set("X-Forwarded-Proto", "https");
    const setCookie = resp.headers["set-cookie"];
    const joined = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie || "");
    expect(joined).toMatch(/Secure/i);
  });

  it("session cookie does NOT carry Secure flag when proxy mode is off (plain HTTP boot)", async () => {
    const app = buildApp({ proxyMode: false });
    const resp = await request(app).get("/probe").set("X-Forwarded-Proto", "https");
    // No trust proxy in non-proxy mode → req.secure remains false → cookie.secure:"auto" doesn't flip.
    const setCookie = resp.headers["set-cookie"];
    const joined = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie || "");
    expect(joined).not.toMatch(/Secure/i);
  });

  it("Strict-Transport-Security header is present on every response", async () => {
    const app = buildApp({ proxyMode: true });
    const resp = await request(app).get("/probe").set("X-Forwarded-Proto", "https");
    expect(resp.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(resp.headers["strict-transport-security"]).toMatch(/includeSubDomains/);
  });

  it("Content-Security-Policy header includes script-src 'self'", async () => {
    const app = buildApp({ proxyMode: true });
    const resp = await request(app).get("/probe").set("X-Forwarded-Proto", "https");
    expect(resp.headers["content-security-policy"]).toMatch(/script-src 'self'/);
  });

  it("X-Content-Type-Options: nosniff is set", async () => {
    const app = buildApp({ proxyMode: true });
    const resp = await request(app).get("/probe").set("X-Forwarded-Proto", "https");
    expect(resp.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("compression middleware gzips large responses with Accept-Encoding: gzip", async () => {
    const app = buildApp({ proxyMode: true });
    const resp = await request(app)
      .get("/large")
      .set("X-Forwarded-Proto", "https")
      .set("Accept-Encoding", "gzip");
    expect(resp.headers["content-encoding"]).toBe("gzip");
  });
});
