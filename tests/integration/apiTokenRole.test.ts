/**
 * tests/integration/apiTokenRole.test.ts
 *
 * Role-bound API tokens (the api-tokens role cutover):
 *   - a token bound to an assets-read role can GET /assets/* and nothing else
 *   - requirePermission enforces the bound role's matrix for tokens exactly
 *     like a session snapshot (403 outside the role, 403 on writes)
 *   - a token bound to a write-granting role can mutate through the CSRF
 *     middleware (Authorization: Bearer requests are CSRF-exempt) and the
 *     audit Event is attributed to `api:<token name>`
 *   - a role bound to a token cannot be deleted (friendly 409)
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable, waitForEventCount } from "./_helpers.js";
import { createToken } from "../../src/services/apiTokenService.js";
import { createRole, deleteRole } from "../../src/services/roleService.js";

const d = dbDescribe;

const READ_ROLE = "test-token-assets-read";
const WRITE_ROLE = "test-token-assets-write";
const TOKEN_PREFIX = "token-role-test-";
const HOSTNAME = "token-role-test-asset-01";

let readRoleId = "";
let writeRoleId = "";
let readToken = "";
let writeToken = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
  await prisma.asset.deleteMany({ where: { hostname: HOSTNAME } });
  await prisma.role.deleteMany({ where: { name: { in: [READ_ROLE, WRITE_ROLE] } } });

  readRoleId = (await createRole({ name: READ_ROLE, permissions: { assets: "read" } })).id;
  writeRoleId = (await createRole({ name: WRITE_ROLE, permissions: { assets: "write" } })).id;

  readToken = (await createToken({
    name: `${TOKEN_PREFIX}read`,
    roleId: readRoleId,
    createdBy: "integration-test",
  })).rawToken;
  writeToken = (await createToken({
    name: `${TOKEN_PREFIX}write`,
    roleId: writeRoleId,
    createdBy: "integration-test",
  })).rawToken;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: HOSTNAME } });
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
  await deleteRole(readRoleId).catch(() => {});
  await deleteRole(writeRoleId).catch(() => {});
  await prisma.$disconnect();
});

d("role-bound API tokens", () => {
  it("assets-read token can GET /assets", async () => {
    const res = await request(app)
      .get("/api/v1/assets")
      .set("Authorization", `Bearer ${readToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assets ?? res.body)).toBe(true);
  });

  it("assets-read token can GET /assets/tags", async () => {
    const res = await request(app)
      .get("/api/v1/assets/tags")
      .set("Authorization", `Bearer ${readToken}`);
    expect(res.status).toBe(200);
  });

  it("assets-read token sees only asset groups in /search", async () => {
    const res = await request(app)
      .get("/api/v1/search?q=test")
      .set("Authorization", `Bearer ${readToken}`);
    expect(res.status).toBe(200);
    // Groups the role can't read come back empty (filter-don't-403).
    expect(res.body.blocks ?? []).toEqual([]);
    expect(res.body.subnets ?? []).toEqual([]);
  });

  it("assets-read token is 403 outside its role (GET /blocks)", async () => {
    const res = await request(app)
      .get("/api/v1/blocks")
      .set("Authorization", `Bearer ${readToken}`);
    expect(res.status).toBe(403);
  });

  it("assets-read token is 403 on writes (POST /assets reaches the permission gate, not CSRF)", async () => {
    const res = await request(app)
      .post("/api/v1/assets")
      .set("Authorization", `Bearer ${readToken}`)
      .send({ hostname: HOSTNAME })
      .set("Content-Type", "application/json");
    expect(res.status).toBe(403);
    // Message must be the permission gate's, proving the CSRF exemption let
    // the bearer request through to RBAC instead of dying on the token check.
    expect(JSON.stringify(res.body)).toMatch(/assets/);
    expect(JSON.stringify(res.body)).not.toMatch(/CSRF/i);
  });

  it("assets-write token can create an asset; the Event is attributed api:<token name>", async () => {
    const res = await request(app)
      .post("/api/v1/assets")
      .set("Authorization", `Bearer ${writeToken}`)
      .send({ hostname: HOSTNAME })
      .set("Content-Type", "application/json");
    expect(res.status).toBe(201);
    expect(res.body.hostname).toBe(HOSTNAME);
    expect(res.body.createdBy).toBe(`api:${TOKEN_PREFIX}write`);

    await waitForEventCount("asset.created", 1, res.body.id);
    const ev = await prisma.event.findFirst({
      where: { action: "asset.created", resourceId: res.body.id },
    });
    expect(ev?.actor).toBe(`api:${TOKEN_PREFIX}write`);
  });

  it("a role bound to a token cannot be deleted", async () => {
    await expect(deleteRole(readRoleId)).rejects.toThrow(/API token/);
  });

  it("a garbage bearer with no session is 401", async () => {
    const res = await request(app)
      .get("/api/v1/assets")
      .set("Authorization", "Bearer polaris_notarealtokenatall1234567890ab");
    expect(res.status).toBe(401);
  });
});
