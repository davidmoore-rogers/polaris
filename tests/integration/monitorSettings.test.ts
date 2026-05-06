/**
 * tests/integration/monitorSettings.test.ts
 *
 * Integration coverage for the polling-method redesign — the four-tier
 * monitor-settings hierarchy (per-asset → class override → integration tier
 * or manual tier → source default) plus the compatibility matrix.
 *
 * Requires a running PostgreSQL pointed to by DATABASE_URL. Spin one up
 * with `docker compose up -d db`, or run against the dev DB.
 *
 * The tests share a single Express agent per `describe` block so cookies
 * (session + CSRF token) persist across requests; per-test cleanup wipes
 * the rows the suite touches without nuking the user account.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";

const TEST_USERNAME = "polaris-monset-tester";
const TEST_PASSWORD = "test-password-do-not-use-in-prod";

// Probe DB reachability at file-load time so we can cleanly skip the whole
// suite in environments where DATABASE_URL is unset (CI without the dev DB)
// or set but unreachable (offline laptop). When the probe fails we use
// `describe.skip` so vitest reports the suite as skipped rather than red —
// the integration tests are valuable when the DB is available and a no-op
// otherwise.
const dbReachable = await (async () => {
  if (!process.env.DATABASE_URL) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

const d = dbReachable ? describe : describe.skip;

if (!dbReachable) {
  // eslint-disable-next-line no-console
  console.warn("[monitorSettings.test] Skipped — DATABASE_URL not set or DB unreachable.");
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  // Idempotent admin user — created once for the whole file.
  await prisma.user.deleteMany({ where: { username: TEST_USERNAME } });
  await prisma.user.create({
    data: {
      username:     TEST_USERNAME,
      passwordHash: await hashPassword(TEST_PASSWORD),
      role:         "admin",
      authProvider: "local",
    },
  });
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.user.deleteMany({ where: { username: TEST_USERNAME } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Clean state for the polling-redesign surface area. Order matters for FKs:
  // class overrides reference Integration; assets reference Integration;
  // events / settings stand alone.
  await prisma.monitorClassOverride.deleteMany();
  await prisma.assetMonitorSample.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.integration.deleteMany();
  await prisma.setting.deleteMany({
    where: { key: { in: ["manualMonitorSettings", "monitorSettings", "monitorSettingsHierarchyMigratedAt"] } },
  });
  await prisma.event.deleteMany({
    where: { action: { startsWith: "monitor_settings." } },
  });
});

// ─── Test helpers ──────────────────────────────────────────────────────────

/**
 * Build a logged-in supertest agent for the test admin user. The agent
 * holds the session cookie + the polaris_csrf cookie across requests; the
 * returned `csrf` string is what mutating requests must echo in the
 * `X-CSRF-Token` header.
 */
async function authedAgent(): Promise<{ agent: ReturnType<typeof request.agent>; csrf: string }> {
  const agent = request.agent(app);
  // GET first so the session-pinned CSRF cookie gets set before login.
  await agent.get("/api/v1/auth/me");
  const loginResp = await agent
    .post("/api/v1/auth/login")
    .send({ username: TEST_USERNAME, password: TEST_PASSWORD })
    .set("Content-Type", "application/json");
  if (loginResp.status !== 200) {
    throw new Error(`Login failed (${loginResp.status}): ${JSON.stringify(loginResp.body)}`);
  }
  // Pull the CSRF token from the agent's cookie jar.
  const cookies = (agent.jar as any).getCookies("http://127.0.0.1/");
  const csrf = (cookies.find((c: any) => c.key === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  return { agent, csrf };
}

/**
 * Default tier-3 settings that satisfy TierSettingsSchema in
 * src/api/routes/monitorSettings.ts. Tests spread overrides on top.
 */
function defaultTierSettings(): Record<string, unknown> {
  return {
    intervalSeconds:           60,
    failureThreshold:          3,
    probeTimeoutMs:            5000,
    telemetryIntervalSeconds:  60,
    systemInfoIntervalSeconds: 600,
    sampleRetentionDays:       30,
    telemetryRetentionDays:    30,
    systemInfoRetentionDays:   30,
  };
}

// ─── Manual tier ───────────────────────────────────────────────────────────

d("PUT /api/v1/monitor-settings/manual", () => {
  it("upserts the manual tier (including polling fields) and returns the saved values", async () => {
    const { agent, csrf } = await authedAgent();
    const body = {
      ...defaultTierSettings(),
      responseTimePolling: "snmp",
      telemetryPolling:    null,
      interfacesPolling:   "winrm",
      lldpPolling:         null,
    };
    const resp = await agent
      .put("/api/v1/monitor-settings/manual")
      .set("X-CSRF-Token", csrf)
      .send(body);
    expect(resp.status).toBe(200);
    expect(resp.body.responseTimePolling).toBe("snmp");
    expect(resp.body.interfacesPolling).toBe("winrm");
    // Re-read via GET to confirm the Setting row landed.
    const after = await agent.get("/api/v1/monitor-settings/manual");
    expect(after.status).toBe(200);
    expect(after.body.responseTimePolling).toBe("snmp");
    expect(after.body.interfacesPolling).toBe("winrm");
  });

  it("rejects probeTimeoutMs below 100 with a 400", async () => {
    const { agent, csrf } = await authedAgent();
    const resp = await agent
      .put("/api/v1/monitor-settings/manual")
      .set("X-CSRF-Token", csrf)
      .send({ ...defaultTierSettings(), probeTimeoutMs: 50 });
    expect(resp.status).toBe(400);
  });

  it("emits a monitor_settings.manual.updated audit Event", async () => {
    const { agent, csrf } = await authedAgent();
    await agent
      .put("/api/v1/monitor-settings/manual")
      .set("X-CSRF-Token", csrf)
      .send(defaultTierSettings());
    const events = await prisma.event.findMany({
      where: { action: "monitor_settings.manual.updated" },
    });
    expect(events.length).toBe(1);
    expect(events[0].actor).toBe(TEST_USERNAME);
  });
});

// ─── Integration tier (compatibility-aware) ────────────────────────────────

d("PUT /api/v1/monitor-settings/integration/:id", () => {
  it("rejects WinRM polling on a FortiManager integration with a 400", async () => {
    const { agent, csrf } = await authedAgent();
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: {} },
    });
    const resp = await agent
      .put(`/api/v1/monitor-settings/integration/${integ.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ ...defaultTierSettings(), responseTimePolling: "winrm" });
    expect(resp.status).toBe(400);
    expect(String(resp.body?.error || "")).toMatch(/winrm/i);
    expect(String(resp.body?.error || "")).toMatch(/fortimanager/i);
  });

  it("accepts SNMP polling on a FortiManager integration and writes monitorSettings", async () => {
    const { agent, csrf } = await authedAgent();
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: { useProxy: true } },
    });
    const resp = await agent
      .put(`/api/v1/monitor-settings/integration/${integ.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ ...defaultTierSettings(), telemetryPolling: "snmp" });
    expect(resp.status).toBe(200);
    const fresh = await prisma.integration.findUnique({ where: { id: integ.id } });
    const cfg = fresh!.config as Record<string, unknown>;
    expect((cfg.monitorSettings as any).telemetryPolling).toBe("snmp");
    // Existing config keys are preserved.
    expect(cfg.useProxy).toBe(true);
  });

  it("rejects REST API polling on an Active Directory integration", async () => {
    const { agent, csrf } = await authedAgent();
    const integ = await prisma.integration.create({
      data: { type: "activedirectory", name: "AD-test", config: {} },
    });
    const resp = await agent
      .put(`/api/v1/monitor-settings/integration/${integ.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ ...defaultTierSettings(), responseTimePolling: "rest_api" });
    expect(resp.status).toBe(400);
    expect(String(resp.body?.error || "")).toMatch(/rest api/i);
  });
});

// ─── Class overrides (compatibility-aware) ─────────────────────────────────

d("POST /api/v1/monitor-settings/class-overrides", () => {
  it("creates a manual-scope override accepting any polling method (winrm)", async () => {
    const { agent, csrf } = await authedAgent();
    const resp = await agent
      .post("/api/v1/monitor-settings/class-overrides")
      .set("X-CSRF-Token", csrf)
      .send({
        integrationId: null,
        assetType:     "workstation",
        responseTimePolling: "winrm",
      });
    expect(resp.status).toBe(201);
    expect(resp.body.responseTimePolling).toBe("winrm");
    expect(resp.body.integrationId).toBeNull();
  });

  it("rejects WinRM on an integration-scoped override when the integration is FortiManager", async () => {
    const { agent, csrf } = await authedAgent();
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: {} },
    });
    const resp = await agent
      .post("/api/v1/monitor-settings/class-overrides")
      .set("X-CSRF-Token", csrf)
      .send({
        integrationId: integ.id,
        assetType:     "firewall",
        responseTimePolling: "winrm",
      });
    expect(resp.status).toBe(400);
  });

  it("returns 409 when an override for (integrationId, assetType) already exists", async () => {
    const { agent, csrf } = await authedAgent();
    await prisma.monitorClassOverride.create({
      data: { integrationId: null, assetType: "switch" },
    });
    const resp = await agent
      .post("/api/v1/monitor-settings/class-overrides")
      .set("X-CSRF-Token", csrf)
      .send({ integrationId: null, assetType: "switch" });
    expect(resp.status).toBe(409);
  });
});

// ─── Per-asset polling overrides ───────────────────────────────────────────

d("PUT /api/v1/assets/:id (polling fields)", () => {
  it("rejects WinRM polling on a FortiManager-discovered asset with a 400", async () => {
    const { agent, csrf } = await authedAgent();
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: {} },
    });
    const asset = await prisma.asset.create({
      data: {
        hostname:                  "test-fw",
        assetType:                 "firewall",
        manufacturer:              "Fortinet",
        discoveredByIntegrationId: integ.id,
      },
    });
    const resp = await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ responseTimePolling: "winrm" });
    expect(resp.status).toBe(400);
    expect(String(resp.body?.error || "")).toMatch(/winrm/i);
  });

  it("accepts SNMP polling on a FortiManager-discovered asset", async () => {
    const { agent, csrf } = await authedAgent();
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: {} },
    });
    const asset = await prisma.asset.create({
      data: {
        hostname:                  "test-fw",
        assetType:                 "firewall",
        manufacturer:              "Fortinet",
        discoveredByIntegrationId: integ.id,
      },
    });
    const resp = await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ telemetryPolling: "snmp" });
    expect(resp.status).toBe(200);
    const fresh = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(fresh!.telemetryPolling).toBe("snmp");
  });

  it("flips monitoredOperatorSet=true on every PUT that includes the monitored field", async () => {
    const { agent, csrf } = await authedAgent();
    const asset = await prisma.asset.create({
      data: { hostname: "test-host", assetType: "server", monitoredOperatorSet: false },
    });
    const resp = await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ monitored: true });
    expect(resp.status).toBe(200);
    const fresh = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(fresh!.monitoredOperatorSet).toBe(true);
    expect(fresh!.monitored).toBe(true);
  });

  it("leaves monitoredOperatorSet alone when the PUT body omits monitored", async () => {
    const { agent, csrf } = await authedAgent();
    const asset = await prisma.asset.create({
      data: { hostname: "test-host", assetType: "server", monitoredOperatorSet: false },
    });
    const resp = await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ notes: "just touching notes" });
    expect(resp.status).toBe(200);
    const fresh = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(fresh!.monitoredOperatorSet).toBe(false);
  });
});

// ─── Effective settings + provenance resolver ──────────────────────────────

d("GET /api/v1/assets/:id/effective-monitor-settings", () => {
  it("returns the source-default polling for an asset under the manual tier with no overrides", async () => {
    const { agent } = await authedAgent();
    const asset = await prisma.asset.create({
      data: { hostname: "manual-host", assetType: "server" },
    });
    const resp = await agent.get(`/api/v1/assets/${asset.id}/effective-monitor-settings`);
    expect(resp.status).toBe(200);
    // Manual tier source default for response-time = icmp; other streams null.
    expect(resp.body.resolved.responseTimePolling).toBe("icmp");
    expect(resp.body.resolved.telemetryPolling).toBeNull();
    expect(resp.body.tier3Source).toBe("manual");
  });

  it("bubbles a per-asset polling override into resolved + flips provenance to 'asset'", async () => {
    const { agent, csrf } = await authedAgent();
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: {} },
    });
    const asset = await prisma.asset.create({
      data: {
        hostname:                  "fw-with-snmp-override",
        assetType:                 "firewall",
        discoveredByIntegrationId: integ.id,
      },
    });
    // Set the per-asset override via the route (not raw Prisma) so the
    // compatibility check + audit logging exercise too.
    await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ telemetryPolling: "snmp" });

    const resp = await agent.get(`/api/v1/assets/${asset.id}/effective-monitor-settings`);
    expect(resp.status).toBe(200);
    expect(resp.body.resolved.telemetryPolling).toBe("snmp");
    expect(resp.body.provenance.telemetryPolling).toBe("asset");
    // Source default still drives unset streams.
    expect(resp.body.resolved.responseTimePolling).toBe("rest_api");
    expect(resp.body.provenance.responseTimePolling).toBe("integration");
    expect(resp.body.tier3Source).toBe("integration");
  });
});

// ─── Auth required across the surface ──────────────────────────────────────

d("monitor-settings routes require authentication", () => {
  it("returns 401 from PUT /manual without a session", async () => {
    const resp = await request(app)
      .put("/api/v1/monitor-settings/manual")
      .send(defaultTierSettings());
    expect(resp.status).toBe(401);
  });

  it("returns 401 from POST /class-overrides without a session", async () => {
    const resp = await request(app)
      .post("/api/v1/monitor-settings/class-overrides")
      .send({ integrationId: null, assetType: "server" });
    expect(resp.status).toBe(401);
  });
});
