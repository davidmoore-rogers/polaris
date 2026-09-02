/**
 * tests/integration/apiDocsGate.test.ts — the /api docs page source-IP gate
 *
 * End-to-end over the real app: the three gated paths (/api, /api/, /api.html
 * — the last because express.static would otherwise serve public/api.html
 * ungated), the loopback-always-allowed rule, off-means-off (disabled drops
 * even the loopback caller — the one drop this suite CAN exercise, since the
 * supertest socket is loopback and loopback survives every enabled scope),
 * and the invariant that /api/v1 API traffic never touches the gate.
 *
 * Source simulation follows loginAccessGate.test.ts: no trust proxy, so
 * req.ip is always the loopback socket peer. The public-source deny matrix is
 * unit-level (docsSourceAllowed in apiDocsAccessService.test.ts). Skips
 * cleanly when DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import {
  saveApiDocsSettings,
  invalidateApiDocsSettingsCache,
  type ApiDocsSettings,
} from "../../src/services/apiDocsAccessService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

async function setScope(input: Partial<ApiDocsSettings>): Promise<void> {
  await saveApiDocsSettings(input);
  invalidateApiDocsSettingsCache();
}

const DOCS_PATHS = ["/api", "/api/", "/api.html"] as const;

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await setScope({ enabled: true, ipScope: "rfc1918", allowedCidrs: [] });
});

afterAll(async () => {
  if (!dbReachable) return;
  await setScope({ enabled: true, ipScope: "rfc1918", allowedCidrs: [] });
});

d("default posture (enabled, rfc1918)", () => {
  it("serves the docs page on all three gated paths, as no-store HTML", async () => {
    await setScope({ enabled: true, ipScope: "rfc1918", allowedCidrs: [] });
    for (const path of DOCS_PATHS) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain("Polaris API documentation");
    }
    // The /api handler's own no-store (the /api.html copy rides static with
    // its own cache headers; the gate, not caching, is its control).
    const bare = await request(app).get("/api");
    expect(bare.headers["cache-control"]).toBe("no-store");
  });

  it("keeps the docs page out of search engines", async () => {
    const res = await request(app).get("/api");
    expect(res.text).toContain('name="robots" content="noindex, nofollow"');
  });
});

d("loopback is always allowed while enabled", () => {
  it("serves the loopback caller even under a custom scope that does not list loopback", async () => {
    await setScope({ enabled: true, ipScope: "custom", allowedCidrs: ["10.99.99.0/24"] });
    const res = await request(app).get("/api");
    expect(res.status).toBe(200);
  });

  it("serves the loopback caller under the loopback-only scope", async () => {
    await setScope({ enabled: true, ipScope: "loopback", allowedCidrs: [] });
    const res = await request(app).get("/api");
    expect(res.status).toBe(200);
  });
});

d("disabled — off means off", () => {
  it("DROPS all three paths rather than answering, even for loopback", async () => {
    await setScope({ enabled: false });
    for (const path of DOCS_PATHS) {
      // Socket destroyed, no HTTP response — supertest surfaces a transport
      // error. A 403 here would confirm the surface exists.
      await expect(request(app).get(path)).rejects.toBeTruthy();
    }
  });

  it("leaves /api/v1 API traffic completely alone", async () => {
    await setScope({ enabled: false });
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });

  it("leaves other static pages alone — only the docs paths are gated", async () => {
    await setScope({ enabled: false });
    const res = await request(app).get("/login.html");
    expect(res.status).toBe(200);
  });
});

d("settings routes (/server-settings/api-docs)", () => {
  it("GET returns the settings and the caller's resolved IP", async () => {
    await setScope({ enabled: true, ipScope: "rfc1918", allowedCidrs: [] });
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/server-settings/api-docs");
    expect(res.status).toBe(200);
    expect(res.body.apiDocs).toEqual({ enabled: true, ipScope: "rfc1918", allowedCidrs: [] });
    expect(typeof res.body.callerIp).toBe("string");
    expect(res.body.callerIp.length).toBeGreaterThan(0);
  });

  it("PUT rejects a public CIDR with a message naming it", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .put("/api/v1/server-settings/api-docs")
      .set("X-CSRF-Token", csrf)
      .send({ ipScope: "custom", allowedCidrs: ["8.8.8.0/24"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("8.8.8.0/24");
    expect(res.body.error).toContain("RFC1918");
  });

  it("PUT rejects an unknown scope value at the schema layer", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .put("/api/v1/server-settings/api-docs")
      .set("X-CSRF-Token", csrf)
      .send({ ipScope: "all" });
    expect(res.status).toBe(400);
  });

  it("PUT accepts a private scope and reports callerAllowed + nginx sync state", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .put("/api/v1/server-settings/api-docs")
      .set("X-CSRF-Token", csrf)
      .send({ enabled: true, ipScope: "custom", allowedCidrs: ["10.50.1.7/16"] });
    expect(res.status).toBe(200);
    // Normalized: host bits zeroed.
    expect(res.body.apiDocs.allowedCidrs).toEqual(["10.50.0.0/16"]);
    // The supertest caller is loopback — always allowed while enabled.
    expect(res.body.callerAllowed).toBe(true);
    // Not proxy mode in tests → the nginx sync is skipped, not failed.
    expect(res.body.nginx).toEqual({ attempted: false });
    invalidateApiDocsSettingsCache();
  });

  it("PUT warns (never refuses) when disabling — callerAllowed false, save persisted", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .put("/api/v1/server-settings/api-docs")
      .set("X-CSRF-Token", csrf)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.callerAllowed).toBe(false);
    invalidateApiDocsSettingsCache();
    const read = await agent.get("/api/v1/server-settings/api-docs");
    expect(read.body.apiDocs.enabled).toBe(false);
  });
});
