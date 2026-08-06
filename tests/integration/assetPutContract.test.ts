/**
 * tests/integration/assetPutContract.test.ts
 *
 * Contract coverage for PUT /api/v1/assets/:id — the ~292-line operator-edit
 * handler. Written as the PREREQUISITE for splitting it (2026-08 audit; same
 * tests-first sequencing as the agents /samples split): the guards, the
 * pin/override semantics, the status stamps, and the unmap side effect are
 * pinned here so the later re-homing has a net. The pin ENFORCEMENT halves
 * (applyHostnameOverride / applyIpOverride) are separately unit-tested; this
 * suite covers the route-level set/clear/echo behavior on top.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const HOST = "asset-put-contract-test";
let assetId = "";

async function seedAsset(extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.assetProcessConnection.deleteMany({ where: { asset: { hostname: { startsWith: HOST } } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
  const asset = await prisma.asset.create({
    data: {
      hostname: HOST,
      assetType: "server",
      status: "active",
      ipAddress: "10.97.0.10",
      monitored: false,
      ...extra,
    } as never,
  });
  assetId = asset.id;
}

async function put(body: unknown, id = assetId) {
  const { agent, csrf } = await authedAgent(app);
  return agent
    .put(`/api/v1/assets/${id}`)
    .set("X-CSRF-Token", csrf)
    .send(body as object);
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    await prisma.assetProcessConnection.deleteMany({ where: { asset: { hostname: { startsWith: HOST } } } });
    await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
    await prisma.$disconnect();
  } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await seedAsset();
});

d("PUT /assets/:id contract", () => {
  it("404s an unknown asset id", async () => {
    const resp = await put({ notes: "x" }, "00000000-0000-0000-0000-000000000000");
    expect(resp.status).toBe(404);
  });

  it("rejects a polling method incompatible with the asset's source kind", async () => {
    // The manual source kind allows every method — the guard bites on
    // integration-discovered assets. An AD-sourced asset can't be REST-probed
    // (rest_api is Fortinet-only in the compatibility matrix).
    const integration = await prisma.integration.create({
      data: { name: `${HOST}-ad-intg`, type: "activedirectory", enabled: false, config: {} as never },
    });
    try {
      await seedAsset({ discoveredByIntegrationId: integration.id });
      const resp = await put({ responseTimePolling: "rest_api" });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toMatch(/not supported/i);
    } finally {
      await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
      await prisma.integration.delete({ where: { id: integration.id } });
    }
  });

  it("rejects vcenter polling at the input schema (set via the monitor-settings flow, not this PUT)", async () => {
    // UpdateAssetSchema's polling enum deliberately excludes "vcenter" — the
    // handler's deeper vcenter-vm-source check guards the monitor-settings
    // pathway. Through this route the rejection is schema-level.
    const wrongStream = await put({ responseTimePolling: "vcenter" });
    expect(wrongStream.status).toBe(400);

    const cpuMem = await put({ cpuMemoryPolling: "vcenter" });
    expect(cpuMem.status).toBe(400);
    expect(cpuMem.body.error).toMatch(/vcenter/i);
  });

  it("locks assetType on integration-discovered Fortinet infrastructure", async () => {
    const integration = await prisma.integration.create({
      data: { name: `${HOST}-intg`, type: "fortigate", enabled: false, config: {} as never },
    });
    try {
      await seedAsset({ assetType: "switch", discoveredByIntegrationId: integration.id });
      const resp = await put({ assetType: "server" });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toMatch(/locked/i);
    } finally {
      await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
      await prisma.integration.delete({ where: { id: integration.id } });
    }
  });

  it("refuses quarantine transitions through the generic PUT", async () => {
    const intoQuarantine = await put({ status: "quarantined" });
    expect(intoQuarantine.status).toBe(400);
    expect(intoQuarantine.body.error).toMatch(/quarantine/i);

    await seedAsset({ status: "quarantined" });
    const outOfQuarantine = await put({ status: "active" });
    expect(outOfQuarantine.status).toBe(400);
    expect(outOfQuarantine.body.error).toMatch(/release the quarantine/i);
  });

  it("hostname: a real change pins, an echo does not, a clear releases to the projection", async () => {
    // Change → pin.
    let resp = await put({ hostname: `${HOST}-renamed` });
    expect(resp.status).toBe(200);
    let row = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(row?.hostname).toBe(`${HOST}-renamed`);
    expect(row?.hostnameOverride).toBe(`${HOST}-renamed`);

    // Echoing the current hostname back must NOT alter the pin state.
    await prisma.asset.update({ where: { id: assetId }, data: { hostnameOverride: null } });
    resp = await put({ hostname: `${HOST}-renamed` });
    expect(resp.status).toBe(200);
    row = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(row?.hostnameOverride).toBeNull();

    // Clear → releases the pin and reverts to the discovery projection
    // (null for a manually created asset with no sources).
    await prisma.asset.update({ where: { id: assetId }, data: { hostnameOverride: `${HOST}-renamed` } });
    resp = await put({ hostname: "" });
    expect(resp.status).toBe(200);
    row = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(row?.hostnameOverride).toBeNull();
    expect(row?.hostname).toBeNull();
  });

  it("ipAddress: a real change pins with ipSource=manual, a clear releases", async () => {
    let resp = await put({ ipAddress: "10.97.0.99" });
    expect(resp.status).toBe(200);
    let row = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(row?.ipAddress).toBe("10.97.0.99");
    expect(row?.ipOverride).toBe("10.97.0.99");
    expect(row?.ipSource).toBe("manual");

    resp = await put({ ipAddress: "" });
    expect(resp.status).toBe(200);
    row = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(row?.ipOverride).toBeNull();
    expect(row?.ipAddress).toBeNull(); // no sources to project from
  });

  it("a status change stamps statusChangedAt/By, and decommissioned clamps monitored off", async () => {
    await prisma.asset.update({ where: { id: assetId }, data: { monitored: true } });
    const resp = await put({ status: "decommissioned" });
    expect(resp.status).toBe(200);
    const row = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(row?.status).toBe("decommissioned");
    expect(row?.statusChangedAt).not.toBeNull();
    expect(row?.statusChangedBy).toBeTruthy();
    // Business rule 10: decommissioned/disabled force monitored=false.
    expect(row?.monitored).toBe(false);
  });

  it("unmapping a process deletes its accumulated connection rows immediately", async () => {
    await prisma.asset.update({ where: { id: assetId }, data: { mappedProcesses: ["postgres", "nginx"] } });
    await prisma.assetProcessConnection.createMany({
      data: [
        { assetId, processName: "postgres", kind: "listen", proto: "tcp", localPort: 5432 },
        { assetId, processName: "nginx", kind: "listen", proto: "tcp", localPort: 80 },
      ] as never,
    });

    const resp = await put({ mappedProcesses: ["nginx"] });
    expect(resp.status).toBe(200);
    const rows = await prisma.assetProcessConnection.findMany({ where: { assetId } });
    expect(rows.map((r) => r.processName)).toEqual(["nginx"]);
  });
});
