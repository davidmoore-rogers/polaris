/**
 * tests/integration/entraProxyLogin.test.ts — Entra App Proxy header SSO
 *
 * End-to-end over the real app: trust gate (source-IP allowlist), header
 * strip middleware, login + provisioning (azureOid convergence with SAML),
 * group→role mapping, the silent auto-login redirect on protected pages,
 * and open-redirect validation on ?next=.
 *
 * Source simulation: the suite runs without trust proxy, so req.ip is always
 * the loopback socket peer. "Trusted" = allowlist contains loopback;
 * "untrusted" = allowlist contains only a TEST-NET address. Skips cleanly
 * when DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import {
  updateEntraProxySettings,
  clearEntraProxySettingsCache,
} from "../../src/services/entraProxyAuthService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "entraproxy-test";

const GUID_A = "aaaa1111-0000-4000-8000-00000000000a";
const GUID_B = "bbbb2222-0000-4000-8000-00000000000b";
const GUID_SAML = "cccc3333-0000-4000-8000-00000000000c";
const GROUP_GUID = "dddd4444-0000-4000-8000-00000000000d";

const LOOPBACK = ["127.0.0.1", "::1"];
const UNTRUSTED_ONLY = ["203.0.113.99"];

const HEADERS = (guid: string, upn: string, extra: Record<string, string> = {}) => ({
  "x-entra-object-id": guid,
  "x-entra-upn": upn,
  ...extra,
});

async function seedSettings(trustedSourceIps: string[], enabled = true): Promise<void> {
  await updateEntraProxySettings({
    enabled,
    trustedSourceIps,
    objectIdHeader: "x-entra-object-id",
    usernameHeader: "x-entra-upn",
    emailHeader: "x-entra-email",
    displayNameHeader: "x-entra-display-name",
    groupsHeader: "x-entra-groups",
  });
  clearEntraProxySettingsCache();
}

async function cleanup(): Promise<void> {
  await prisma.user.deleteMany({ where: { azureOid: { in: [GUID_A, GUID_B, GUID_SAML] } } });
  await prisma.groupMapping.deleteMany({ where: { provider: "entra-proxy", groupKey: GROUP_GUID } });
  await prisma.setting.deleteMany({ where: { key: "entraProxy" } });
  clearEntraProxySettingsCache();
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

d("entra-proxy login — trust gate", () => {
  it("refuses login from an untrusted source and creates no user or session", async () => {
    await seedSettings(UNTRUSTED_ONLY);
    const agent = request.agent(app);
    const resp = await agent
      .get("/api/v1/auth/entra-proxy/login")
      .set(HEADERS(GUID_A, "usera@example.com"));
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toBe("/login.html?error=entra_proxy_untrusted_source");
    expect(await prisma.user.findUnique({ where: { azureOid: GUID_A } })).toBeNull();
    const me = await agent.get("/api/v1/auth/me");
    expect(me.body.authenticated).toBe(false);
  });

  it("redirects to not_configured when the feature is disabled", async () => {
    await seedSettings(LOOPBACK, false);
    const resp = await request(app)
      .get("/api/v1/auth/entra-proxy/login")
      .set(HEADERS(GUID_A, "usera@example.com"));
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toBe("/login.html?error=entra_proxy_not_configured");
  });

  it("strip middleware removes identity headers from untrusted requests", async () => {
    await seedSettings(UNTRUSTED_ONLY);
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/auth/entra-proxy/test")
      .set("X-CSRF-Token", csrf)
      .set(HEADERS(GUID_A, "usera@example.com"));
    expect(resp.status).toBe(200);
    // The strip ran before the route: the identity headers never reached it.
    expect(resp.body.details.headersPresent).toEqual([]);
    expect(resp.body.details.trusted).toBe(false);
  });

  it("test endpoint reports header names + trust from a trusted source", async () => {
    await seedSettings(LOOPBACK);
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/auth/entra-proxy/test")
      .set("X-CSRF-Token", csrf)
      .set(HEADERS(GUID_A, "usera@example.com"));
    expect(resp.body.details.trusted).toBe(true);
    expect(resp.body.details.headersPresent).toEqual(["x-entra-object-id", "x-entra-upn"]);
    expect(JSON.stringify(resp.body)).not.toContain(GUID_A);
  });
});

d("entra-proxy login — session + provisioning", () => {
  it("logs in from a trusted source: session established, user provisioned, GUID lowercased", async () => {
    await seedSettings(LOOPBACK);
    const agent = request.agent(app);
    const resp = await agent
      .get("/api/v1/auth/entra-proxy/login")
      .set(HEADERS(GUID_A.toUpperCase(), `${PFX}-usera@example.com`, {
        "x-entra-display-name": "User A",
        "x-entra-email": `${PFX}-usera@example.com`,
      }));
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toBe("/");

    const user = await prisma.user.findUnique({ where: { azureOid: GUID_A }, include: { role: true } });
    expect(user).not.toBeNull();
    expect(user!.authProvider).toBe("entra-proxy");
    expect(user!.role.name).toBe("readonly"); // no group match → readonly + review
    expect(user!.needsRoleReview).toBe(true);

    const me = await agent.get("/api/v1/auth/me");
    expect(me.body.authenticated).toBe(true);
    expect(me.body.authProvider).toBe("entra-proxy");
  });

  it("rejects a malformed object-id header without creating anything", async () => {
    await seedSettings(LOOPBACK);
    const resp = await request(app)
      .get("/api/v1/auth/entra-proxy/login")
      .set({ "x-entra-object-id": "not-a-guid", "x-entra-upn": "x@example.com" });
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toMatch(/^\/login\.html\?error=/);
  });

  it("assigns the group-mapped role from the groups header (case-insensitive GUIDs)", async () => {
    await seedSettings(LOOPBACK);
    const netadmin = await prisma.role.findUnique({ where: { name: "networkadmin" } });
    expect(netadmin).not.toBeNull();
    await prisma.groupMapping.create({
      data: {
        provider: "entra-proxy",
        groupKey: GROUP_GUID,
        groupLabel: GROUP_GUID,
        roleId: netadmin!.id,
        enabled: true,
      },
    });

    const resp = await request(app)
      .get("/api/v1/auth/entra-proxy/login")
      .set(HEADERS(GUID_B, `${PFX}-userb@example.com`, {
        "x-entra-groups": `${GROUP_GUID.toUpperCase()}; eeee5555-0000-4000-8000-00000000000e`,
      }));
    expect(resp.status).toBe(302);

    const user = await prisma.user.findUnique({ where: { azureOid: GUID_B }, include: { role: true } });
    expect(user!.role.name).toBe("networkadmin");
    expect(user!.ssoGroups).toContain(GROUP_GUID);
  });

  it("converges onto an existing SAML-provisioned account and flips authProvider", async () => {
    await seedSettings(LOOPBACK);
    const readonly = await prisma.role.findUnique({ where: { name: "readonly" } });
    const samlUser = await prisma.user.create({
      data: {
        username: `${PFX}-samluser`,
        passwordHash: "x",
        roleId: readonly!.id,
        authProvider: "azure",
        azureOid: GUID_SAML,
        lastLogin: new Date(),
      },
    });

    const resp = await request(app)
      .get("/api/v1/auth/entra-proxy/login")
      .set(HEADERS(GUID_SAML, `${PFX}-samluser@example.com`));
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toBe("/");

    const after = await prisma.user.findUnique({ where: { azureOid: GUID_SAML } });
    expect(after!.id).toBe(samlUser.id); // same account, no duplicate
    expect(after!.authProvider).toBe("entra-proxy");
    expect(await prisma.user.count({ where: { azureOid: GUID_SAML } })).toBe(1);
  });
});

d("entra-proxy login — auto-login redirect + ?next= validation", () => {
  it("auto-redirects an unauthenticated protected page into header login", async () => {
    await seedSettings(LOOPBACK);
    const resp = await request(app)
      .get("/assets.html")
      .set(HEADERS(GUID_A, `${PFX}-usera@example.com`));
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toBe("/api/v1/auth/entra-proxy/login?next=%2Fassets.html");
  });

  it("falls through to /login.html without identity headers", async () => {
    await seedSettings(LOOPBACK);
    const resp = await request(app).get("/assets.html");
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toBe("/login.html");
  });

  it("does not auto-redirect from an untrusted source even with headers", async () => {
    await seedSettings(UNTRUSTED_ONLY);
    const resp = await request(app)
      .get("/assets.html")
      .set(HEADERS(GUID_A, `${PFX}-usera@example.com`));
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toBe("/login.html");
  });

  it("honors a safe ?next= and rejects unsafe ones", async () => {
    await seedSettings(LOOPBACK);
    const login = (next: string) =>
      request(app)
        .get(`/api/v1/auth/entra-proxy/login?next=${encodeURIComponent(next)}`)
        .set(HEADERS(GUID_A, `${PFX}-usera@example.com`));

    expect((await login("/assets.html")).headers.location).toBe("/assets.html");
    expect((await login("//evil.example.com")).headers.location).toBe("/");
    expect((await login("https://evil.example.com")).headers.location).toBe("/");
    expect((await login("/\\evil")).headers.location).toBe("/");
    expect((await login("/login.html")).headers.location).toBe("/");
  });

  it("config endpoint reports availability booleans only", async () => {
    await seedSettings(LOOPBACK);
    const withHeaders = await request(app)
      .get("/api/v1/auth/entra-proxy/config")
      .set(HEADERS(GUID_A, `${PFX}-usera@example.com`));
    expect(withHeaders.body).toEqual({ enabled: true, available: true });

    const without = await request(app).get("/api/v1/auth/entra-proxy/config");
    expect(without.body).toEqual({ enabled: true, available: false });

    await seedSettings(UNTRUSTED_ONLY);
    const untrusted = await request(app)
      .get("/api/v1/auth/entra-proxy/config")
      .set(HEADERS(GUID_A, `${PFX}-usera@example.com`));
    expect(untrusted.body).toEqual({ enabled: true, available: false });
  });
});
