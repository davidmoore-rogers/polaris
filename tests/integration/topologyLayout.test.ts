/**
 * tests/integration/topologyLayout.test.ts
 *
 * Shared topology layouts — PUT/DELETE /map/sites/:id/topology/layout and the
 * savedLayouts embed on GET /map/sites/:id/topology. Write routes are gated
 * deviceMap=write; reads ride the auth-only topology GET.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";

const d = dbDescribe;
const PFX = "topolayout-test";
const PASSWORD = "topolayout-password-not-real";

let fgId = "";
let serverId = ""; // non-firewall asset — layout routes must 404 on it

const FLAT = { fg: { x: 0, y: 0 }, sw: { x: 260, y: 95 } };
const FLOOR_VIEW = "f|plant|mill|1";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();

  const fg = await prisma.asset.create({
    data: { hostname: `${PFX}-fg`, assetType: "firewall", status: "active" },
  });
  fgId = fg.id;
  const server = await prisma.asset.create({
    data: { hostname: `${PFX}-server`, assetType: "server", status: "active" },
  });
  serverId = server.id;

  // A readonly-equivalent caller: deviceMap=read (the built-in non-admin
  // default), everything else read too.
  const roMatrix: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) roMatrix[key] = "read";
  const roRole = await prisma.role.create({ data: { name: `${PFX}-role-ro`, permissions: roMatrix } });
  await prisma.user.create({
    data: {
      username: `${PFX}-user-ro`,
      passwordHash: await hashPassword(PASSWORD),
      roleId: roRole.id,
      authProvider: "local",
    },
  });
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.user.deleteMany({ where: { username: { startsWith: `${PFX}-user-` } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: `${PFX}-role-` } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("topology layout persistence", () => {
  it("PUT saves a flat-view layout and the topology GET embeds it", async () => {
    const { agent, csrf } = await authedAgent(app);
    const put = await agent
      .put(`/api/v1/map/sites/${fgId}/topology/layout`)
      .set("X-CSRF-Token", csrf)
      .send({ view: "flat", positions: FLAT });
    expect(put.status).toBe(200);
    expect(put.body.view).toBe("flat");
    expect(put.body.positions).toEqual(FLAT);
    expect(put.body.updatedBy).toBeTruthy();

    const topo = await agent.get(`/api/v1/map/sites/${fgId}/topology`);
    expect(topo.status).toBe(200);
    expect(topo.body.savedLayouts.flat.positions).toEqual(FLAT);

    expect(await waitForEventCount("map.topology.layout_saved", 1, fgId)).toBeGreaterThanOrEqual(1);
  });

  it("a second view coexists with flat and full-replaces on re-PUT", async () => {
    const { agent, csrf } = await authedAgent(app);
    const v1 = { sw: { x: 130, y: 0 } };
    const v2 = { sw: { x: 390, y: 190 } };
    let resp = await agent
      .put(`/api/v1/map/sites/${fgId}/topology/layout`)
      .set("X-CSRF-Token", csrf)
      .send({ view: FLOOR_VIEW, positions: v1 });
    expect(resp.status).toBe(200);
    resp = await agent
      .put(`/api/v1/map/sites/${fgId}/topology/layout`)
      .set("X-CSRF-Token", csrf)
      .send({ view: FLOOR_VIEW, positions: v2 });
    expect(resp.status).toBe(200);
    expect(resp.body.positions).toEqual(v2); // full replace, not merge

    const topo = await agent.get(`/api/v1/map/sites/${fgId}/topology`);
    expect(topo.body.savedLayouts.flat.positions).toEqual(FLAT);
    expect(topo.body.savedLayouts[FLOOR_VIEW].positions).toEqual(v2);
  });

  it("rejects malformed bodies with 400", async () => {
    const { agent, csrf } = await authedAgent(app);
    for (const body of [
      { view: "sideways", positions: FLAT },              // bad view key
      { view: "flat", positions: { n: { x: "1", y: 2 } } }, // non-numeric coord
      { view: "flat" },                                    // missing positions
    ]) {
      const resp = await agent
        .put(`/api/v1/map/sites/${fgId}/topology/layout`)
        .set("X-CSRF-Token", csrf)
        .send(body);
      expect(resp.status).toBe(400);
    }
  });

  it("404s on a non-firewall asset and an unknown id", async () => {
    const { agent, csrf } = await authedAgent(app);
    for (const id of [serverId, "00000000-0000-0000-0000-000000000000"]) {
      const resp = await agent
        .put(`/api/v1/map/sites/${id}/topology/layout`)
        .set("X-CSRF-Token", csrf)
        .send({ view: "flat", positions: FLAT });
      expect(resp.status).toBe(404);
    }
  });

  it("403s the write routes for a deviceMap=read caller (reads still work)", async () => {
    const agent = request.agent(app);
    await agent.get("/api/v1/auth/me");
    const login = await agent
      .post("/api/v1/auth/login")
      .send({ username: `${PFX}-user-ro`, password: PASSWORD })
      .set("Content-Type", "application/json");
    expect(login.status).toBe(200);
    await agent.get("/api/v1/auth/me"); // refresh CSRF post-login-regeneration
    const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
    const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";

    const put = await agent
      .put(`/api/v1/map/sites/${fgId}/topology/layout`)
      .set("X-CSRF-Token", csrf)
      .send({ view: "flat", positions: FLAT });
    expect(put.status).toBe(403);
    const del = await agent
      .delete(`/api/v1/map/sites/${fgId}/topology/layout?view=flat`)
      .set("X-CSRF-Token", csrf);
    expect(del.status).toBe(403);

    // The shared layout is still readable.
    const topo = await agent.get(`/api/v1/map/sites/${fgId}/topology`);
    expect(topo.status).toBe(200);
    expect(topo.body.savedLayouts.flat.positions).toEqual(FLAT);
  });

  it("DELETE removes only the named view and is idempotent (204)", async () => {
    const { agent, csrf } = await authedAgent(app);
    let del = await agent
      .delete(`/api/v1/map/sites/${fgId}/topology/layout?view=${encodeURIComponent(FLOOR_VIEW)}`)
      .set("X-CSRF-Token", csrf);
    expect(del.status).toBe(204);

    const topo = await agent.get(`/api/v1/map/sites/${fgId}/topology`);
    expect(topo.body.savedLayouts[FLOOR_VIEW]).toBeUndefined();
    expect(topo.body.savedLayouts.flat.positions).toEqual(FLAT); // untouched

    // Second delete: still 204, no event this time.
    del = await agent
      .delete(`/api/v1/map/sites/${fgId}/topology/layout?view=${encodeURIComponent(FLOOR_VIEW)}`)
      .set("X-CSRF-Token", csrf);
    expect(del.status).toBe(204);
    expect(await waitForEventCount("map.topology.layout_reset", 1, fgId)).toBe(1);

    // Missing/invalid view → 400.
    const bad = await agent
      .delete(`/api/v1/map/sites/${fgId}/topology/layout`)
      .set("X-CSRF-Token", csrf);
    expect(bad.status).toBe(400);
  });

  it("cascades layouts away with the site asset", async () => {
    const fg2 = await prisma.asset.create({
      data: { hostname: `${PFX}-fg2`, assetType: "firewall", status: "active" },
    });
    const { agent, csrf } = await authedAgent(app);
    const put = await agent
      .put(`/api/v1/map/sites/${fg2.id}/topology/layout`)
      .set("X-CSRF-Token", csrf)
      .send({ view: "flat", positions: FLAT });
    expect(put.status).toBe(200);
    expect(await prisma.topologyLayout.count({ where: { siteId: fg2.id } })).toBe(1);
    await prisma.asset.delete({ where: { id: fg2.id } });
    expect(await prisma.topologyLayout.count({ where: { siteId: fg2.id } })).toBe(0);
  });
});
