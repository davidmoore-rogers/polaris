/**
 * prisma/mock-compare.ts — mock telemetry data for the Assets → Compare feature.
 *
 * Creates a handful of monitored assets and back-fills 7 days of detail-tier
 * samples (monitor response-time, CPU/memory telemetry, per-interface counters,
 * per-mountpoint storage) so the Compare slide-over has real curves to overlay
 * across every metric: response time, CPU %, memory %, storage %, interface
 * throughput, interface errors.
 *
 * Detail retention defaults to 7 days (sampleQueryRouter), so 1h / 24h / 7d
 * ranges all read these rows; the 30d range reads hourly rollups (not seeded —
 * it'll be sparse, which is expected for mock data).
 *
 * Run (inside the dev container):
 *   npm run mock:compare
 *   # or: node --env-file=.env --import tsx/esm prisma/mock-compare.ts
 *
 * Idempotent: assets are upserted by hostname and their existing mock samples
 * are deleted before re-seeding. Refuses to run with NODE_ENV=production.
 */

import { prisma } from "../src/db.js";

const MOCK_TAG = "mock-compare";

// 7 days of detail samples at a 10-minute cadence → ~1008 points per series.
const STEP_MINUTES = 10;
const DAYS = 7;
const STEP_MS = STEP_MINUTES * 60 * 1000;
const STEP_SECONDS = STEP_MINUTES * 60;
const STEPS = Math.floor((DAYS * 24 * 60) / STEP_MINUTES);

interface IfaceSpec { name: string; baseMbps: number; errRatePerStep: number; }
interface MountSpec { path: string; totalGb: number; baseUsedPct: number; }
interface AssetSpec {
  hostname: string;
  ipAddress: string;
  assetType: string;
  // metric baselines + a per-asset phase so the overlaid curves are visibly distinct
  rttMs: number;
  cpuPct: number;
  memPct: number;
  phase: number;
  ifaces: IfaceSpec[];
  mounts: MountSpec[];
}

// Every asset carries a shared "mgmt" interface so the Compare interface picker
// shows a name present on all assets (clean cross-asset overlay), plus one
// device-specific interface to exercise the "N of M assets" partial case.
const ASSETS: AssetSpec[] = [
  { hostname: "core-fw-01",  ipAddress: "10.20.0.1",  assetType: "firewall",   rttMs: 3,  cpuPct: 30, memPct: 55, phase: 0.0,
    ifaces: [{ name: "mgmt", baseMbps: 5, errRatePerStep: 0.02 }, { name: "wan1", baseMbps: 320, errRatePerStep: 0.15 }],
    mounts: [{ path: "/", totalGb: 32, baseUsedPct: 38 }] },
  { hostname: "core-sw-01",  ipAddress: "10.20.0.2",  assetType: "switch",     rttMs: 1,  cpuPct: 15, memPct: 40, phase: 0.6,
    ifaces: [{ name: "mgmt", baseMbps: 4, errRatePerStep: 0.01 }, { name: "port1", baseMbps: 180, errRatePerStep: 0.05 }],
    mounts: [{ path: "/", totalGb: 16, baseUsedPct: 22 }] },
  { hostname: "app-srv-01",  ipAddress: "10.20.10.11", assetType: "server",    rttMs: 8,  cpuPct: 58, memPct: 70, phase: 1.2,
    ifaces: [{ name: "mgmt", baseMbps: 6, errRatePerStep: 0.0 }, { name: "eth0", baseMbps: 220, errRatePerStep: 0.03 }],
    mounts: [{ path: "/", totalGb: 100, baseUsedPct: 54 }, { path: "/var", totalGb: 250, baseUsedPct: 61 }] },
  { hostname: "db-srv-01",   ipAddress: "10.20.10.12", assetType: "server",    rttMs: 6,  cpuPct: 74, memPct: 84, phase: 2.1,
    ifaces: [{ name: "mgmt", baseMbps: 7, errRatePerStep: 0.0 }, { name: "eth0", baseMbps: 140, errRatePerStep: 0.08 }],
    mounts: [{ path: "/", totalGb: 100, baseUsedPct: 48 }, { path: "/data", totalGb: 1000, baseUsedPct: 73 }] },
  { hostname: "web-srv-01",  ipAddress: "10.20.10.13", assetType: "server",    rttMs: 5,  cpuPct: 44, memPct: 60, phase: 3.0,
    ifaces: [{ name: "mgmt", baseMbps: 6, errRatePerStep: 0.0 }, { name: "eth0", baseMbps: 260, errRatePerStep: 0.02 }],
    mounts: [{ path: "/", totalGb: 80, baseUsedPct: 40 }] },
  { hostname: "edge-rtr-01", ipAddress: "10.20.0.3",  assetType: "router",     rttMs: 12, cpuPct: 26, memPct: 50, phase: 3.7,
    ifaces: [{ name: "mgmt", baseMbps: 5, errRatePerStep: 0.04 }, { name: "ge0/0", baseMbps: 95, errRatePerStep: 0.2 }],
    mounts: [{ path: "/", totalGb: 8, baseUsedPct: 30 }] },
];

const GB = 1024 * 1024 * 1024;

// Smooth diurnal-ish wave in [0,1] for a given step + phase offset.
function wave(step: number, phase: number): number {
  const t = (step / STEPS) * Math.PI * 2 * DAYS; // one cycle per simulated day
  return (Math.sin(t + phase) + 1) / 2;
}
function jitter(amt: number): number { return (Math.random() - 0.5) * 2 * amt; }
function clampPct(v: number): number { return Math.max(0, Math.min(100, v)); }

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed mock data: NODE_ENV=production.");
    process.exit(1);
  }

  const now = Date.now();
  // Align the newest sample to a step boundary so each scrape's interfaces
  // share an exact timestamp (system-info anchors interfaces/storage on the
  // newest matching timestamp).
  const endMs = now - (now % STEP_MS);

  console.log(`Seeding ${ASSETS.length} mock assets with ${STEPS} steps (${DAYS}d @ ${STEP_MINUTES}m)…`);

  for (const spec of ASSETS) {
    // hostname isn't unique in the schema, so find-or-create by it.
    const data = {
      ipAddress: spec.ipAddress, assetType: spec.assetType, status: "active" as const,
      monitored: true, lastSeen: new Date(endMs), lastSeenSource: "mock",
      lastTelemetryAt: new Date(endMs), lastSystemInfoAt: new Date(endMs), tags: [MOCK_TAG],
    };
    const existing = await prisma.asset.findFirst({ where: { hostname: spec.hostname } });
    const asset = existing
      ? await prisma.asset.update({ where: { id: existing.id }, data })
      : await prisma.asset.create({ data: { hostname: spec.hostname, createdBy: "system:mock-compare", ...data } });

    const assetId = asset.id;

    // Clear prior mock samples for idempotent re-runs.
    await Promise.all([
      prisma.assetMonitorSample.deleteMany({ where: { assetId } }),
      prisma.assetTelemetrySample.deleteMany({ where: { assetId } }),
      prisma.assetInterfaceSample.deleteMany({ where: { assetId } }),
      prisma.assetStorageSample.deleteMany({ where: { assetId } }),
    ]);

    const monitorRows: any[] = [];
    const telemetryRows: any[] = [];
    const interfaceRows: any[] = [];
    const storageRows: any[] = [];

    // Per-interface cumulative counters (octets/errors monotonically increase).
    const ifState = spec.ifaces.map((f) => ({ spec: f, inOctets: 0n, outOctets: 0n, inErrors: 0n, outErrors: 0n }));

    for (let i = 0; i < STEPS; i++) {
      const ts = new Date(endMs - (STEPS - 1 - i) * STEP_MS);
      const w = wave(i, spec.phase);

      // Monitor response time — mostly successful, occasional miss.
      const success = Math.random() > 0.012;
      const rtt = Math.max(1, Math.round(spec.rttMs * (0.7 + w * 0.8) + jitter(spec.rttMs * 0.25)));
      monitorRows.push({ assetId, timestamp: ts, success, responseTimeMs: success ? rtt : null, error: success ? null : "timeout" });

      // CPU / memory telemetry.
      const cpu = clampPct(spec.cpuPct * (0.6 + w * 0.9) + jitter(6));
      const mem = clampPct(spec.memPct + (w - 0.5) * 14 + jitter(3));
      const memTotal = BigInt(16) * BigInt(GB);
      const memUsed = BigInt(Math.round((mem / 100) * Number(memTotal)));
      telemetryRows.push({ assetId, timestamp: ts, cpuPct: Number(cpu.toFixed(1)), memPct: Number(mem.toFixed(1)), memUsedBytes: memUsed, memTotalBytes: memTotal });

      // Per-interface cumulative counters.
      for (const st of ifState) {
        const mbps = Math.max(0, st.spec.baseMbps * (0.4 + w * 1.2) + jitter(st.spec.baseMbps * 0.2));
        const bytesThisStep = BigInt(Math.round((mbps * 1_000_000 / 8) * STEP_SECONDS));
        // out runs a bit lighter than in for visual variety.
        st.inOctets += bytesThisStep;
        st.outOctets += (bytesThisStep * 7n) / 10n;
        if (Math.random() < st.spec.errRatePerStep) st.inErrors += BigInt(1 + Math.floor(Math.random() * 3));
        if (Math.random() < st.spec.errRatePerStep * 0.7) st.outErrors += 1n;
        interfaceRows.push({
          assetId, timestamp: ts, ifName: st.spec.name,
          adminStatus: "up", operStatus: "up", speedBps: BigInt(1_000_000_000),
          inOctets: st.inOctets, outOctets: st.outOctets, inErrors: st.inErrors, outErrors: st.outErrors,
        });
      }

      // Per-mountpoint storage (slowly climbing usage).
      for (const m of spec.mounts) {
        const total = BigInt(m.totalGb) * BigInt(GB);
        const usedPct = clampPct(m.baseUsedPct + (i / STEPS) * 6 + (w - 0.5) * 2 + jitter(0.5));
        const used = BigInt(Math.round((usedPct / 100) * Number(total)));
        storageRows.push({ assetId, timestamp: ts, mountPath: m.path, totalBytes: total, usedBytes: used, cadence: "fast" });
      }
    }

    await insertBatched(prisma.assetMonitorSample, monitorRows);
    await insertBatched(prisma.assetTelemetrySample, telemetryRows);
    await insertBatched(prisma.assetInterfaceSample, interfaceRows);
    await insertBatched(prisma.assetStorageSample, storageRows);

    console.log(`  ${spec.hostname}: ${monitorRows.length} monitor, ${telemetryRows.length} telemetry, ${interfaceRows.length} interface, ${storageRows.length} storage`);
  }

  console.log(`\nDone. Open Assets, filter/select the "${MOCK_TAG}"-tagged devices, and click Compare.`);
  await prisma.$disconnect();
}

async function insertBatched(model: any, rows: any[], batch = 2000) {
  for (let i = 0; i < rows.length; i += batch) {
    await model.createMany({ data: rows.slice(i, i + batch) });
  }
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
