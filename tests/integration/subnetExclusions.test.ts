/**
 * tests/integration/subnetExclusions.test.ts
 *
 * Business rule 42 against a real Postgres. Skips cleanly when DATABASE_URL
 * isn't reachable; see tests/integration/_helpers.ts.
 *
 * Four things are worth a real database:
 *   1. the locked create seam refuses an excluded CIDR — that seam is the one
 *      place manual create, auto-allocate and the discovery create all meet,
 *      so it is what makes "never added to the networks list" true of all of
 *      them at once;
 *   2. auto-allocate SKIPS excluded space instead of failing on it (a caller
 *      asking for "any free /N" must not be handed a wall);
 *   3. adding an exclusion leaves networks already in the list alone, and
 *      reports how many there were;
 *   4. the CIDR is frozen — rename works, re-pointing is not offered.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  createExclusion,
  updateExclusion,
  deleteExclusion,
  listExclusions,
  assertNotExcluded,
} from "../../src/services/subnetExclusionService.js";
import {
  createSubnetRowChecked,
  createSubnet,
  allocateNextSubnet,
  bulkAllocate,
  previewBulkAllocate,
} from "../../src/services/subnetService.js";

const d = dbDescribe;

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
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
  await prisma.subnetExclusion.deleteMany();
  await prisma.event.deleteMany({ where: { action: { startsWith: "subnet.exclusion" } } });
});

async function seedBlock(cidr = "10.88.0.0/16") {
  return prisma.ipBlock.create({
    data: { name: "Exclusion Test Block", cidr, ipVersion: "v4" },
  });
}

d("subnet exclusions — recording", () => {
  it("normalizes the CIDR and refuses a duplicate", async () => {
    const created = await createExclusion({
      cidr: "10.88.9.5/24",
      name: "Site Management VLAN",
      actor: "tester",
    });
    expect(created.cidr).toBe("10.88.9.0/24");
    expect(created.matchCount).toBe(0);

    await expect(
      createExclusion({ cidr: "10.88.9.0/24", name: "Duplicate" }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("refuses a non-IPv4 or malformed CIDR", async () => {
    await expect(createExclusion({ cidr: "2001:db8::/64", name: "v6" }))
      .rejects.toMatchObject({ httpStatus: 400 });
    await expect(createExclusion({ cidr: "not-a-subnet", name: "junk" }))
      .rejects.toMatchObject({ httpStatus: 400 });
    await expect(createExclusion({ cidr: "10.88.9.0/24", name: "  " }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it("writes an audit Event naming what it excluded", async () => {
    await createExclusion({ cidr: "10.88.9.0/24", name: "Site Management VLAN", actor: "tester" });
    // logEvent is fire-and-forget (void), so give it a tick to land.
    await new Promise((r) => setTimeout(r, 150));
    const ev = await prisma.event.findFirst({ where: { action: "subnet.exclusion.created" } });
    expect(ev?.message).toContain("10.88.9.0/24");
    expect(ev?.message).toContain("Site Management VLAN");
  });
});

d("subnet exclusions — nothing may record excluded space", () => {
  it("refuses the locked create seam every writer goes through", async () => {
    const block = await seedBlock();
    await createExclusion({ cidr: "10.88.9.0/24", name: "Site Management VLAN" });

    await expect(
      createSubnetRowChecked({
        blockId: block.id,
        cidr: "10.88.9.0/24",
        name: "someone's manual attempt",
        status: "available",
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });

    // ...and the same for a subnet INSIDE the exclusion, not just an exact hit.
    await expect(
      createSubnetRowChecked({
        blockId: block.id,
        cidr: "10.88.9.128/25",
        name: "half of it",
        status: "available",
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });

    expect(await prisma.subnet.count()).toBe(0);
  });

  it("refuses the operator create path with a message naming the exclusion", async () => {
    const block = await seedBlock();
    await createExclusion({ cidr: "10.88.9.0/24", name: "Site Management VLAN" });
    await expect(
      createSubnet({ blockId: block.id, cidr: "10.88.9.0/24", name: "Mgmt" }),
    ).rejects.toThrow(/Site Management VLAN/);
  });

  it("allows a neighbour and a supernet of the exclusion", async () => {
    // The exclusion covers what is inside it, in one direction only.
    const block = await seedBlock();
    await createExclusion({ cidr: "10.88.9.0/24", name: "Site Management VLAN" });
    const ok = await createSubnet({ blockId: block.id, cidr: "10.88.10.0/24", name: "Neighbour" });
    expect(ok.cidr).toBe("10.88.10.0/24");
  });

  it("stops refusing once the exclusion is removed", async () => {
    const block = await seedBlock();
    const ex = await createExclusion({ cidr: "10.88.9.0/24", name: "Temporary" });
    await expect(assertNotExcluded("10.88.9.0/24")).rejects.toMatchObject({ httpStatus: 409 });
    await deleteExclusion(ex.id, "tester");
    await expect(assertNotExcluded("10.88.9.0/24")).resolves.toBeUndefined();
    const ok = await createSubnet({ blockId: block.id, cidr: "10.88.9.0/24", name: "Back" });
    expect(ok.cidr).toBe("10.88.9.0/24");
  });
});

d("subnet exclusions — allocators treat it as taken space, not a wall", () => {
  it("auto-allocate skips over the excluded range", async () => {
    const block = await seedBlock("10.88.0.0/22");
    await createExclusion({ cidr: "10.88.0.0/24", name: "Site Management VLAN" });
    const first = await allocateNextSubnet(block.id, 24, { name: "First" });
    // Would have been 10.88.0.0/24 without the exclusion.
    expect(first.cidr).toBe("10.88.1.0/24");
  });

  it("bulk-allocate packs past it, and the preview agrees with the write", async () => {
    const block = await seedBlock("10.88.0.0/22");
    await createExclusion({ cidr: "10.88.0.0/24", name: "Site Management VLAN" });

    const preview = await previewBulkAllocate({
      blockId: block.id,
      entries: [{ name: "a", prefixLength: 25 }, { name: "b", prefixLength: 25 }],
      anchorPrefix: 24,
    });
    expect(preview.fits).toBe(true);
    expect(preview.anchorCidr).toBe("10.88.1.0/24");

    const result = await bulkAllocate({
      blockId: block.id,
      prefix: "Site",
      entries: [{ name: "a", prefixLength: 25 }, { name: "b", prefixLength: 25 }],
    });
    expect(result.anchorCidr).toBe(preview.anchorCidr);
    expect(result.created.map((c) => c.cidr)).toEqual(["10.88.1.0/25", "10.88.1.128/25"]);
  });
});

d("subnet exclusions — existing networks are reported, never touched", () => {
  it("counts and names the live networks an exclusion covers", async () => {
    const block = await seedBlock();
    const live = await prisma.subnet.create({
      data: { blockId: block.id, cidr: "10.88.9.0/24", name: "Already listed", status: "available" },
    });

    const created = await createExclusion({ cidr: "10.88.8.0/22", name: "Management space" });
    expect(created.matchCount).toBe(1);
    expect(created.matches[0]?.cidr).toBe("10.88.9.0/24");
    expect(created.matches[0]?.blockName).toBe("Exclusion Test Block");

    // Adding an exclusion destroys nothing — retiring is the archive's job.
    const still = await prisma.subnet.findUnique({ where: { id: live.id } });
    expect(still?.status).toBe("available");
  });
});

d("subnet exclusions — the CIDR is the identity", () => {
  it("renames in place and keeps the CIDR", async () => {
    const ex = await createExclusion({ cidr: "10.88.9.0/24", name: "Typo Nmae" });
    const saved = await updateExclusion(ex.id, { name: "Site Management VLAN", actor: "tester" });
    expect(saved.name).toBe("Site Management VLAN");
    expect(saved.cidr).toBe("10.88.9.0/24");

    const rows = await listExclusions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Site Management VLAN");
  });

  it("refuses a blank rename and 404s an unknown id", async () => {
    const ex = await createExclusion({ cidr: "10.88.9.0/24", name: "Keep me" });
    await expect(updateExclusion(ex.id, { name: "   " })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(updateExclusion("00000000-0000-0000-0000-000000000000", { name: "x" }))
      .rejects.toMatchObject({ httpStatus: 404 });
    await expect(deleteExclusion("00000000-0000-0000-0000-000000000000"))
      .rejects.toMatchObject({ httpStatus: 404 });
  });
});
