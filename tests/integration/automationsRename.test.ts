/**
 * tests/integration/automationsRename.test.ts
 *
 * Automations rename (2026-07): the canonical API paths (/automations,
 * /alerts, /delivery-channels) and the deprecated notification-era aliases
 * (/notification-rules, /notifications, /notification-channels) mount the
 * SAME routers — both must answer, aliases with Deprecation/Link headers.
 * Also covers the read-path legacy-key fold: a Role row still stored with
 * the pre-rename key names (imported role JSON / restored backup) grants
 * access through normalizePermissions at snapshot load.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "autorename-test";
const PASSWORD = "autorename-password-not-real";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({ data: { name: `${PFX}-role-${suffix}`, permissions } });
  const username = `${PFX}-user-${suffix}`;
  await prisma.user.create({
    data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" },
  });
  return username;
}

const agentCache = new Map<string, ReturnType<typeof request.agent>>();
async function loginAs(username: string): Promise<ReturnType<typeof request.agent>> {
  const cached = agentCache.get(username);
  if (cached) return cached;
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent
    .post("/api/v1/auth/login")
    .send({ username, password: PASSWORD })
    .set("Content-Type", "application/json");
  if (resp.status !== 200) {
    throw new Error(`login as ${username} failed (${resp.status}): ${JSON.stringify(resp.body)}`);
  }
  agentCache.set(username, agent);
  return agent;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  // Modern matrix: full access on the renamed keys.
  await createRoleUser("modern", matrix("none", {
    alerts: "fullwrite",
    automationManagement: "fullwrite",
  }));
  // Legacy matrix: a role stored with the PRE-rename key names and WITHOUT
  // the modern ones, as an imported role JSON or restored pre-upgrade backup
  // would look. The snapshot loader's normalizePermissions fold must resolve it.
  const legacy = matrix("none");
  delete legacy.alerts;
  delete legacy.automationManagement;
  delete legacy.automationScripts;
  legacy.notifications = "fullwrite";
  legacy.notificationManagement = "read";
  await createRoleUser("legacy", legacy);
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.user.deleteMany({ where: { username: { startsWith: `${PFX}-user-` } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: `${PFX}-role-` } } });
  await prisma.$disconnect();
});

d("automations rename — canonical + alias mounts", () => {
  const pairs: Array<{ canonical: string; alias: string }> = [
    { canonical: "/api/v1/automations", alias: "/api/v1/notification-rules" },
    { canonical: "/api/v1/alerts", alias: "/api/v1/notifications" },
    { canonical: "/api/v1/delivery-channels", alias: "/api/v1/notification-channels" },
  ];

  it("canonical paths answer 200 without deprecation headers", async () => {
    const agent = await loginAs(`${PFX}-user-modern`);
    for (const { canonical } of pairs) {
      const resp = await agent.get(canonical);
      expect(resp.status, canonical).toBe(200);
      expect(resp.headers["deprecation"], canonical).toBeUndefined();
    }
  });

  it("alias paths answer 200 with Deprecation + successor Link headers and identical bodies", async () => {
    const agent = await loginAs(`${PFX}-user-modern`);
    for (const { canonical, alias } of pairs) {
      const [canonResp, aliasResp] = [await agent.get(canonical), await agent.get(alias)];
      expect(aliasResp.status, alias).toBe(200);
      expect(aliasResp.headers["deprecation"], alias).toBe("true");
      expect(aliasResp.headers["link"], alias).toContain(`<${canonical}>`);
      expect(aliasResp.headers["link"], alias).toContain('rel="successor-version"');
      expect(aliasResp.body, alias).toEqual(canonResp.body);
    }
  });

  it("the automations schema endpoint answers on both paths", async () => {
    const agent = await loginAs(`${PFX}-user-modern`);
    const canon = await agent.get("/api/v1/automations/schema");
    const alias = await agent.get("/api/v1/notification-rules/schema");
    expect(canon.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(canon.body).toEqual(alias.body);
    expect(canon.body.triggerTypes?.length).toBeGreaterThan(0);
  });
});

d("automations rename — legacy-key role matrix still resolves", () => {
  it("a role stored with pre-rename keys grants alerts + automationManagement", async () => {
    const agent = await loginAs(`${PFX}-user-legacy`);
    // legacy `notifications: fullwrite` → alerts list readable
    expect((await agent.get("/api/v1/alerts")).status).toBe(200);
    // legacy `notificationManagement: read` → automations list readable...
    expect((await agent.get("/api/v1/automations")).status).toBe(200);
    // ...but not writable (read < fullwrite), proving the fold preserves level.
    const post = await agent.post("/api/v1/automations").send({});
    expect(post.status).toBe(403);
  });

  it("an all-none role is still 403 on the canonical paths", async () => {
    const username = await createRoleUser("none", matrix("none"));
    const agent = await loginAs(username);
    expect((await agent.get("/api/v1/alerts")).status).toBe(403);
    expect((await agent.get("/api/v1/automations")).status).toBe(403);
    expect((await agent.get("/api/v1/delivery-channels")).status).toBe(403);
  });
});
