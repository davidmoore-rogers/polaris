/**
 * tests/integration/permissionGates.test.ts
 *
 * Coverage for the /utilization, /dashboard/summary, and /search permission
 * gates (2026-06 review Tier 1.2). The dashboard and search endpoints filter
 * by the caller's per-function read access instead of 403ing (they back
 * surfaces that render for every role); /utilization is blanket-gated on
 * ipBlocks=read at the mount.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "permgate-test";
const PASSWORD = "permgate-password-not-real";

/** Build a permissions matrix with every function key at `base`, overridden per `overrides`. */
function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({
    data: { name: `${PFX}-role-${suffix}`, permissions },
  });
  const username = `${PFX}-user-${suffix}`;
  await prisma.user.create({
    data: {
      username,
      passwordHash: await hashPassword(PASSWORD),
      roleId: role.id,
      authProvider: "local",
    },
  });
  return username;
}

/** Login as a per-test user. Cached per username — the login rate limiter
 *  allows 10 attempts / 15 min / IP across the whole process, and these
 *  GET-only tests can safely share a session per user. */
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

  // Seed data every gated section can surface: a block with a subnet and a
  // manual reservation, plus an active asset.
  const block = await prisma.ipBlock.create({
    data: { name: `${PFX}-block`, cidr: "10.99.0.0/16", ipVersion: "v4" },
  });
  const subnet = await prisma.subnet.create({
    data: { blockId: block.id, name: `${PFX}-subnet`, cidr: "10.99.1.0/24", createdBy: "permgate" },
  });
  await prisma.reservation.create({
    data: {
      subnetId: subnet.id,
      ipAddress: "10.99.1.10",
      hostname: `${PFX}-host`,
      sourceType: "manual",
      createdBy: "permgate",
    },
  });
  await prisma.asset.create({
    data: { hostname: `${PFX}-asset`, assetType: "server", status: "active" },
  });

  await createRoleUser("none", matrix("none"));
  await createRoleUser("assetsread", matrix("none", { assets: "read" }));
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.user.deleteMany({ where: { username: { startsWith: `${PFX}-user-` } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: `${PFX}-role-` } } });
  await prisma.reservation.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.subnet.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.ipBlock.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("permission gates — all-none role", () => {
  it("GET /dashboard/summary returns 200 with every section empty", async () => {
    const agent = await loginAs(`${PFX}-user-none`);
    const resp = await agent.get("/api/v1/dashboard/summary");
    expect(resp.status).toBe(200);
    expect(resp.body.blockUtilization).toEqual([]);
    expect(resp.body.recentReservations).toEqual([]);
    expect(resp.body.assetTypeCounts).toEqual([]);
    expect(resp.body.monitorAlerts).toEqual([]);
    expect(resp.body.monitorAlertsOverflow).toBe(false);
  });

  it("GET /search returns 200 with every group empty", async () => {
    const agent = await loginAs(`${PFX}-user-none`);
    const resp = await agent.get(`/api/v1/search?q=${PFX}`);
    expect(resp.status).toBe(200);
    expect(resp.body.blocks).toEqual([]);
    expect(resp.body.subnets).toEqual([]);
    expect(resp.body.reservations).toEqual([]);
    expect(resp.body.assets).toEqual([]);
    expect(resp.body.sites).toEqual([]);
    expect(resp.body.ips).toEqual([]);
  });

  it("GET /utilization is 403", async () => {
    const agent = await loginAs(`${PFX}-user-none`);
    const resp = await agent.get("/api/v1/utilization");
    expect(resp.status).toBe(403);
  });
});

d("permission gates — assets:read-only role", () => {
  it("GET /dashboard/summary returns asset sections only", async () => {
    const agent = await loginAs(`${PFX}-user-assetsread`);
    const resp = await agent.get("/api/v1/dashboard/summary");
    expect(resp.status).toBe(200);
    expect(resp.body.blockUtilization).toEqual([]);
    expect(resp.body.recentReservations).toEqual([]);
    // The seeded asset is active → counted.
    const serverRow = (resp.body.assetTypeCounts as Array<{ assetType: string; count: number }>)
      .find((r) => r.assetType === "server");
    expect(serverRow).toBeDefined();
    expect(serverRow!.count).toBeGreaterThanOrEqual(1);
  });

  it("GET /search returns the assets group only", async () => {
    const agent = await loginAs(`${PFX}-user-assetsread`);
    const resp = await agent.get(`/api/v1/search?q=${PFX}`);
    expect(resp.status).toBe(200);
    expect(resp.body.blocks).toEqual([]);
    expect(resp.body.subnets).toEqual([]);
    expect(resp.body.reservations).toEqual([]);
    expect(resp.body.sites).toEqual([]);
    const titles = (resp.body.assets as Array<{ title: string }>).map((h) => h.title);
    expect(titles).toContain(`${PFX}-asset`);
  });

  it("GET /utilization is still 403 (gated on ipBlocks, not assets)", async () => {
    const agent = await loginAs(`${PFX}-user-assetsread`);
    const resp = await agent.get("/api/v1/utilization");
    expect(resp.status).toBe(403);
  });
});

d("permission gates — readonly parity with admin", () => {
  it("summary + search payloads are identical between admin and the built-in readonly role", async () => {
    // readonly is seeded with read on every non-admin-only function, which
    // covers all the gated sections — so its view must equal admin's.
    const readonlyUser = await createRoleUserReadonly();
    const adminAgent = (await authedAgent(app)).agent;
    const roAgent = await loginAs(readonlyUser);

    const [adminSummary, roSummary] = await Promise.all([
      adminAgent.get("/api/v1/dashboard/summary"),
      roAgent.get("/api/v1/dashboard/summary"),
    ]);
    expect(roSummary.status).toBe(200);
    expect(roSummary.body).toEqual(adminSummary.body);

    const [adminSearch, roSearch] = await Promise.all([
      adminAgent.get(`/api/v1/search?q=${PFX}`),
      roAgent.get(`/api/v1/search?q=${PFX}`),
    ]);
    expect(roSearch.status).toBe(200);
    expect(roSearch.body).toEqual(adminSearch.body);
  });
});

/** A user holding the seeded built-in readonly role (created lazily — the
 *  role itself ships with every install via the roles-table-cutover
 *  migration, so only the user needs creating). */
async function createRoleUserReadonly(): Promise<string> {
  const readonly = await prisma.role.findUnique({ where: { name: "readonly" } });
  if (!readonly) throw new Error("built-in readonly role missing from test DB");
  const username = `${PFX}-user-readonly`;
  const existing = await prisma.user.findUnique({ where: { username } });
  if (!existing) {
    await prisma.user.create({
      data: {
        username,
        passwordHash: await hashPassword(PASSWORD),
        roleId: readonly.id,
        authProvider: "local",
      },
    });
  }
  return username;
}
