/**
 * tests/integration/probeLossQuery.test.ts
 *
 * Integration tests for src/services/probeLossQuery.ts —
 * `queryProbeLossRatios`. The whole function IS one raw SQL statement (a
 * partitioned min() anchoring the ratio to each asset's first successful probe,
 * then a grouped aggregate), so it's exercised against a live Postgres rather
 * than mocked.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 *
 * Coverage:
 *   - ANCHOR: samples before the first successful probe are excluded, so a
 *     device recovering from an outage reads 0% instead of the outage's ratio.
 *   - Loss that starts AFTER the first success is counted in full.
 *   - 0-success assets are dropped in both modes (asset-down owns them).
 *   - Engine mode keeps 0%-loss assets (hysteresis recovery); widget mode
 *     (onlyLossy) hides them and orders lossiest-first.
 *   - assetIds scoping + the window bound.
 *   - includeFullyDown (DISPLAY only): a 0-success asset reads 100% instead of
 *     dropping off the widget, while the engine path still drops it.
 *   - probeKind: this query counts EVERY kind, which is the entire reason the
 *     ICMP loss sampler exists.
 *   - RECOVERY ANCHOR: an outage that STARTED mid-window is excluded via
 *     Asset.recoveryStartedAt, the case the first-success anchor cannot see.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { queryProbeLossRatios } from "../../src/services/probeLossQuery.js";

const d = dbDescribe;

// Fixed ids keep the GROUP BY deterministic and scope the cleanup. The sample
// tables carry assetId but no FK to Asset (TimescaleDB hypertables — see
// CLAUDE.md tiered-sample-retention), so no real Asset rows are needed — the
// query's join to assets is a LEFT JOIN precisely so a sample row whose asset
// is gone still counts. The recovery-anchor block below creates real rows,
// because the anchor lives on one.
const A = "00000000-0000-0000-0000-0000000000b1";
const B = "00000000-0000-0000-0000-0000000000b2";
const ALL = [A, B];

/** `minutesAgo` before now, as the naive-UTC Date Prisma writes. */
function ago(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60 * 1000);
}

/**
 * Seed one probe per minute for `assetId`, oldest first: `pattern[i]` is the
 * success flag at (pattern.length - i) minutes ago. Reads like a timeline —
 * "F F F S S" is "failed three minutes, then came back".
 */
async function seedProbes(assetId: string, pattern: boolean[], probeKind?: string): Promise<void> {
  await prisma.assetMonitorSample.createMany({
    data: pattern.map((success, i) => ({
      assetId,
      timestamp: ago(pattern.length - i),
      success,
      responseTimeMs: success && !probeKind ? 10 : null,
      ...(probeKind ? { probeKind } : {}),
    })),
  });
}

const F = false, S = true;

/**
 * Seed ICMP BURST rows: one row per entry carrying packetsSent/packetsReceived,
 * oldest first at minute granularity. `success` is derived the way the sweep
 * derives it (received > 0), because the query has to keep agreeing with that
 * invariant — a burst that got one reply back is a "successful" row and an
 * 80%-lossy reading, and conflating the two is the bug these tests exist for.
 */
async function seedBursts(
  assetId: string,
  bursts: Array<[sent: number, received: number]>,
): Promise<void> {
  await prisma.assetMonitorSample.createMany({
    data: bursts.map(([sent, received], i) => ({
      assetId,
      timestamp: ago(bursts.length - i),
      success: received > 0,
      responseTimeMs: null,
      probeKind: "icmp",
      packetsSent: sent,
      packetsReceived: received,
    })),
  });
}

/**
 * Seed explicit rows at second granularity. The two-transport cases need the
 * ordering to be unambiguous: `seedProbes` above is minute-granular per call, so
 * calling it twice for one asset interleaves rows onto identical timestamps and
 * the first-success anchor lands somewhere the test didn't intend.
 */
async function seedAt(
  assetId: string,
  rows: Array<{ secondsAgo: number; success: boolean; probeKind?: string }>,
): Promise<void> {
  await prisma.assetMonitorSample.createMany({
    data: rows.map((r) => ({
      assetId,
      timestamp: new Date(Date.now() - r.secondsAgo * 1000),
      success: r.success,
      responseTimeMs: r.success && !r.probeKind ? 10 : null,
      ...(r.probeKind ? { probeKind: r.probeKind } : {}),
    })),
  });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: ALL } } });
  await prisma.asset.deleteMany({ where: { id: { in: ALL } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: ALL } } });
  await prisma.asset.deleteMany({ where: { id: { in: ALL } } });
});

/** A real Asset row carrying the recovery anchor the query joins for. */
async function seedAssetWithRecovery(assetId: string, recoveryStartedAt: Date | null): Promise<void> {
  await prisma.asset.create({
    data: { id: assetId, hostname: `loss-${assetId.slice(-2)}`, assetType: "server", status: "active", recoveryStartedAt },
  });
}

d("queryProbeLossRatios — anchoring at the first successful probe", () => {
  it("excludes the outage that preceded recovery (the 92%-on-a-healthy-device case)", async () => {
    // 50 minutes dark, then 5 clean minutes: the pre-anchor failures are not
    // loss, they were an outage, so the reading is 0% rather than 50/55.
    await seedProbes(A, [...Array(50).fill(F), ...Array(5).fill(S)]);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total)).toBe(5);
    expect(Number(rows[0].failed)).toBe(0);
  });

  it("counts every sample from the first success onward", async () => {
    // Anchor at minute -10; two of the ten samples from there on failed.
    await seedProbes(A, [F, F, S, F, S, S, F, S, S, S]);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0].total)).toBe(8);
    expect(Number(rows[0].failed)).toBe(2);
  });

  it("counts loss that starts after the first success (a device going down now)", async () => {
    await seedProbes(A, [S, S, S, S, S, F, F, F, F, F]);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0].total)).toBe(10);
    expect(Number(rows[0].failed)).toBe(5);
  });

  it("anchors per asset, not fleet-wide", async () => {
    await seedProbes(A, [F, F, F, F, S]);        // recovered — 0%
    await seedProbes(B, [S, F, S, F, S]);        // flapping  — 2/5

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL });
    const byId = new Map(rows.map((r) => [r.assetId, r]));
    expect(Number(byId.get(A)!.failed)).toBe(0);
    expect(Number(byId.get(A)!.total)).toBe(1);
    expect(Number(byId.get(B)!.failed)).toBe(2);
    expect(Number(byId.get(B)!.total)).toBe(5);
  });
});

d("queryProbeLossRatios — the recovery anchor (an outage that started mid-window)", () => {
  // 10 clean minutes, then 20 dark, then 5 clean: the window's FIRST success is
  // at minute -35, before the outage, so the first-success anchor is inert here.
  const acrossOutage = [...Array(10).fill(S), ...Array(20).fill(F), ...Array(5).fill(S)];
  // The success that ended it sits 5 minutes back. The stamp is set a half
  // minute earlier so it lands between that success and the last failure —
  // `ago()` is relative to its own call, so aiming exactly at the sample's
  // timestamp would land a few ms past it and trim the anchor row itself.
  const recoveredAt = () => ago(5.5);

  it("excludes the outage, so a device that just came back reads 0% instead of 57%", async () => {
    await seedProbes(A, acrossOutage);
    await seedAssetWithRecovery(A, recoveredAt());

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0].total)).toBe(5);
    expect(Number(rows[0].failed)).toBe(0);
  });

  it("without the stamp the same samples read the outage back as loss (the bug)", async () => {
    // Pins WHY the column exists: the first-success anchor alone keeps every
    // failed probe of a mid-window outage in the denominator, so the device
    // alerts *because* it recovered — for a whole window.
    await seedProbes(A, acrossOutage);
    await seedAssetWithRecovery(A, null);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0].total)).toBe(35);
    expect(Number(rows[0].failed)).toBe(20);
  });

  it("is inert once the recovery falls out of the window (flapping stays measurable)", async () => {
    // A device that recovered two hours ago and has been dropping probes since:
    // the stamp is older than every row, so GREATEST picks the first success and
    // the whole window counts. This is also the warning->up case by construction
    // — that transition never stamps at all.
    await seedProbes(A, [S, F, S, F, S, F, S, F, S, F]);
    await seedAssetWithRecovery(A, ago(120));

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0].total)).toBe(10);
    expect(Number(rows[0].failed)).toBe(5);
  });

  it("anchors per asset — one device's recovery doesn't trim another's window", async () => {
    await seedProbes(A, acrossOutage);
    await seedAssetWithRecovery(A, recoveredAt());
    await seedProbes(B, acrossOutage);
    await seedAssetWithRecovery(B, null);

    const byId = new Map(
      (await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL })).map((r) => [r.assetId, r]),
    );
    expect(Number(byId.get(A)!.total)).toBe(5);
    expect(Number(byId.get(B)!.total)).toBe(35);
  });

  it("drops the recovered device from the Packet Loss widget instead of topping it", async () => {
    // Widget mode: the trimmed window holds no failures, so HAVING hides it —
    // a device that is answering every probe is not "lossy".
    await seedProbes(A, acrossOutage);
    await seedAssetWithRecovery(A, recoveredAt());

    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: ALL, onlyLossy: true, limit: null, includeFullyDown: true,
    });
    expect(rows).toHaveLength(0);
  });

  it("still reads 100% for a device that answered nothing, stamp or no stamp", async () => {
    // The stamp is from a recovery attempt that failed — includeFullyDown's
    // keep-every-row branch must win, or the widget loses the outage entirely.
    await seedProbes(A, Array(20).fill(F));
    await seedAssetWithRecovery(A, ago(10));

    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: null, includeFullyDown: true,
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].failed)).toBe(20);
  });
});

d("queryProbeLossRatios — mode + scoping contracts", () => {
  it("drops assets with no successful probe in the window (asset-down owns them)", async () => {
    await seedProbes(A, [F, F, F, F, F]);

    expect(await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] })).toHaveLength(0);
    expect(await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10 })).toHaveLength(0);
  });

  it("engine mode keeps a clean asset (0% feeds hysteresis recovery); widget mode hides it", async () => {
    await seedProbes(A, [S, S, S, S, S]);

    const engine = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(engine).toHaveLength(1);
    expect(Number(engine[0].failed)).toBe(0);

    const widget = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10 });
    expect(widget).toHaveLength(0);
  });

  it("widget mode orders lossiest-first and honours the cap", async () => {
    await seedProbes(A, [S, F, S, S, S]);        // 1/5 = 20%
    await seedProbes(B, [S, F, F, F, S]);        // 3/5 = 60%

    const ordered = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL, onlyLossy: true, limit: null });
    expect(ordered.map((r) => r.assetId)).toEqual([B, A]);

    const capped = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL, onlyLossy: true, limit: 1 });
    expect(capped.map((r) => r.assetId)).toEqual([B]);
  });

  it("scopes to assetIds and to the window", async () => {
    await seedProbes(A, [S, F, S]);
    await seedProbes(B, [S, F, S]);

    const scoped = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(scoped.map((r) => r.assetId)).toEqual([A]);

    // Samples older than the window are invisible — including the success that
    // would otherwise have anchored the measurement.
    await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: ALL } } });
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: A, timestamp: ago(120), success: true,  responseTimeMs: 10 },
        { assetId: A, timestamp: ago(90),  success: false, responseTimeMs: null },
      ],
    });
    expect(await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] })).toHaveLength(0);
  });
});

d("queryProbeLossRatios — includeFullyDown (display only)", () => {
  it("reads 100% for an asset that answered nothing in the window", async () => {
    // Before this flag such an asset was dropped by the anchor (no first
    // success to anchor to), so it VANISHED from the Packet Loss widget — which
    // reads as "no loss", the opposite of the truth.
    await seedProbes(A, Array(20).fill(F));

    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: null, includeFullyDown: true,
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total)).toBe(20);
    expect(Number(rows[0].failed)).toBe(20);
  });

  it("still drops the fully-down asset without the flag (the engine path)", async () => {
    // The engine must never see 100% here: asset-down owns a total outage, and a
    // loss alert on top of it is the double-alert business rule 29 forbids.
    await seedProbes(A, Array(20).fill(F));

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(rows).toHaveLength(0);
  });

  it("does not change the anchored reading for an asset that DID answer", async () => {
    // The flag only adds the no-anchor case; a recovering device still reads 0%.
    await seedProbes(A, [...Array(50).fill(F), ...Array(5).fill(S)]);

    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], includeFullyDown: true,
    });
    expect(Number(rows[0].total)).toBe(5);
    expect(Number(rows[0].failed)).toBe(0);
  });
});

d("queryProbeLossRatios — probeKind", () => {
  it("counts ICMP loss-sampler rows alongside the response-time poll", async () => {
    // The whole point of the sampler: a 15-minute ratio divides ~90 samples
    // instead of ~15. A success leads (so the anchor keeps everything), then
    // 3 primary polls (1 failed) and 6 sampler pings (3 failed) → 4/10, not 1/4.
    await seedAt(A, [
      { secondsAgo: 300, success: S },                     // anchor
      { secondsAgo: 240, success: F },
      { secondsAgo: 180, success: S },
      { secondsAgo: 120, success: S },
      { secondsAgo: 230, success: F, probeKind: "icmp" },
      { secondsAgo: 220, success: F, probeKind: "icmp" },
      { secondsAgo: 210, success: F, probeKind: "icmp" },
      { secondsAgo: 200, success: S, probeKind: "icmp" },
      { secondsAgo: 190, success: S, probeKind: "icmp" },
      { secondsAgo: 170, success: S, probeKind: "icmp" },
    ]);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0].total)).toBe(10);
    expect(Number(rows[0].failed)).toBe(4);
  });

  it("lets a sampler probe anchor the window like any other success", async () => {
    // The anchor asks "did anything answer", not "which probe answered": the
    // sampler's ping is the first success, so the primary failures before it are
    // an outage rather than loss.
    await seedAt(A, [
      { secondsAgo: 300, success: F },
      { secondsAgo: 240, success: F },
      { secondsAgo: 180, success: F },
      { secondsAgo: 120, success: S, probeKind: "icmp" },
      { secondsAgo: 60,  success: S, probeKind: "icmp" },
    ]);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0].total)).toBe(2);
    expect(Number(rows[0].failed)).toBe(0);
  });
});

dbDescribe("packet counts (ICMP burst rows)", () => {
  it("measures PACKETS, not row outcomes", async () => {
    // Five bursts, each 5 sent / 1 received. Every row is `success: true`
    // (something came back), so the old row-counting ratio called this a
    // perfectly clean device. It is 80% lossy.
    await seedBursts(A, [[5, 1], [5, 1], [5, 1], [5, 1], [5, 1]]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(rows).toHaveLength(1);
    expect(pct(rows[0]!)).toBeCloseTo(80, 5);
  });

  it("reads 0% when every echo came back", async () => {
    await seedBursts(A, [[5, 5], [5, 5], [5, 5]]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(pct(rows[0]!)).toBe(0);
  });

  it("weights by packets rather than by burst, so a long burst counts more", async () => {
    // 5/5 then 10/0 is 10 lost of 15 sent = 66.7%, NOT the 50% a mean of
    // per-burst percentages would give. The clean burst goes FIRST on purpose:
    // the first-success anchor would otherwise trim a leading all-lost burst
    // out of the window, and the assertion would be measuring the anchor
    // rather than the weighting. (That trim is business rule 29b, pinned by
    // its own tests above.)
    await seedBursts(A, [[5, 5], [10, 0]]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(pct(rows[0]!)).toBeCloseTo(66.67, 1);
  });

  it("falls back to the row ratio for an asset with no burst rows", async () => {
    // The pre-sweep behaviour, still exactly what an asset with no pingable
    // target or a disabled sweep gets.
    await seedProbes(A, [S, S, F, F]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(pct(rows[0]!)).toBe(50);
  });

  it("IGNORES the response-time poll's rows once burst rows exist", async () => {
    // The poll may be SNMP/SSH/REST/WinRM; folding a lost SNMP response into a
    // figure labelled "packet loss" would make the number mean something
    // different per asset depending on how it is monitored. Bursts are clean
    // here while every poll row failed, and the answer must be 0%.
    await seedAt(A, [
      { secondsAgo: 50, success: false },
      { secondsAgo: 40, success: false },
      { secondsAgo: 30, success: true },
    ]);
    await seedBursts(A, [[5, 5], [5, 5]]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(pct(rows[0]!)).toBe(0);
  });

  it("surfaces a partially-lossy device in widget mode even though no ROW failed", async () => {
    // The HAVING has to be asked of packets too: every one of these rows is a
    // success, so a row-based `≥1 failure` test would filter out exactly the
    // device the Packet Loss widget exists to show.
    await seedBursts(A, [[5, 3], [5, 3]]);
    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(pct(rows[0]!)).toBeCloseTo(40, 5);
  });

  it("still hides a spotless device in widget mode", async () => {
    await seedBursts(A, [[5, 5], [5, 5]]);
    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10,
    });
    expect(rows).toEqual([]);
  });

  it("orders lossiest-first by the packet ratio", async () => {
    await seedBursts(A, [[5, 4]]);            // 20%
    await seedBursts(B, [[5, 1]]);            // 80%
    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: ALL, onlyLossy: true, limit: 10,
    });
    expect(rows.map((r) => r.assetId)).toEqual([B, A]);
  });

  it("reads a fully-dark burst run as 100% under includeFullyDown", async () => {
    await seedBursts(A, [[5, 0], [5, 0]]);
    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10, includeFullyDown: true,
    });
    expect(pct(rows[0]!)).toBe(100);
  });
});

/** Loss percentage from a returned row — the arithmetic every caller does. */
function pct(r: { total: bigint; failed: bigint }): number {
  return (Number(r.failed) / Number(r.total)) * 100;
}
