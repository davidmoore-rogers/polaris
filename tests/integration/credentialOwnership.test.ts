/**
 * tests/integration/credentialOwnership.test.ts
 *
 * Route-level contract for the OWNERSHIP dimension on the `credentials`
 * function key (2026-09-04): write = create + edit/delete/test-with your own
 * rows, fullwrite = any row.
 *
 * What is pinned here is the set of wrong answers that are SILENT or that
 * quietly lend out a secret:
 *
 *  - a create that stamps no owner (the row would be unowned, so even its own
 *    author could never edit it again),
 *  - a write-level caller editing or deleting a peer's credential,
 *  - a write-level caller TESTING a peer's credential: passing `id` merges
 *    that row's stored secrets into the probe, so an ungated test route aims
 *    another operator's password at any host in inventory. That one looks
 *    like a read and is not,
 *  - a row with NO recorded owner (every row predating the column) being
 *    treated as "mine" by whoever asks first,
 *  - and the list staying readable throughout: the gate is on writes, not on
 *    seeing that a credential exists.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "credown-test";
const PASSWORD = "credown-password-not-real";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
  const username = PFX + "-user-" + suffix;
  await prisma.user.create({
    data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" },
  });
  return username;
}

type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
const sessions = new Map<string, Session>();

/** Log in as a seeded user and capture the post-regeneration CSRF token. */
async function loginAs(username: string): Promise<Session> {
  const cached = sessions.get(username);
  if (cached) return cached;
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent
    .post("/api/v1/auth/login")
    .send({ username, password: PASSWORD })
    .set("Content-Type", "application/json");
  if (resp.status !== 200) {
    throw new Error("login as " + username + " failed (" + resp.status + "): " + JSON.stringify(resp.body));
  }
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

const snmp = { version: "v2c", community: "public" };

let userA = "";
let userB = "";
let admin = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.credential.deleteMany({ where: { name: { startsWith: PFX } } });
  // Two write-level peers and one fullwrite caller. `read` everywhere else so
  // nothing upstream in the request path 403s first.
  userA = await createRoleUser("a",     matrix("read", { credentials: "write" }));
  userB = await createRoleUser("b",     matrix("read", { credentials: "write" }));
  admin = await createRoleUser("admin", matrix("read", { credentials: "fullwrite" }));
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.credential.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
});

d("credentials - the ownership dimension", () => {
  it("a create stamps the caller as owner, and the owner may edit + delete it", async () => {
    const a = await loginAs(userA);
    const created = await a.agent
      .post("/api/v1/credentials")
      .set("X-CSRF-Token", a.csrf)
      .send({ name: PFX + "-mine", type: "snmp", config: snmp });
    expect(created.status).toBe(201);
    expect(created.body.createdBy).toBe(userA);

    const renamed = await a.agent
      .put("/api/v1/credentials/" + created.body.id)
      .set("X-CSRF-Token", a.csrf)
      .send({ name: PFX + "-mine-renamed" });
    expect(renamed.status).toBe(200);

    const gone = await a.agent
      .delete("/api/v1/credentials/" + created.body.id)
      .set("X-CSRF-Token", a.csrf);
    expect(gone.status).toBe(204);
  });

  it("a write-level peer can SEE another row but cannot edit, delete or test it", async () => {
    const a = await loginAs(userA);
    const b = await loginAs(userB);
    const created = await a.agent
      .post("/api/v1/credentials")
      .set("X-CSRF-Token", a.csrf)
      .send({ name: PFX + "-peer", type: "snmp", config: snmp });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    // Reading stays open - the gate is on writes.
    const list = await b.agent.get("/api/v1/credentials");
    expect(list.status).toBe(200);
    expect((list.body as any[]).some(c => c.id === id)).toBe(true);

    const edit = await b.agent
      .put("/api/v1/credentials/" + id)
      .set("X-CSRF-Token", b.csrf)
      .send({ name: PFX + "-peer-hijacked" });
    expect(edit.status).toBe(403);

    // The one that looks like a read: `id` merges the STORED secret into the
    // probe, so testing a peer's row is borrowing their password.
    const test = await b.agent
      .post("/api/v1/credentials/test")
      .set("X-CSRF-Token", b.csrf)
      .send({ id, host: "10.99.250.1", type: "snmp", config: {} });
    expect(test.status).toBe(403);

    const del = await b.agent
      .delete("/api/v1/credentials/" + id)
      .set("X-CSRF-Token", b.csrf);
    expect(del.status).toBe(403);

    const still = await prisma.credential.findUnique({ where: { id } });
    expect(still?.name).toBe(PFX + "-peer");
  });

  it("testing an UNSAVED form is allowed at write - that secret is the caller's own", async () => {
    const b = await loginAs(userB);
    // A deliberately malformed target: the route refuses it as a test RESULT
    // (200 + error, no socket), which is what makes this assert the GATE
    // rather than waiting out a real SNMP timeout against a dark address.
    const res = await b.agent
      .post("/api/v1/credentials/test")
      .set("X-CSRF-Token", b.csrf)
      .send({ host: "https://10.99.250.2:8443/healthz", type: "snmp", config: snmp });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error || "")).not.toMatch(/forbidden/i);
  });

  it("a row with no recorded owner is fullwrite-only, and an edit never adopts it", async () => {
    const orphan = await prisma.credential.create({
      data: { name: PFX + "-orphan", type: "snmp", config: snmp as never, createdBy: null },
    });
    const a = await loginAs(userA);
    const refused = await a.agent
      .put("/api/v1/credentials/" + orphan.id)
      .set("X-CSRF-Token", a.csrf)
      .send({ name: PFX + "-orphan-claimed" });
    expect(refused.status).toBe(403);

    const su = await loginAs(admin);
    const allowed = await su.agent
      .put("/api/v1/credentials/" + orphan.id)
      .set("X-CSRF-Token", su.csrf)
      .send({ name: PFX + "-orphan-adopted" });
    expect(allowed.status).toBe(200);
    const after = await prisma.credential.findUnique({ where: { id: orphan.id } });
    expect(after?.createdBy).toBeNull();
  });

  it("fullwrite reaches a peer's row", async () => {
    const a = await loginAs(userA);
    const su = await loginAs(admin);
    const created = await a.agent
      .post("/api/v1/credentials")
      .set("X-CSRF-Token", a.csrf)
      .send({ name: PFX + "-admin-reach", type: "snmp", config: snmp });
    expect(created.status).toBe(201);
    const res = await su.agent
      .delete("/api/v1/credentials/" + created.body.id)
      .set("X-CSRF-Token", su.csrf);
    expect(res.status).toBe(204);
  });
});
