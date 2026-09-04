/**
 * tests/integration/dependencyRecompute.test.ts
 *
 * Coverage for `recomputeDependencyTree`'s treatment of RETIRED infra assets.
 *
 * Rule 10 forces `monitored=false` on a decommissioned or disabled device, and
 * `evaluateSuppression` treats an unmonitored parent as TRANSPARENT — it walks
 * up to the grandparents and, finding none, returns "ok". A firewall is layer 1
 * and has no parents, so a retired gate left in the graph is a permanent
 * "everything is fine" vote that vetoes suppression for every child still bound
 * to it, and unlike a live gate it can never go down again. The recompute must
 * therefore drop retired assets from the GRAPH while keeping them in SCOPE, so
 * their own rows are deleted rather than merely frozen.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { recomputeDependencyTree } from "../../src/services/dependencyTreeService.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;
const HOST = "dep-recompute-test";
const GATE_SERIAL = "FGRECOMPUTEA";

let gateId = "";
let swId = "";

async function wipe(): Promise<void> {
  await prisma.assetDependencyParent.deleteMany({ where: { asset: { hostname: { startsWith: HOST } } } });
  await prisma.assetDependencyParent.deleteMany({ where: { parent: { hostname: { startsWith: HOST } } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

/** A gate plus one FortiSwitch stamped with that gate's serial as controller. */
async function seed(gateStatus: string): Promise<void> {
  await wipe();
  const gate = await prisma.asset.create({
    data: {
      hostname: `${HOST}-gate`, assetType: "firewall", serialNumber: GATE_SERIAL,
      status: gateStatus, monitored: gateStatus === "active",
    } as never,
  });
  const sw = await prisma.asset.create({
    data: {
      hostname: `${HOST}-sw`, assetType: "switch", serialNumber: "S248RECOMPUTE1",
      status: "active", monitored: true,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: `${HOST}-gate`, controllerSerial: GATE_SERIAL },
    } as never,
  });
  gateId = gate.id; swId = sw.id;
}

const parentsOf = (assetId: string) =>
  prisma.assetDependencyParent.findMany({ where: { assetId }, select: { parentAssetId: true, source: true } });

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  try { await wipe(); await prisma.$disconnect(); } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
});

d("recomputeDependencyTree — retired infra assets", () => {
  it("binds a switch to its ACTIVE controller gate", async () => {
    await seed("active");
    await recomputeDependencyTree();
    const parents = await parentsOf(swId);
    expect(parents).toEqual([{ parentAssetId: gateId, source: "computed" }]);
  });

  it("drops the edge when the gate is decommissioned", async () => {
    await seed("decommissioned");
    await recomputeDependencyTree();
    expect(await parentsOf(swId)).toEqual([]);
  });

  it("drops the edge when the gate is disabled", async () => {
    await seed("disabled");
    await recomputeDependencyTree();
    expect(await parentsOf(swId)).toEqual([]);
  });

  it("removes an edge already on disk once the gate is decommissioned", async () => {
    // The real sequence: the tree was built while the gate was live, then the
    // gate was retired. A recompute has to RETRACT the row, not just decline
    // to re-create it.
    await seed("active");
    await recomputeDependencyTree();
    expect(await parentsOf(swId)).toHaveLength(1);

    await prisma.asset.update({
      where: { id: gateId },
      data: { status: "decommissioned", monitored: false } as never,
    });
    await recomputeDependencyTree();
    expect(await parentsOf(swId)).toEqual([]);
  });

  it("keeps the gate in SCOPE so a retired switch's own rows are deleted, not frozen", async () => {
    // A retired asset dropped from the READ would never come back into scope,
    // so its stale parent rows would survive forever. It stays in scope and
    // simply produces no edges.
    await seed("active");
    await recomputeDependencyTree();
    expect(await parentsOf(swId)).toHaveLength(1);

    await prisma.asset.update({
      where: { id: swId },
      data: { status: "decommissioned", monitored: false } as never,
    });
    await recomputeDependencyTree();
    expect(await parentsOf(swId)).toEqual([]);
    const row = await prisma.asset.findUnique({ where: { id: swId }, select: { dependencyLayer: true } });
    expect(row?.dependencyLayer).toBeNull();
  });

  it("leaves an operator override alone — retirement is not an override's business", async () => {
    await seed("decommissioned");
    await prisma.assetDependencyParent.create({
      data: { assetId: swId, parentAssetId: gateId, source: "override", detectedVia: "manual" } as never,
    });
    await recomputeDependencyTree();
    expect(await parentsOf(swId)).toEqual([{ parentAssetId: gateId, source: "override" }]);
  });
});

// ─── membership constrains a real recompute ─────────────────────────────────
//
// The unit tests cover the pure rule. These pin the half that only exists in
// the DB: the gate's stamped roster surviving outside a discovery run, which is
// the whole reason membership is persisted rather than passed in memory (the
// boot backfill calls recomputeDependencyTree with no DiscoveryResult).

const OTHER_SERIAL = "FGRECOMPUTEB";
const SW_SERIAL = "S248RECOMPUTE1";

/** A second gate that does NOT manage the switch, plus a stored LLDP edge to it. */
async function seedTwoGates(members: string[] | undefined): Promise<string> {
  await seed("active");
  const other = await prisma.asset.create({
    data: {
      hostname: `${HOST}-gate-other`, assetType: "firewall", serialNumber: OTHER_SERIAL,
      status: "active", monitored: true,
      fortinetTopology: members === undefined
        ? { role: "fortigate" }
        : { role: "fortigate", managedSwitchSerials: members },
    } as never,
  });
  // An LLDP neighbour row on the switch resolving to the other gate -- the prod
  // shape, where matchedAssetId was frozen pointing at the wrong asset.
  await prisma.assetLldpNeighbor.create({
    data: {
      assetId: swId, localIfName: "port-30", systemName: `${HOST}-gate`,
      matchedAssetId: other.id, source: "snmp", lastSeen: new Date(),
    } as never,
  });
  return other.id;
}

d("recomputeDependencyTree — controller membership", () => {
  it("drops the LLDP edge to a gate whose stamped roster omits the switch", async () => {
    const otherId = await seedTwoGates(["S248SOMEOTHER"]);
    await recomputeDependencyTree();
    const parents = await parentsOf(swId);
    expect(parents.map(p => p.parentAssetId)).not.toContain(otherId);
    expect(parents).toEqual([{ parentAssetId: gateId, source: "computed" }]);
  });

  it("drops it for a KNOWN-EMPTY roster too", async () => {
    const otherId = await seedTwoGates([]);
    await recomputeDependencyTree();
    expect((await parentsOf(swId)).map(p => p.parentAssetId)).not.toContain(otherId);
  });

  it("keeps the edge when the gate has NO membership stamp (unknown)", async () => {
    // Pre-feature rows and failed roster reads must behave exactly as before,
    // or a gate Polaris could not ask about silently loses its subtree.
    const otherId = await seedTwoGates(undefined);
    await recomputeDependencyTree();
    expect((await parentsOf(swId)).map(p => p.parentAssetId)).toContain(otherId);
  });

  it("keeps the edge when the roster DOES list the switch", async () => {
    const otherId = await seedTwoGates([SW_SERIAL]);
    await recomputeDependencyTree();
    expect((await parentsOf(swId)).map(p => p.parentAssetId)).toContain(otherId);
  });
});
