/**
 * scripts/diagnose-dhcp-create-conflicts.ts
 *
 * Diagnostic for the "Failed to create DHCP lease ... Unique constraint failed
 * on (subnetId, ipAddress, status)" errors. The unique key applies to every
 * status value, not just active, so a stale `released` or `expired` row at
 * the same (subnet, ip) can block a status-transition update too.
 *
 * Four passes:
 *
 *   1) Whole-table duplicate scan per (subnetId, ipAddress, status) — should
 *      always be zero rows; if anything shows up here the unique index is
 *      broken.
 *
 *   2) For each IP passed on argv (or the two from today's screenshot if
 *      argv is empty): EVERY Reservation row at that ipAddress regardless
 *      of status, in createdAt order, with sourceType / status / subnet
 *      detail so we can see what's holding each (subnet, ip, status) slot.
 *
 *   3) For each target IP, which non-deprecated Subnets actually contain
 *      that IP (CIDR check). Detects the "two subnets overlap and discovery
 *      picked the wrong one" failure mode.
 *
 *   4) Non-deprecated subnet pairs where one CIDR contains the other —
 *      the structural setup that lets case (3) happen.
 *
 * Read-only. Run from the repo root:
 *   npx tsx scripts/diagnose-dhcp-create-conflicts.ts 10.0.85.42 10.0.213.13
 */

import { prisma } from "../src/db.js";
import { ipInCidr, cidrContains } from "../src/utils/cidr.js";

async function main() {
  const argvIps = process.argv.slice(2).filter((s) => /^[0-9.]+$/.test(s));
  const targetIps = argvIps.length > 0 ? argvIps : ["10.0.85.42", "10.0.213.13"];

  // ── 1) Whole-table duplicates per (subnetId, ipAddress, status) ─────────
  console.log("─── 1) Duplicate (subnetId, ipAddress, status) tuples ───");
  const dupes = await prisma.$queryRawUnsafe<
    Array<{ subnetId: string; ipAddress: string; status: string; count: bigint }>
  >(`
    SELECT "subnetId", "ipAddress", status, COUNT(*)::bigint AS count
    FROM reservations
    WHERE "ipAddress" IS NOT NULL
    GROUP BY "subnetId", "ipAddress", status
    HAVING COUNT(*) > 1
    ORDER BY count DESC, "ipAddress"
    LIMIT 50
  `);
  if (dupes.length === 0) {
    console.log("  none — unique index is intact.\n");
  } else {
    console.log(`  ${dupes.length} duplicate group(s):`);
    for (const d of dupes) {
      console.log(`    subnet=${d.subnetId} ip=${d.ipAddress} status=${d.status} count=${d.count}`);
    }
    console.log("");
  }

  // ── 2) Per-IP dump: every row, every status ──────────────────────────────
  for (const ip of targetIps) {
    console.log(`─── 2) All Reservation rows at ${ip} (any status) ───`);
    const rows = await prisma.reservation.findMany({
      where: { ipAddress: ip },
      orderBy: { createdAt: "asc" },
      include: {
        subnet: {
          select: {
            id: true,
            cidr: true,
            name: true,
            status: true,
            fortigateDevice: true,
            discoveredBy: true,
          },
        },
      },
    });
    if (rows.length === 0) {
      console.log("  no rows.\n");
    } else {
      for (const r of rows) {
        console.log(
          `  id=${r.id.slice(0, 8)} sub=${r.subnet.cidr} (${r.subnet.name}, subStatus=${r.subnet.status}, fgt=${r.subnet.fortigateDevice ?? "—"}) resStatus=${r.status} src=${r.sourceType} createdBy=${r.createdBy ?? "—"} pushStatus=${r.pushStatus ?? "—"} expires=${r.expiresAt?.toISOString() ?? "—"} created=${r.createdAt.toISOString()} updated=${r.updatedAt.toISOString()}`,
        );
      }
      console.log("");
    }

    console.log(`─── 2b) Non-deprecated subnets containing ${ip} ───`);
    const subnets = await prisma.subnet.findMany({
      where: { status: { not: "deprecated" } },
      select: {
        id: true,
        cidr: true,
        name: true,
        fortigateDevice: true,
        discoveredBy: true,
        status: true,
      },
    });
    const matching = subnets.filter((s) => {
      try {
        return ipInCidr(ip, s.cidr);
      } catch {
        return false;
      }
    });
    if (matching.length === 0) {
      console.log("  no subnets contain this IP.\n");
    } else {
      for (const s of matching) {
        console.log(
          `  ${s.cidr}  (id=${s.id.slice(0, 8)}, name=${s.name}, status=${s.status}, fgt=${s.fortigateDevice ?? "—"}, discoveredBy=${s.discoveredBy?.slice(0, 8) ?? "—"})`,
        );
      }
      console.log("");
    }
  }

  // ── 3) Subnet-overlap report ────────────────────────────────────────────
  console.log("─── 3) Non-deprecated subnet pairs where one contains the other ───");
  const allSubnets = await prisma.subnet.findMany({
    where: { status: { not: "deprecated" } },
    select: { id: true, cidr: true, name: true, fortigateDevice: true, discoveredBy: true },
  });
  const overlaps: Array<{ outer: typeof allSubnets[number]; inner: typeof allSubnets[number] }> = [];
  for (const a of allSubnets) {
    for (const b of allSubnets) {
      if (a.id === b.id) continue;
      try {
        if (cidrContains(a.cidr, b.cidr)) overlaps.push({ outer: a, inner: b });
      } catch {
        /* ignore malformed cidrs */
      }
    }
  }
  if (overlaps.length === 0) {
    console.log("  none.\n");
  } else {
    console.log(`  ${overlaps.length} containment relationship(s):`);
    for (const o of overlaps.slice(0, 50)) {
      console.log(
        `    outer ${o.outer.cidr} (${o.outer.name}, fgt=${o.outer.fortigateDevice ?? "—"})  ⊃  inner ${o.inner.cidr} (${o.inner.name}, fgt=${o.inner.fortigateDevice ?? "—"})`,
      );
    }
    if (overlaps.length > 50) console.log(`  ... (${overlaps.length - 50} more)`);
    console.log("");
  }

  // ── 4) Status distribution for dns_resolved rows ────────────────────────
  console.log("─── 4) Reservation status distribution (sourceType=dns_resolved) ───");
  const dnsByStatus = await prisma.reservation.groupBy({
    by: ["status"],
    where: { sourceType: "dns_resolved" as any },
    _count: { _all: true },
  });
  if (dnsByStatus.length === 0) {
    console.log("  no dns_resolved rows in DB.");
  } else {
    for (const r of dnsByStatus) {
      console.log(`  status=${r.status}  count=${r._count._all}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
