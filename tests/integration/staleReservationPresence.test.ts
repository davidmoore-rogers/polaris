/**
 * tests/integration/staleReservationPresence.test.ts
 *
 * Covers the asset-presence cross-signal in stale-reservation detection: a
 * dhcp_reservation that never pulls a DHCP lease (because its target device is
 * STATICALLY configured with the IP) must NOT be flagged stale while a
 * correlated Asset still shows recent network presence — and MUST flag once
 * that asset goes quiet too. Correlation is by MAC first, then IP.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { listStaleReservations } from "../../src/services/reservationStaleService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const DAY = 24 * 60 * 60 * 1000;
const MAC = "AA:BB:CC:DD:EE:01";

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
  await prisma.asset.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
  // Threshold = 60 days; detection baseline pinned 90 days back so a row with
  // no lease and no fresh asset would otherwise flag — isolating the asset
  // signal as the thing under test.
  await prisma.setting.upsert({
    where: { key: "reservationStale" },
    create: { key: "reservationStale", value: { staleAfterDays: 60 } as any },
    update: { value: { staleAfterDays: 60 } as any },
  });
  await prisma.setting.upsert({
    where: { key: "reservationStaleDetectionStartedAt" },
    create: { key: "reservationStaleDetectionStartedAt", value: { startedAt: new Date(Date.now() - 90 * DAY).toISOString() } as any },
    update: { value: { startedAt: new Date(Date.now() - 90 * DAY).toISOString() } as any },
  });
});

/** block + subnet via the API so required fields / CIDR normalization are real. */
async function scaffold(agent: any, csrf: string) {
  const block = await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name: "B", cidr: "10.30.0.0/16" });
  if (block.status !== 201) throw new Error(`block create: ${block.status} ${JSON.stringify(block.body)}`);
  const subnet = await agent
    .post("/api/v1/subnets")
    .set("X-CSRF-Token", csrf)
    .send({ blockId: block.body.id, cidr: "10.30.1.0/24", name: "S" });
  if (subnet.status !== 201) throw new Error(`subnet create: ${subnet.status} ${JSON.stringify(subnet.body)}`);
  return subnet.body;
}

/** A never-leased dhcp_reservation created `ageDays` ago. */
async function staleCandidate(subnetId: string, over: Record<string, unknown> = {}) {
  return prisma.reservation.create({
    data: {
      subnetId,
      ipAddress: "10.30.1.50",
      hostname: "static-printer",
      macAddress: MAC,
      sourceType: "dhcp_reservation",
      status: "active",
      staleIgnored: false,
      lastSeenLeased: null,
      createdAt: new Date(Date.now() - 90 * DAY),
      ...over,
    },
  });
}

d("stale-reservation asset presence", () => {
  it("keeps a never-leased reservation OUT of the stale list when a MAC-matched asset is fresh", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnet = await scaffold(agent, csrf);
    const res = await staleCandidate(subnet.id);
    // Statically-addressed device: same MAC, seen on the network just now.
    await prisma.asset.create({
      data: { macAddress: MAC, ipAddress: "10.30.1.50", hostname: "static-printer", status: "active", assetType: "other", lastSeen: new Date() },
    });

    const stale = await listStaleReservations("active");
    expect(stale.find((r) => r.id === res.id)).toBeUndefined();
  });

  it("flags the reservation (assetPresenceMatch=mac) once the MAC-matched asset also goes quiet", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnet = await scaffold(agent, csrf);
    const res = await staleCandidate(subnet.id);
    await prisma.asset.create({
      data: { macAddress: MAC, ipAddress: "10.30.1.50", hostname: "static-printer", status: "active", assetType: "other", lastSeen: new Date(Date.now() - 90 * DAY) },
    });

    const stale = await listStaleReservations("active");
    const entry = stale.find((r) => r.id === res.id);
    expect(entry).toBeDefined();
    expect(entry!.assetPresenceMatch).toBe("mac");
    expect(entry!.assetLastSeen).not.toBeNull();
  });

  it("keeps a reservation OUT via an IP-matched fresh asset when no MAC matches", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnet = await scaffold(agent, csrf);
    // Reservation MAC that no asset carries; correlation must fall to IP.
    const res = await staleCandidate(subnet.id, { macAddress: "11:22:33:44:55:66" });
    await prisma.asset.create({
      data: { macAddress: "99:99:99:99:99:99", ipAddress: "10.30.1.50", hostname: "static-printer", status: "active", assetType: "other", lastSeen: new Date() },
    });

    const stale = await listStaleReservations("active");
    expect(stale.find((r) => r.id === res.id)).toBeUndefined();
  });

  it("still flags a genuinely-gone reservation (no lease, no correlated asset, old baseline)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnet = await scaffold(agent, csrf);
    const res = await staleCandidate(subnet.id);
    // No asset created at all.
    const stale = await listStaleReservations("active");
    const entry = stale.find((r) => r.id === res.id);
    expect(entry).toBeDefined();
    expect(entry!.assetPresenceMatch).toBeNull();
    expect(entry!.assetLastSeen).toBeNull();
  });
});
