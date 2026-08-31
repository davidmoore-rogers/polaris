/**
 * tests/integration/collectSystemInfoGates.test.ts
 *
 * Coverage for collectSystemInfo's dispatch gates — every branch that
 * returns BEFORE any transport I/O (2026-08 audit, prerequisite for
 * splitting the collector). The SNMP/REST collection paths themselves are
 * transport-coupled and stay covered by type-checking + the persistence
 * contract suite; what this pins is the gate ordering: asset lookup,
 * monitored flag, resolved-polling nulls, the agent hand-off, the missing-IP
 * error, credential resolution failure, and the REST eligibility guards
 * (non-Fortinet source, managed switch/AP).
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { collectSystemInfo } from "../../src/services/monitoringService.js";

const d = dbDescribe;
const HOSTNAME = "sysinfo-gates-test";

let assetId = "";

async function seedAsset(extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: HOSTNAME } });
  const asset = await prisma.asset.create({
    data: {
      hostname: HOSTNAME,
      assetType: "server",
      status: "active",
      ipAddress: "10.96.0.2",
      monitored: true,
      ...extra,
    } as never,
  });
  assetId = asset.id;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    await prisma.asset.deleteMany({ where: { hostname: HOSTNAME } });
    await prisma.integration.deleteMany({ where: { name: "sysinfo-gates-fgt" } });
    await prisma.$disconnect();
  } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await seedAsset();
});

d("collectSystemInfo — dispatch gates", () => {
  it("unknown asset → unsupported with reason; unmonitored asset → silent unsupported", async () => {
    const missing = await collectSystemInfo("00000000-0000-0000-0000-000000000000");
    expect(missing).toEqual({ supported: false, error: "Asset not found" });

    await seedAsset({ monitored: false });
    expect(await collectSystemInfo(assetId)).toEqual({ supported: false });
  });

  it("no resolved interfaces stream (manual-source default) → unsupported", async () => {
    // Manual-tier server: defaultPollingForSource leaves interfaces null.
    expect(await collectSystemInfo(assetId)).toEqual({ supported: false });
  });

  it("agent-mode interfaces → unsupported (the agent pushes on its own schedule)", async () => {
    await seedAsset({ interfacesPolling: "agent" });
    expect(await collectSystemInfo(assetId)).toEqual({ supported: false });
  });

  it("snmp interfaces without an IP → unsupported with the no-IP reason", async () => {
    await seedAsset({ interfacesPolling: "snmp", ipAddress: null });
    expect(await collectSystemInfo(assetId)).toEqual({ supported: false, error: "Asset has no IP address" });
  });

  it("snmp interfaces without any SNMP credential → supported:true with a credential error", async () => {
    await seedAsset({ interfacesPolling: "snmp" });
    const out = await collectSystemInfo(assetId);
    expect(out.supported).toBe(true);
    expect(out.data).toBeUndefined();
    expect(out.error).toMatch(/credential/i);
  });

  it("rest_api interfaces on a non-Fortinet source → unsupported", async () => {
    await seedAsset({ interfacesPolling: "rest_api" });
    expect(await collectSystemInfo(assetId)).toEqual({ supported: false });
  });

  it("rest_api interfaces on a managed FortiSwitch → unsupported (not directly REST-able)", async () => {
    await prisma.integration.deleteMany({ where: { name: "sysinfo-gates-fgt" } });
    const integ = await prisma.integration.create({
      data: { type: "fortigate", name: "sysinfo-gates-fgt", config: { host: "192.0.2.10" } },
    });
    await seedAsset({
      assetType: "switch",
      interfacesPolling: "rest_api",
      discoveredByIntegrationId: integ.id,
    });
    expect(await collectSystemInfo(assetId)).toEqual({ supported: false });
  });

  // These used to return {supported:false} — a silent no-op that
  // runTelemetryFor's sibling records as a healthy tick. agentlessHostService
  // supplies the collectors now, so the stream is SUPPORTED and reports a real
  // outcome instead. With no credential resolvable on a bare seeded asset that
  // outcome is an error naming the missing credential, which is the point: the
  // operator finds out, rather than watching an empty chart forever.
  it("winrm / ssh interfaces → supported, and say what is missing", async () => {
    for (const method of ["winrm", "ssh"] as const) {
      await seedAsset({ interfacesPolling: method });
      const res = await collectSystemInfo(assetId);
      expect(res.supported, method).toBe(true);
      expect(res.error, method).toMatch(/credential/i);
    }
  });

  it("vcenter interfaces dispatch BEFORE the IP guard, and want a vCenter source", async () => {
    // The vCenter branch asks the vCenter SERVER, so an asset with no IP is
    // still collectable — it must not fall into the "Asset has no IP address"
    // guard the transport-coupled paths share. With no vCenter AssetSource on
    // file it is a soft error naming the missing link, never silence.
    await seedAsset({ interfacesPolling: "vcenter", ipAddress: null });
    const out = await collectSystemInfo(assetId);
    expect(out.supported).toBe(true);
    expect(out.data).toBeUndefined();
    expect(out.error).toMatch(/vCenter/i);
    expect(out.error).not.toMatch(/IP address/i);
  });
});
