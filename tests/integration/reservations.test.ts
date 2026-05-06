/**
 * tests/integration/reservations.test.ts
 *
 * Integration tests for /api/v1/reservations. Skips cleanly when
 * DATABASE_URL isn't reachable; see tests/integration/_helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
});

/** Quick scaffold: block + subnet ready to host reservations. */
async function scaffold(agent: any, csrf: string, blockCidr: string, subnetCidr: string) {
  const block = await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name: "B", cidr: blockCidr });
  if (block.status !== 201) throw new Error(`block create: ${block.status} ${JSON.stringify(block.body)}`);
  const subnet = await agent
    .post("/api/v1/subnets")
    .set("X-CSRF-Token", csrf)
    .send({ blockId: block.body.id, cidr: subnetCidr, name: "S" });
  if (subnet.status !== 201) throw new Error(`subnet create: ${subnet.status} ${JSON.stringify(subnet.body)}`);
  return { block: block.body, subnet: subnet.body };
}

// ─── POST /api/v1/reservations ────────────────────────────────────────────────

d("POST /api/v1/reservations", () => {
  it("creates a specific-IP reservation and returns 201", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.10.0.0/16", "10.10.1.0/24");
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.10.1.5", hostname: "host-a", owner: "alice" });
    expect(resp.status).toBe(201);
    expect(resp.body.ipAddress).toBe("10.10.1.5");
    expect(resp.body.status).toBe("active");
    expect(resp.body.sourceType).toBe("manual");
  });

  it("creates a full-subnet reservation and marks subnet as reserved", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.20.0.0/16", "10.20.1.0/24");
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, hostname: "whole-subnet", owner: "alice" });
    expect(resp.status).toBe(201);
    expect(resp.body.ipAddress).toBeNull();
    const after = await agent.get(`/api/v1/subnets/${subnet.id}`);
    expect(after.body.status).toBe("reserved");
  });

  it("returns 400 for an IP not within the subnet", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.30.0.0/16", "10.30.1.0/24");
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.30.2.5", hostname: "out-of-range" });
    expect(resp.status).toBe(400);
    expect(String(resp.body?.error || "")).toMatch(/not within subnet/i);
  });

  it("returns 409 for a duplicate active reservation on the same IP", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.40.0.0/16", "10.40.1.0/24");
    const ok = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.40.1.5", hostname: "first" });
    expect(ok.status).toBe(201);
    const dup = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.40.1.5", hostname: "second" });
    expect(dup.status).toBe(409);
  });

  it("returns 409 when reserving on a deprecated subnet", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.50.0.0/16", "10.50.1.0/24");
    await agent.put(`/api/v1/subnets/${subnet.id}`).set("X-CSRF-Token", csrf).send({ status: "deprecated" });
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.50.1.5", hostname: "blocked" });
    expect(resp.status).toBe(409);
    expect(String(resp.body?.error || "")).toMatch(/deprecated/i);
  });
});

// ─── GET /api/v1/reservations ─────────────────────────────────────────────────

d("GET /api/v1/reservations", () => {
  it("lists all reservations", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.60.0.0/16", "10.60.1.0/24");
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.60.1.5", hostname: "h1" });
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.60.1.6", hostname: "h2" });
    const resp = await agent.get("/api/v1/reservations");
    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body)).toBe(true);
    expect(resp.body.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by owner", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.70.0.0/16", "10.70.1.0/24");
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.70.1.5", hostname: "h1", owner: "alice" });
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.70.1.6", hostname: "h2", owner: "bob" });
    const resp = await agent.get("/api/v1/reservations?owner=alice");
    expect(resp.status).toBe(200);
    expect(resp.body.every((r: any) => r.owner === "alice")).toBe(true);
    expect(resp.body.length).toBe(1);
  });

  it("filters by projectRef", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.80.0.0/16", "10.80.1.0/24");
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.80.1.5", hostname: "h1", owner: "x", projectRef: "proj-a" });
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.80.1.6", hostname: "h2", owner: "y", projectRef: "proj-b" });
    const resp = await agent.get("/api/v1/reservations?projectRef=proj-a");
    expect(resp.body.every((r: any) => r.projectRef === "proj-a")).toBe(true);
    expect(resp.body.length).toBe(1);
  });

  it("filters by status (active by default)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.90.0.0/16", "10.90.1.0/24");
    const r = await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.90.1.5", hostname: "h1" });
    await agent.delete(`/api/v1/reservations/${r.body.id}`).set("X-CSRF-Token", csrf);
    const released = await agent.get("/api/v1/reservations?status=released");
    const active = await agent.get("/api/v1/reservations?status=active");
    expect(released.body.length).toBe(1);
    expect(active.body.find((x: any) => x.id === r.body.id)).toBeUndefined();
  });
});

// ─── GET /api/v1/reservations/:id ────────────────────────────────────────────

d("GET /api/v1/reservations/:id", () => {
  it("returns the reservation", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.100.0.0/16", "10.100.1.0/24");
    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.100.1.5", hostname: "h1" });
    const resp = await agent.get(`/api/v1/reservations/${created.body.id}`);
    expect(resp.status).toBe(200);
    expect(resp.body.id).toBe(created.body.id);
    expect(resp.body.ipAddress).toBe("10.100.1.5");
  });

  it("returns 404 for an unknown id", async () => {
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/reservations/00000000-0000-0000-0000-000000000000");
    expect(resp.status).toBe(404);
  });
});

// ─── PUT /api/v1/reservations/:id ────────────────────────────────────────────

d("PUT /api/v1/reservations/:id", () => {
  it("updates reservation metadata (hostname, owner, notes)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.110.0.0/16", "10.110.1.0/24");
    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.110.1.5", hostname: "old", owner: "alice" });
    const resp = await agent
      .put(`/api/v1/reservations/${created.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ hostname: "new", owner: "bob", notes: "post-rename" });
    expect(resp.status).toBe(200);
    expect(resp.body.hostname).toBe("new");
    expect(resp.body.owner).toBe("bob");
    expect(resp.body.notes).toBe("post-rename");
  });

  it("extends the TTL via expiresAt", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.120.0.0/16", "10.120.1.0/24");
    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.120.1.5", hostname: "ttl" });
    const newExpiry = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const resp = await agent
      .put(`/api/v1/reservations/${created.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ expiresAt: newExpiry });
    expect(resp.status).toBe(200);
    expect(new Date(resp.body.expiresAt).toISOString()).toBe(newExpiry);
  });

  it("returns 409 when trying to update a released reservation", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.130.0.0/16", "10.130.1.0/24");
    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.130.1.5", hostname: "h" });
    await agent.delete(`/api/v1/reservations/${created.body.id}`).set("X-CSRF-Token", csrf);
    const resp = await agent
      .put(`/api/v1/reservations/${created.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ hostname: "nope" });
    expect(resp.status).toBe(409);
  });
});

// ─── DELETE /api/v1/reservations/:id ─────────────────────────────────────────

d("DELETE /api/v1/reservations/:id", () => {
  it("releases an active reservation and returns 204", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.140.0.0/16", "10.140.1.0/24");
    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.140.1.5", hostname: "h" });
    const resp = await agent.delete(`/api/v1/reservations/${created.body.id}`).set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(204);
    // Status flips to released; the row stays around so audit history works.
    const fresh = await prisma.reservation.findUnique({ where: { id: created.body.id } });
    expect(fresh!.status).toBe("released");
  });

  it("restores subnet status to available after a full-subnet release", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.150.0.0/16", "10.150.1.0/24");
    const r = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, hostname: "whole" });
    const before = await agent.get(`/api/v1/subnets/${subnet.id}`);
    expect(before.body.status).toBe("reserved");
    await agent.delete(`/api/v1/reservations/${r.body.id}`).set("X-CSRF-Token", csrf);
    const after = await agent.get(`/api/v1/subnets/${subnet.id}`);
    expect(after.body.status).toBe("available");
  });

  it("returns 409 when reservation is already released", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.160.0.0/16", "10.160.1.0/24");
    const r = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.160.1.5", hostname: "h" });
    await agent.delete(`/api/v1/reservations/${r.body.id}`).set("X-CSRF-Token", csrf);
    const resp = await agent.delete(`/api/v1/reservations/${r.body.id}`).set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(409);
  });
});
