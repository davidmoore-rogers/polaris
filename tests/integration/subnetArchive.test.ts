/**
 * tests/integration/subnetArchive.test.ts
 *
 * The subnet archive and the chassis-replacement conflict (business rule 41),
 * against a real Postgres. Skips cleanly when DATABASE_URL isn't reachable;
 * see tests/integration/_helpers.ts.
 *
 * The one assertion this file exists for is FREES THE CIDR. Everything else in
 * the feature is downstream of it: a retired subnet used to stay in `subnets`
 * as `status="deprecated"`, still holding `@@unique([blockId, cidr])`, so a
 * replacement gate serving the same address space could never be recorded —
 * discovery's lookup index skips deprecated rows (no update path) while
 * `createSubnetRowChecked`'s overlap check counts them (no create path), and
 * the subnet was skipped on every run with a self-overlap message. The
 * "a deprecated row still blocks it" test below pins the old behaviour so the
 * archive's reason for existing stays visible.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  snapshotSubnet,
  archiveSubnet,
  getArchivedSubnet,
  listArchivedSubnets,
} from "../../src/services/subnetArchiveService.js";
import {
  raiseChassisReplacedConflict,
  acceptChassisReplacement,
  buildChassisDiff,
} from "../../src/services/subnetChassisConflictService.js";
import { createSubnetRowChecked } from "../../src/services/subnetService.js";

const d = dbDescribe;

// Synthetic serials — never paste real fleet serials into tests.
const OLD_SN = "FGT60FTK00000001";
const NEW_SN = "FGT81FTK00000002";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.conflict.deleteMany();
  await prisma.archivedSubnet.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
});

async function seed(opts: { cidr?: string; serial?: string | null } = {}) {
  const cidr = opts.cidr ?? "10.77.1.0/24";
  const block = await prisma.ipBlock.create({
    data: { name: "Archive Test Block", cidr: "10.77.0.0/16", ipVersion: "v4" },
  });
  const subnet = await prisma.subnet.create({
    data: {
      blockId: block.id,
      cidr,
      name: "DHCP: lan (gate-a)",
      status: "available",
      fortigateDevice: "gate-a",
      fortigateSerial: opts.serial === undefined ? OLD_SN : opts.serial,
    },
  });
  await prisma.reservation.createMany({
    data: [
      { subnetId: subnet.id, ipAddress: "10.77.1.10", hostname: "printer", sourceType: "manual", status: "active" },
      { subnetId: subnet.id, ipAddress: "10.77.1.11", hostname: "cam", sourceType: "dhcp_reservation", status: "active" },
      { subnetId: subnet.id, ipAddress: "10.77.1.1", hostname: "gw", sourceType: "interface_ip", status: "active" },
    ],
  });
  return { block, subnet };
}

d("subnet archive — snapshot", () => {
  it("copies the subnet and every reservation, leaving the live rows alone", async () => {
    const { subnet } = await seed();

    const snap = await snapshotSubnet(subnet.id, { reason: "chassis-replaced", actor: "tester" });
    expect(snap.reservationCount).toBe(3);

    const archived = await getArchivedSubnet(snap.archivedSubnetId);
    expect(archived.cidr).toBe("10.77.1.0/24");
    expect(archived.fortigateSerial).toBe(OLD_SN);
    expect(archived.archiveReason).toBe("chassis-replaced");
    expect(archived.reservations).toHaveLength(3);
    // Block identity is denormalized so the archive survives a block deletion.
    expect(archived.blockCidr).toBe("10.77.0.0/16");

    // Additive: nothing was removed.
    expect(await prisma.subnet.count({ where: { id: subnet.id } })).toBe(1);
    expect(await prisma.reservation.count({ where: { subnetId: subnet.id } })).toBe(3);
  });

  it("does not carry the device-side push pointers forward", async () => {
    // They address a DHCP entry in a scope on a chassis that no longer exists.
    const { subnet } = await seed();
    const snap = await snapshotSubnet(subnet.id, { reason: "operator", actor: null });
    const archived = await getArchivedSubnet(snap.archivedSubnetId);
    for (const r of archived.reservations) {
      expect(r).not.toHaveProperty("pushedScopeId");
      expect(r).not.toHaveProperty("pushedEntryId");
    }
  });
});

d("subnet archive — retire", () => {
  it("a DEPRECATED row still blocks its CIDR — the reason the archive exists", async () => {
    const { block, subnet } = await seed();
    await prisma.subnet.update({ where: { id: subnet.id }, data: { status: "deprecated" } });

    await expect(
      createSubnetRowChecked({
        blockId: block.id,
        cidr: "10.77.1.0/24",
        name: "DHCP: lan (gate-b)",
        status: "available",
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("archiving frees the CIDR so a replacement gate's subnet can be created", async () => {
    const { block, subnet } = await seed();

    const result = await archiveSubnet(subnet.id, { actor: "tester" });
    expect(result.reservationCount).toBe(3);

    // Live rows gone, archive intact.
    expect(await prisma.subnet.count({ where: { id: subnet.id } })).toBe(0);
    expect(await prisma.reservation.count({ where: { subnetId: subnet.id } })).toBe(0);
    const archived = await getArchivedSubnet(result.archivedSubnetId);
    expect(archived.reservations).toHaveLength(3);

    // The whole point.
    const fresh = await createSubnetRowChecked({
      blockId: block.id,
      cidr: "10.77.1.0/24",
      name: "DHCP: lan (gate-b)",
      status: "available",
      fortigateDevice: "gate-b",
      fortigateSerial: NEW_SN,
    });
    expect(fresh.cidr).toBe("10.77.1.0/24");
    expect(fresh.fortigateSerial).toBe(NEW_SN);
  });

  it("archived rows survive deletion of the block they came from", async () => {
    // No FK out to ip_blocks, deliberately: subnets cascade from blocks, so an
    // FK would let a block deletion erase the archive.
    const { block, subnet } = await seed();
    const snap = await snapshotSubnet(subnet.id, { reason: "operator", actor: null });

    await prisma.reservation.deleteMany({ where: { subnetId: subnet.id } });
    await prisma.ipBlock.delete({ where: { id: block.id } });

    const archived = await getArchivedSubnet(snap.archivedSubnetId);
    expect(archived.cidr).toBe("10.77.1.0/24");
    expect(archived.blockCidr).toBe("10.77.0.0/16");
  });

  it("lists newest first with an unpaged total", async () => {
    const { subnet } = await seed();
    await archiveSubnet(subnet.id, { actor: "tester" });
    const listed = await listArchivedSubnets({ limit: 10 });
    expect(listed.total).toBe(1);
    expect(listed.archivedSubnets[0]!.cidr).toBe("10.77.1.0/24");
  });
});

d("chassis-replacement conflict", () => {
  async function raise(subnetId: string, blockId: string, from = OLD_SN, to = NEW_SN) {
    const snap = await snapshotSubnet(subnetId, { reason: "chassis-replaced", actor: null });
    return raiseChassisReplacedConflict({
      subnetId,
      cidr: "10.77.1.0/24",
      blockId,
      oldSerial: from,
      newSerial: to,
      oldDeviceName: "gate-a",
      newDeviceName: "gate-a",
      archivedSubnetId: snap.archivedSubnetId,
    });
  }

  it("raises one pending conflict carrying the serial pair", async () => {
    const { block, subnet } = await seed();
    expect(await raise(subnet.id, block.id)).toBe("raised");

    const rows = await prisma.conflict.findMany({ where: { entityType: "subnet" } });
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.proposedSubnetFields as any;
    expect(payload.collisionReason).toBe("chassis-replaced");
    expect(payload.oldSerial).toBe(OLD_SN);
    expect(payload.newSerial).toBe(NEW_SN);
  });

  it("refreshes rather than stacking duplicates on a later run", async () => {
    const { block, subnet } = await seed();
    await raise(subnet.id, block.id);
    expect(await raise(subnet.id, block.id)).toBe("refreshed");
    expect(await prisma.conflict.count({ where: { entityType: "subnet" } })).toBe(1);
  });

  it("a rejected pair never re-raises, but a different pair does", async () => {
    const { block, subnet } = await seed();
    await raise(subnet.id, block.id);
    await prisma.conflict.updateMany({ where: { entityType: "subnet" }, data: { status: "rejected" } });

    expect(await raise(subnet.id, block.id)).toBe("suppressed");
    // Swapped a second time — a genuinely new transition.
    expect(await raise(subnet.id, block.id, OLD_SN, "FGT81FTK00000003")).toBe("raised");
  });

  it("refuses to raise when the serials are equal or blank", async () => {
    const { block, subnet } = await seed();
    const snap = await snapshotSubnet(subnet.id, { reason: "chassis-replaced", actor: null });
    const base = {
      subnetId: subnet.id, cidr: "10.77.1.0/24", blockId: block.id,
      archivedSubnetId: snap.archivedSubnetId,
    };
    expect(await raiseChassisReplacedConflict({ ...base, oldSerial: OLD_SN, newSerial: OLD_SN })).toBe("suppressed");
    expect(await raiseChassisReplacedConflict({ ...base, oldSerial: "", newSerial: NEW_SN })).toBe("suppressed");
  });

  it("the diff reads the archive against the live subnet, and refuses device-owned lines", async () => {
    const { block, subnet } = await seed();
    await raise(subnet.id, block.id);

    // The new gate reports one of the old addresses and one of its own.
    await prisma.reservation.deleteMany({ where: { subnetId: subnet.id } });
    await prisma.reservation.createMany({
      data: [
        { subnetId: subnet.id, ipAddress: "10.77.1.10", hostname: "printer", sourceType: "manual", status: "active" },
        { subnetId: subnet.id, ipAddress: "10.77.1.99", hostname: "new-host", sourceType: "dhcp_lease", status: "active" },
      ],
    });

    const conflict = await prisma.conflict.findFirstOrThrow({ where: { entityType: "subnet" } });
    const { lines } = await buildChassisDiff(conflict);

    const byIp = new Map(lines.map((l) => [l.ip, l]));
    expect(byIp.get("10.77.1.10")).toMatchObject({ verdict: "same", migratable: true });
    expect(byIp.get("10.77.1.11")).toMatchObject({ verdict: "only-old", migratable: true });
    expect(byIp.get("10.77.1.99")).toMatchObject({ verdict: "only-new", migratable: false });
    // The gateway interface address is the new box's own config to state.
    expect(byIp.get("10.77.1.1")).toMatchObject({
      verdict: "only-old",
      migratable: false,
      notMigratableReason: "device-owned",
    });
  });

  it("accepting stamps the new serial so the next run sees no change", async () => {
    const { block, subnet } = await seed();
    await raise(subnet.id, block.id);
    const conflict = await prisma.conflict.findFirstOrThrow({ where: { entityType: "subnet" } });

    await acceptChassisReplacement(conflict, "tester");

    const after = await prisma.subnet.findUniqueOrThrow({ where: { id: subnet.id } });
    expect(after.fortigateSerial).toBe(NEW_SN);
  });

  it("leaves the stored serial alone while the conflict is pending", async () => {
    // The pending conflict IS the unresolved state; the stored serial is what
    // keeps the detection derivable from the subnet row itself.
    const { block, subnet } = await seed();
    await raise(subnet.id, block.id);
    const after = await prisma.subnet.findUniqueOrThrow({ where: { id: subnet.id } });
    expect(after.fortigateSerial).toBe(OLD_SN);
  });
});
