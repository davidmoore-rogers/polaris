/**
 * tests/integration/subnets.test.ts
 *
 * Integration tests for /api/v1/subnets. Skips cleanly when DATABASE_URL
 * isn't reachable; see tests/integration/_helpers.ts.
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

/** Create a parent block; returns the block row. */
async function createBlock(agent: any, csrf: string, name: string, cidr: string) {
  const resp = await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name, cidr });
  if (resp.status !== 201) throw new Error(`Block create failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  return resp.body;
}

// ─── POST /api/v1/subnets ─────────────────────────────────────────────────────

d("POST /api/v1/subnets", () => {
  it("carves a subnet from a valid block and returns 201", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.10.0.0/16");
    const resp = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.10.1.0/24", name: "Office VLAN", vlan: 100 });
    expect(resp.status).toBe(201);
    expect(resp.body.cidr).toBe("10.10.1.0/24");
    expect(resp.body.status).toBe("available");
    expect(resp.body.vlan).toBe(100);
  });

  it("normalizes the CIDR (zeros host bits) on create", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.11.0.0/16");
    const resp = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.11.1.7/24", name: "Sloppy" });
    expect(resp.status).toBe(201);
    expect(resp.body.cidr).toBe("10.11.1.0/24");
  });

  it("returns 400 for an invalid CIDR", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.12.0.0/16");
    const resp = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "not-a-cidr", name: "Bad" });
    expect(resp.status).toBe(400);
  });

  it("returns 400 when subnet is not within its parent block", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.13.0.0/16");
    const resp = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.99.1.0/24", name: "Outside" });
    expect(resp.status).toBe(400);
    expect(String(resp.body?.error || "")).toMatch(/not within block/i);
  });

  it("returns 409 when subnet overlaps with a sibling", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.14.0.0/16");
    await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.14.0.0/24", name: "Sib-1" });
    const overlap = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.14.0.0/25", name: "Sib-2" });
    expect(overlap.status).toBe(409);
    expect(String(overlap.body?.error || "")).toMatch(/overlap/i);
  });
});

// ─── POST /api/v1/subnets/next-available ──────────────────────────────────────

d("POST /api/v1/subnets/next-available", () => {
  it("auto-allocates the next available subnet of the requested prefix length", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.20.0.0/16");
    const r1 = await agent
      .post("/api/v1/subnets/next-available")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, prefixLength: 24, name: "Auto-1" });
    expect(r1.status).toBe(201);
    expect(r1.body.cidr).toBe("10.20.0.0/24");
    const r2 = await agent
      .post("/api/v1/subnets/next-available")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, prefixLength: 24, name: "Auto-2" });
    expect(r2.status).toBe(201);
    expect(r2.body.cidr).toBe("10.20.1.0/24");
  });

  it("returns 409 when no space remains in the block", async () => {
    const { agent, csrf } = await authedAgent(app);
    // /30 block holds exactly one /30; allocate it then ask for another.
    const block = await createBlock(agent, csrf, "Tiny", "10.21.0.0/30");
    const ok = await agent
      .post("/api/v1/subnets/next-available")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, prefixLength: 30, name: "Only" });
    expect(ok.status).toBe(201);
    const full = await agent
      .post("/api/v1/subnets/next-available")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, prefixLength: 30, name: "Overflow" });
    expect(full.status).toBe(409);
  });
});

// ─── GET /api/v1/subnets ──────────────────────────────────────────────────────

d("GET /api/v1/subnets", () => {
  it("lists all subnets", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.30.0.0/16");
    await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.30.1.0/24", name: "A" });
    await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.30.2.0/24", name: "B" });
    const resp = await agent.get("/api/v1/subnets");
    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body)).toBe(true);
    expect(resp.body.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by blockId", async () => {
    const { agent, csrf } = await authedAgent(app);
    const a = await createBlock(agent, csrf, "A", "10.40.0.0/16");
    const b = await createBlock(agent, csrf, "B", "10.41.0.0/16");
    await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: a.id, cidr: "10.40.1.0/24", name: "in-A" });
    await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: b.id, cidr: "10.41.1.0/24", name: "in-B" });
    const resp = await agent.get(`/api/v1/subnets?blockId=${a.id}`);
    expect(resp.status).toBe(200);
    expect(resp.body.every((s: any) => s.blockId === a.id)).toBe(true);
    expect(resp.body.length).toBe(1);
  });

  it("filters by status", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.50.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.50.1.0/24", name: "S" });
    await agent.put(`/api/v1/subnets/${sub.body.id}`).set("X-CSRF-Token", csrf).send({ status: "deprecated" });
    const dep = await agent.get("/api/v1/subnets?status=deprecated");
    const avl = await agent.get("/api/v1/subnets?status=available");
    expect(dep.body.every((s: any) => s.status === "deprecated")).toBe(true);
    expect(dep.body.length).toBe(1);
    expect(avl.body.find((s: any) => s.id === sub.body.id)).toBeUndefined();
  });
});

// ─── GET /api/v1/subnets/:id ──────────────────────────────────────────────────

d("GET /api/v1/subnets/:id", () => {
  it("returns the subnet with its reservations", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.60.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.60.1.0/24", name: "S" });
    await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: sub.body.id, ipAddress: "10.60.1.10", hostname: "h01" });

    const resp = await agent.get(`/api/v1/subnets/${sub.body.id}`);
    expect(resp.status).toBe(200);
    expect(resp.body.id).toBe(sub.body.id);
    expect(Array.isArray(resp.body.reservations)).toBe(true);
    expect(resp.body.reservations.length).toBe(1);
    expect(resp.body.reservations[0].ipAddress).toBe("10.60.1.10");
  });

  it("returns 404 for an unknown id", async () => {
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/subnets/00000000-0000-0000-0000-000000000000");
    expect(resp.status).toBe(404);
  });
});

// ─── PUT /api/v1/subnets/:id ──────────────────────────────────────────────────

d("PUT /api/v1/subnets/:id", () => {
  it("updates subnet metadata (name, purpose, vlan, tags)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.70.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.70.1.0/24", name: "Old" });
    const resp = await agent
      .put(`/api/v1/subnets/${sub.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ name: "New", purpose: "renamed", vlan: 200, tags: ["x", "y"] });
    expect(resp.status).toBe(200);
    expect(resp.body.name).toBe("New");
    expect(resp.body.purpose).toBe("renamed");
    expect(resp.body.vlan).toBe(200);
    expect(resp.body.tags).toEqual(["x", "y"]);
  });

  it("updates subnet status (available → deprecated)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.71.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.71.1.0/24", name: "S" });
    const resp = await agent
      .put(`/api/v1/subnets/${sub.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ status: "deprecated" });
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe("deprecated");
  });
});

// ─── DELETE /api/v1/subnets/:id ───────────────────────────────────────────────

d("DELETE /api/v1/subnets/:id", () => {
  it("deletes a subnet with no active reservations", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.80.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.80.1.0/24", name: "S" });
    const resp = await agent.delete(`/api/v1/subnets/${sub.body.id}`).set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(204);
    const after = await agent.get(`/api/v1/subnets/${sub.body.id}`);
    expect(after.status).toBe(404);
  });

  it("returns 409 when active reservations exist", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.81.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.81.1.0/24", name: "S" });
    await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: sub.body.id, ipAddress: "10.81.1.5", hostname: "h01" });
    const resp = await agent.delete(`/api/v1/subnets/${sub.body.id}`).set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(409);
  });
});
