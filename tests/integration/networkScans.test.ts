/**
 * tests/integration/networkScans.test.ts — the /network-scans permission gates.
 *
 * The whole point of giving Discovery its own function key is that **scanning
 * and adopting are separate grants** (business rule 34a): a role may be allowed
 * to find out what is on a range without being allowed to put it into
 * inventory. That separation is one `requirePermission` chain deep on one
 * route, and nothing else in the suite would notice if it were dropped — hence
 * this file.
 *
 * Also pinned:
 *  - the router-wide `networkScan:read` FLOOR. The `/map` mount shipped with
 *    three auth-only read routes until 2026-08, and a Discovery's targets and
 *    results are the same kind of recon material;
 *  - `/preview-targets` and `/runs/...` are reachable at READ level and are NOT
 *    captured as `/:id` — the literal paths are declared first, which is the
 *    kind of ordering that breaks silently;
 *  - the semantic validations answer 400 with the operator-facing reason from
 *    the service, not a Zod dump.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe } from "./_helpers.js";

const d = dbDescribe;
const PFX = "netscan-test";
const PASSWORD = "netscan-password-not-real";

/** Every function key at `base`, overridden per key. */
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

// The login limiter is 10 attempts / 15 min / IP across the process, so one
// session per user, cached.
const agentCache = new Map<string, ReturnType<typeof request.agent>>();
async function loginAs(username: string): Promise<ReturnType<typeof request.agent>> {
  const cached = agentCache.get(username);
  if (cached) return cached;
  const agent = request.agent(app);
  const seed = await agent.get("/api/v1/auth/me");
  const csrf = /polaris_csrf=([^;]+)/.exec(String(seed.headers["set-cookie"] ?? ""))?.[1] ?? "";
  await agent.post("/api/v1/auth/login").set("x-csrf-token", csrf).send({ username, password: PASSWORD });
  agentCache.set(username, agent);
  return agent;
}

/** CSRF token for a mutating call on an authed agent. */
async function csrfFor(agent: ReturnType<typeof request.agent>): Promise<string> {
  const resp = await agent.get("/api/v1/auth/me");
  const raw = String(resp.headers["set-cookie"] ?? "");
  return /polaris_csrf=([^;]+)/.exec(raw)?.[1] ?? "";
}

let noneUser = "";
let readUser = "";
let writeUser = "";
let scanOnlyUser = ""; // networkScan:write but assets:read — the chained-gate case
const madeScanIds: string[] = [];

beforeAll(async () => {
  noneUser = await createRoleUser("none", matrix("read", { networkScan: "none" }));
  readUser = await createRoleUser("read", matrix("read", { networkScan: "read" }));
  writeUser = await createRoleUser("write", matrix("read", { networkScan: "write", assets: "write" }));
  scanOnlyUser = await createRoleUser("scanonly", matrix("read", { networkScan: "write", assets: "read" }));
}, 60_000);

afterAll(async () => {
  await prisma.networkScan.deleteMany({ where: { id: { in: madeScanIds } } }).catch(() => {});
  await prisma.networkScan.deleteMany({ where: { name: { startsWith: PFX } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } }).catch(() => {});
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } }).catch(() => {});
});

const body = (name: string) => ({
  name,
  targets: [{ kind: "cidr", value: "10.77.0.0/29" }],
  methods: [{ type: "icmp", credentialIds: [] }],
});

d("network-scans — the router-wide read floor", () => {
  it("403s a role without networkScan, even one that can read everything else", async () => {
    const agent = await loginAs(noneUser);
    expect((await agent.get("/api/v1/network-scans")).status).toBe(403);
    expect((await agent.post("/api/v1/network-scans/preview-targets").send({ targets: [] })).status).toBe(403);
  });

  it("lets a read-level caller list and preview", async () => {
    const agent = await loginAs(readUser);
    expect((await agent.get("/api/v1/network-scans")).status).toBe(200);
    const preview = await agent
      .post("/api/v1/network-scans/preview-targets")
      .set("x-csrf-token", await csrfFor(agent))
      .send({ targets: [{ kind: "cidr", value: "10.77.0.0/29" }] });
    expect(preview.status).toBe(200);
    // 6 hosts: a /29 minus network and broadcast.
    expect(preview.body.total).toBe(6);
  });

  it("403s a read-level caller on every write verb", async () => {
    const agent = await loginAs(readUser);
    const csrf = await csrfFor(agent);
    expect((await agent.post("/api/v1/network-scans").set("x-csrf-token", csrf).send(body(`${PFX}-nope`))).status).toBe(403);
  });
});

d("network-scans — literal paths are not ids", () => {
  it("routes /runs/<uuid> to the run lookup, not to /:id", async () => {
    const agent = await loginAs(readUser);
    const resp = await agent.get("/api/v1/network-scans/runs/00000000-0000-4000-8000-000000000000");
    // 404 "Run not found" — if `/:id` had captured it, the message would name a
    // Discovery instead.
    expect(resp.status).toBe(404);
    expect(String(resp.body.error ?? resp.body.message ?? "")).toMatch(/run/i);
  });
});

d("network-scans — CRUD", () => {
  it("creates, reads back, and refuses a duplicate name", async () => {
    const agent = await loginAs(writeUser);
    const csrf = await csrfFor(agent);
    const created = await agent.post("/api/v1/network-scans").set("x-csrf-token", csrf).send(body(`${PFX}-a`));
    expect(created.status).toBe(201);
    const id = created.body.scan.id as string;
    madeScanIds.push(id);
    expect(created.body.scan.targets).toHaveLength(1);

    const fetched = await agent.get(`/api/v1/network-scans/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.scan.name).toBe(`${PFX}-a`);

    const dup = await agent.post("/api/v1/network-scans").set("x-csrf-token", csrf).send(body(`${PFX}-a`));
    expect(dup.status).toBe(409);
  });

  it("answers 400 with the SERVICE's reason for a semantic problem", async () => {
    const agent = await loginAs(writeUser);
    const csrf = await csrfFor(agent);
    // A /8 is shape-valid and semantically refused — the distinction this
    // service/route split exists for.
    const wide = await agent
      .post("/api/v1/network-scans")
      .set("x-csrf-token", csrf)
      .send({ ...body(`${PFX}-wide`), targets: [{ kind: "cidr", value: "10.0.0.0/8" }] });
    expect(wide.status).toBe(400);
    expect(String(wide.body.error ?? wide.body.message ?? "")).toMatch(/more than/);

    const icmpCreds = await agent
      .post("/api/v1/network-scans")
      .set("x-csrf-token", csrf)
      .send({
        ...body(`${PFX}-icmpcreds`),
        methods: [{ type: "icmp", credentialIds: ["00000000-0000-4000-8000-000000000000"] }],
      });
    expect(icmpCreds.status).toBe(400);
    expect(String(icmpCreds.body.error ?? icmpCreds.body.message ?? "")).toMatch(/ICMP takes no credentials/i);
  });

  it("deletes", async () => {
    const agent = await loginAs(writeUser);
    const csrf = await csrfFor(agent);
    const created = await agent.post("/api/v1/network-scans").set("x-csrf-token", csrf).send(body(`${PFX}-del`));
    const id = created.body.scan.id as string;
    expect((await agent.delete(`/api/v1/network-scans/${id}`).set("x-csrf-token", csrf)).status).toBe(204);
    expect((await agent.get(`/api/v1/network-scans/${id}`)).status).toBe(404);
  });
});

d("network-scans — adoption is a SEPARATE grant", () => {
  it("403s adopt for networkScan:write + assets:read", async () => {
    // The load-bearing assertion of this file: running is not adopting.
    const agent = await loginAs(scanOnlyUser);
    const csrf = await csrfFor(agent);
    const resp = await agent
      .post("/api/v1/network-scans/runs/00000000-0000-4000-8000-000000000000/adopt")
      .set("x-csrf-token", csrf)
      .send({ addresses: ["10.77.0.1"] });
    expect(resp.status).toBe(403);
  });

  it("lets the same role create and cancel — only adopt is withheld", async () => {
    const agent = await loginAs(scanOnlyUser);
    const csrf = await csrfFor(agent);
    const created = await agent.post("/api/v1/network-scans").set("x-csrf-token", csrf).send(body(`${PFX}-scanonly`));
    expect(created.status).toBe(201);
    madeScanIds.push(created.body.scan.id);
    // Cancelling a run that does not exist is a 404, NOT a 403 — the gate let
    // it through and the lookup answered.
    const cancel = await agent
      .post("/api/v1/network-scans/runs/00000000-0000-4000-8000-000000000000/cancel")
      .set("x-csrf-token", csrf)
      .send({});
    expect(cancel.status).toBe(404);
  });

  it("reaches the adopt handler for a role holding BOTH keys", async () => {
    const agent = await loginAs(writeUser);
    const csrf = await csrfFor(agent);
    const resp = await agent
      .post("/api/v1/network-scans/runs/00000000-0000-4000-8000-000000000000/adopt")
      .set("x-csrf-token", csrf)
      .send({ addresses: ["10.77.0.1"] });
    // 404 from the run lookup rather than 403 from the gate — which is how we
    // know both gates passed.
    expect(resp.status).toBe(404);
  });
});
