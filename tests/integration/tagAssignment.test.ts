/**
 * tests/integration/tagAssignment.test.ts
 *
 * Service-level integration coverage for criteria-based tag auto-assignment
 * (src/services/tagAssignmentService.ts). DB-driven (Prisma reads/writes +
 * raw inet containment), so we drive the service and assert against the
 * resulting Asset.tags arrays + TagAutoAssignment provenance rows. Skips
 * cleanly when DATABASE_URL is unreachable (see _helpers.ts).
 *
 * Behavior exercised (read from the service, not assumed):
 *   - reconcileTag ADDS the tag to matching assets + records provenance.
 *   - reconcileTag REMOVES the tag from drifted assets (managed sync), and
 *     deletes their provenance.
 *   - A hand-applied copy of the same tag name on a NON-matching asset (no
 *     provenance) is preserved forever.
 *   - Subnet/CIDR membership works (v4) via the inet query.
 *   - Clearing criteria strips engine-owned copies.
 *   - previewTagCriteria returns match count + diff without writing.
 */

import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  reconcileTag,
  previewTagCriteria,
  stripTagAssignments,
} from "../../src/services/tagAssignmentService.js";

const d = dbDescribe;

const TAG_NAME = "auto-test-tag";
const BLOCK_CIDR = "10.88.0.0/16";
const SUBNET_CIDR = "10.88.1.0/24";

async function makeTag(criteria: unknown) {
  return prisma.tag.create({
    data: {
      name: TAG_NAME,
      category: "Test",
      color: "#4fc3f7",
      criteria: criteria as any,
    },
  });
}

async function makeAsset(over: Record<string, unknown>) {
  return prisma.asset.create({
    data: {
      assetType: "server",
      status: "active",
      ...over,
    } as any,
  });
}

async function cleanup() {
  if (!dbReachable) return;
  await prisma.tagAutoAssignment.deleteMany({});
  await prisma.tag.deleteMany({ where: { name: TAG_NAME } });
  // reconcileTag matches its criteria fleet-wide, so the asset table must be
  // empty of *any* asset another test file may have left behind (e.g. the
  // Cisco-manufacturer fixture in assets-list.test.ts), not just our own.
  await prisma.asset.deleteMany();
  await prisma.subnet.deleteMany({ where: { cidr: SUBNET_CIDR } });
  await prisma.ipBlock.deleteMany({ where: { cidr: BLOCK_CIDR } });
}

beforeEach(cleanup);
afterAll(cleanup);

d("tagAssignmentService.reconcileTag", () => {
  it("adds the tag to matching assets and records provenance", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    const match = await makeAsset({ hostname: "tagtest-a", manufacturer: "Cisco" });
    const nonMatch = await makeAsset({ hostname: "tagtest-b", manufacturer: "Juniper" });

    const summary = await reconcileTag(tag.id);
    expect(summary.added).toBe(1);

    const a = await prisma.asset.findUnique({ where: { id: match.id } });
    const b = await prisma.asset.findUnique({ where: { id: nonMatch.id } });
    expect(a!.tags).toContain(TAG_NAME);
    expect(b!.tags).not.toContain(TAG_NAME);

    const prov = await prisma.tagAutoAssignment.findMany({ where: { tagId: tag.id } });
    expect(prov.map((p) => p.assetId)).toEqual([match.id]);
  });

  it("removes the tag when an asset drifts out of match", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    const asset = await makeAsset({ hostname: "tagtest-c", manufacturer: "Cisco" });
    await reconcileTag(tag.id);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.tags).toContain(TAG_NAME);

    // Drift: manufacturer changes so it no longer matches.
    await prisma.asset.update({ where: { id: asset.id }, data: { manufacturer: "Juniper" } });
    const summary = await reconcileTag(tag.id);
    expect(summary.removed).toBe(1);

    const after = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(after!.tags).not.toContain(TAG_NAME);
    expect(await prisma.tagAutoAssignment.count({ where: { tagId: tag.id } })).toBe(0);
  });

  it("never removes a hand-applied copy on a non-matching asset (no provenance)", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    // Hand-applied tag on an asset that does NOT match the criteria.
    const manual = await makeAsset({ hostname: "tagtest-d", manufacturer: "Juniper", tags: [TAG_NAME] });

    await reconcileTag(tag.id);
    const after = await prisma.asset.findUnique({ where: { id: manual.id } });
    expect(after!.tags).toContain(TAG_NAME); // preserved
    expect(await prisma.tagAutoAssignment.count({ where: { tagId: tag.id, assetId: manual.id } })).toBe(0);
  });

  it("matches assets by subnet/CIDR membership", async () => {
    const block = await prisma.ipBlock.create({ data: { name: "Tag Test Block", cidr: BLOCK_CIDR, ipVersion: "v4" } });
    await prisma.subnet.create({ data: { blockId: block.id, cidr: SUBNET_CIDR, name: "Tag Test Subnet", status: "available" } });
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "subnet", op: "inCidr", cidrs: [SUBNET_CIDR] }] });

    const inSubnet = await makeAsset({ hostname: "tagtest-e", ipAddress: "10.88.1.20" });
    const outSubnet = await makeAsset({ hostname: "tagtest-f", ipAddress: "10.99.1.20" });

    await reconcileTag(tag.id);
    expect((await prisma.asset.findUnique({ where: { id: inSubnet.id } }))!.tags).toContain(TAG_NAME);
    expect((await prisma.asset.findUnique({ where: { id: outSubnet.id } }))!.tags).not.toContain(TAG_NAME);
  });

  it("strips engine-owned copies when criteria are cleared", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    const asset = await makeAsset({ hostname: "tagtest-g", manufacturer: "Cisco" });
    await reconcileTag(tag.id);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.tags).toContain(TAG_NAME);

    // Clear criteria → reconcile should strip the engine-owned copy.
    await prisma.tag.update({ where: { id: tag.id }, data: { criteria: undefined } });
    // (undefined leaves the column unchanged; emulate the route's DbNull clear)
    await prisma.$executeRaw`UPDATE tags SET criteria = NULL WHERE id = ${tag.id}`;
    const summary = await reconcileTag(tag.id);
    expect(summary.removed).toBe(1);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.tags).not.toContain(TAG_NAME);
  });

  it("stripTagAssignments removes all engine-owned copies", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    const a1 = await makeAsset({ hostname: "tagtest-h", manufacturer: "Cisco" });
    const a2 = await makeAsset({ hostname: "tagtest-i", manufacturer: "Cisco" });
    await reconcileTag(tag.id);
    const stripped = await stripTagAssignments(tag.id, tag.name);
    expect(stripped).toBe(2);
    expect((await prisma.asset.findUnique({ where: { id: a1.id } }))!.tags).not.toContain(TAG_NAME);
    expect((await prisma.asset.findUnique({ where: { id: a2.id } }))!.tags).not.toContain(TAG_NAME);
  });
});

d("tagAssignmentService.previewTagCriteria", () => {
  it("returns match count + diff without writing", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    await makeAsset({ hostname: "tagtest-j", manufacturer: "Cisco" });
    await makeAsset({ hostname: "tagtest-k", manufacturer: "Cisco" });

    const preview = await previewTagCriteria(
      { version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] },
      tag.id,
    );
    expect(preview.matchCount).toBe(2);
    expect(preview.diff).toEqual({ add: 2, remove: 0 }); // nothing applied yet
    // No writes: no provenance rows created by a preview.
    expect(await prisma.tagAutoAssignment.count({ where: { tagId: tag.id } })).toBe(0);
  });
});
