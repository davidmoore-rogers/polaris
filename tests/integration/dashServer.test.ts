/**
 * tests/integration/dashServer.test.ts
 *
 * The Dash wallboard listener's access-control chain, exercised via supertest
 * against buildDashApp() with injected settings/identity providers (no DB):
 *   - operator kill-switch: disabled ⇒ 403 everywhere
 *   - source-IP gate: loopback socket passes; a public X-Forwarded-For is
 *     honored (403) only under proxy-mode trust, ignored otherwise
 *   - rfc1918Only=false widens to any source
 *   - GET/HEAD-only: writes 405 app-wide
 *   - exact-path API allowlist: unlisted paths 404 before touching a router
 *   - synthetic /auth/me: readonly-role identity in the real /auth/me shape
 *   - headers: CSP present, Cache-Control: no-store on API responses
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { buildDashApp } from "../../src/dash/dashServer.js";
import type { DashSettings } from "../../src/services/dashSettingsService.js";
import type { DashRoleIdentity } from "../../src/services/dashRoleSnapshotService.js";

const savedCert = process.env.POLARIS_PROXY_CERT_PATH;

beforeEach(() => {
  delete process.env.POLARIS_PROXY_CERT_PATH;
});

afterEach(() => {
  if (savedCert === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
  else process.env.POLARIS_PROXY_CERT_PATH = savedCert;
});

const READONLY_IDENTITY: DashRoleIdentity = {
  snapshot: {
    id: "role-readonly-id",
    name: "readonly",
    isProtected: true,
    permissions: { assets: "read", events: "read", ipBlocks: "read", reservations: "read" },
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  regionTags: [],
};

function buildApp(opts: { settings?: Partial<DashSettings>; proxyMode?: boolean } = {}) {
  if (opts.proxyMode) {
    // Must be set BEFORE buildDashApp so resolveTrustProxy() returns "1"
    // and X-Forwarded-For is honored for req.ip. Restored by afterEach.
    process.env.POLARIS_PROXY_CERT_PATH = "/tmp/proxy-mode-marker-file";
  }
  const settings: DashSettings = { enabled: true, rfc1918Only: true, ...opts.settings };
  return buildDashApp({
    settingsProvider: async () => settings,
    identityProvider: async () => READONLY_IDENTITY,
  });
}

describe("operator kill-switch", () => {
  it("403s everything when disabled", async () => {
    const app = buildApp({ settings: { enabled: false } });
    for (const path of ["/dash", "/dash/api/v1/auth/me", "/js/api.js"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
      expect(res.body.error ?? res.text).toMatch(/disabled/i);
    }
  });
});

describe("source-IP gate", () => {
  it("passes the loopback test socket through", async () => {
    const res = await request(buildApp()).get("/dash/api/v1/auth/me");
    expect(res.status).toBe(200);
  });

  it("honors a public X-Forwarded-For under proxy-mode trust → 403", async () => {
    const res = await request(buildApp({ proxyMode: true }))
      .get("/dash/api/v1/auth/me")
      .set("X-Forwarded-For", "203.0.113.5");
    expect(res.status).toBe(403);
    expect(res.body.error ?? res.text).toMatch(/private networks only/i);
  });

  it("honors a private X-Forwarded-For under proxy-mode trust → 200", async () => {
    const res = await request(buildApp({ proxyMode: true }))
      .get("/dash/api/v1/auth/me")
      .set("X-Forwarded-For", "192.168.4.20");
    expect(res.status).toBe(200);
  });

  it("ignores a spoofed X-Forwarded-For without trust proxy (socket IP wins) → 200", async () => {
    const res = await request(buildApp())
      .get("/dash/api/v1/auth/me")
      .set("X-Forwarded-For", "203.0.113.5");
    expect(res.status).toBe(200);
  });

  it("serves any source when rfc1918Only is off", async () => {
    const res = await request(buildApp({ proxyMode: true, settings: { rfc1918Only: false } }))
      .get("/dash/api/v1/auth/me")
      .set("X-Forwarded-For", "203.0.113.5");
    expect(res.status).toBe(200);
  });
});

describe("read-only enforcement", () => {
  it("405s every write verb", async () => {
    const app = buildApp();
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const res = await request(app)[method]("/dash/api/v1/dashboard/summary");
      expect(res.status).toBe(405);
      expect(res.body.error ?? res.text).toMatch(/read-only/i);
    }
  });
});

describe("API path allowlist", () => {
  it("404s paths outside the allowlist without reaching a router", async () => {
    const app = buildApp();
    for (const path of [
      "/dash/api/v1/reservations/some-id",
      "/dash/api/v1/reservations",
      "/dash/api/v1/assets",
      "/dash/api/v1/users",
      "/dash/api/v1/me/dashboard",
      "/dash/api/v1/server-settings/pg-tuning",
      "/dash/api/v1/map/regions",
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
    }
  });
});

describe("synthetic /auth/me", () => {
  it("returns the readonly-role identity in the real /auth/me shape", async () => {
    const res = await request(buildApp()).get("/dash/api/v1/auth/me");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      authenticated: true,
      username: "dash",
      authProvider: "local",
      role: {
        name: "readonly",
        isProtected: true,
        permissions: { assets: "read" },
        color: null,
      },
    });
    expect(res.body.regionTags).toEqual({ user: [], role: [], group: [], effective: [] });
    expect(res.body.otherTags).toEqual({ user: [], role: [], group: [], effective: [] });
  });
});

describe("headers", () => {
  it("sends the shared CSP and no-store on API responses", async () => {
    const res = await request(buildApp()).get("/dash/api/v1/auth/me");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("https://api.open-meteo.com");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("serves the wallboard page with no-store", async () => {
    const res = await request(buildApp()).get("/dash");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toContain("text/html");
  });
});
