/**
 * tests/unit/resolveMonitorSettings.test.ts
 *
 * Coverage for the four-tier monitor-settings resolver:
 *
 *   per-asset override
 *     -> (assetType + integration) class override
 *     -> integration tier (Integration.config.monitorSettings)
 *        OR manual tier   (Setting "manualMonitorSettings")
 *     -> hardcoded floor  (final safety net)
 *
 * Prisma is mocked so the tests stay fast and independent of DB state. Cache
 * state in the resolver module is reset between every test by calling the
 * exported `invalidateMonitorSettingsCache()` — without that, the second
 * test in a describe() would see stale memoized values from the first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Module-mocked stubs so each test can override behaviour. The functions are
// re-bound by re-mocking on the imported `prisma` reference below; vitest
// preserves identity through the import.
vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: {
      findUnique: vi.fn(),
    },
    integration: {
      findUnique: vi.fn(),
    },
    monitorClassOverride: {
      findFirst: vi.fn(),
    },
  },
}));

import {
  resolveMonitorSettings,
  resolveMonitorSettingsWithProvenance,
  invalidateMonitorSettingsCache,
} from "../../src/services/monitoringService.js";
import { prisma } from "../../src/db.js";

// Tier-3 baseline values. After 3d the resolver also returns four per-stream
// polling fields — those are computed from the asset's source kind and the
// compatibility matrix, so the expected resolved shape varies per test. Each
// test that uses toEqual() picks the right polling defaults below.
const FLOOR = {
  intervalSeconds:           60,
  failureThreshold:          3,
  probeTimeoutMs:            5000,
  telemetryIntervalSeconds:  60,
  systemInfoIntervalSeconds: 600,
  sampleRetentionDays:       30,
  telemetryRetentionDays:    30,
  systemInfoRetentionDays:   30,
  responseTimePolling:       null,
  telemetryPolling:          null,
  interfacesPolling:         null,
  lldpPolling:               null,
};

const TUNED_TIER = {
  intervalSeconds:           120,
  failureThreshold:          5,
  probeTimeoutMs:            7500,
  telemetryIntervalSeconds:  90,
  systemInfoIntervalSeconds: 1200,
  sampleRetentionDays:       60,
  telemetryRetentionDays:    14,
  systemInfoRetentionDays:   14,
  responseTimePolling:       null,
  telemetryPolling:          null,
  interfacesPolling:         null,
  lldpPolling:               null,
};

// Per-stream polling defaults the resolver applies for a given source kind.
// Mirrors defaultPollingForSource in monitoringService.ts.
const MANUAL_POLLING_DEFAULT = {
  responseTimePolling: "icmp" as const,
  telemetryPolling:    null,
  interfacesPolling:   null,
  lldpPolling:         null,
};
const FORTI_POLLING_DEFAULT = {
  responseTimePolling: "rest_api" as const,
  telemetryPolling:    "rest_api" as const,
  interfacesPolling:   "rest_api" as const,
  lldpPolling:         "rest_api" as const,
};

beforeEach(() => {
  invalidateMonitorSettingsCache();
  vi.clearAllMocks();
});

// ─── Tier-3 only: manual / integration / floor fallback ─────────────────────

describe("resolveMonitorSettings — tier-3 fallback", () => {
  it("manual tier when asset has no integration and the Setting row exists", async () => {
    (prisma.setting.findUnique as any).mockResolvedValue({ key: "manualMonitorSettings", value: TUNED_TIER });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "workstation",
      discoveredByIntegrationId: null,
      monitorIntervalSec:        null,
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    // Manual source: ICMP for responseTime, null for the other streams.
    expect(out).toEqual({ ...TUNED_TIER, ...MANUAL_POLLING_DEFAULT });
  });

  it("hardcoded floor when manual tier Setting is unseeded AND legacy row absent", async () => {
    // manualMonitorSettings missing; legacy monitorSettings (transitional
    // fallback) also missing. Resolver should fall through to the floor.
    (prisma.setting.findUnique as any).mockResolvedValue(null);
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "server",
      discoveredByIntegrationId: null,
      monitorIntervalSec:        null,
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out).toEqual({ ...FLOOR, ...MANUAL_POLLING_DEFAULT });
  });

  it("falls back to legacy monitorSettings row when manualMonitorSettings is unseeded", async () => {
    // Transitional behaviour during/after the step-5 migration: if the new
    // manual-tier row hasn't been written yet, the loader should still find
    // the legacy global row and project it.
    (prisma.setting.findUnique as any).mockImplementation(async (args: any) => {
      if (args.where.key === "manualMonitorSettings") return null;
      if (args.where.key === "monitorSettings") return { key: "monitorSettings", value: TUNED_TIER };
      return null;
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "switch",
      discoveredByIntegrationId: null,
      monitorIntervalSec:        null,
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out).toEqual({ ...TUNED_TIER, ...MANUAL_POLLING_DEFAULT });
  });

  it("integration tier when asset.discoveredByIntegrationId is set", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({
      config: { monitorSettings: TUNED_TIER },
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "firewall",
      discoveredByIntegrationId: "fmg-1",
      discoveredByIntegrationType: "fortimanager",
      monitorIntervalSec:        null,
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    // FortiManager source: REST API for every stream.
    expect(out).toEqual({ ...TUNED_TIER, ...FORTI_POLLING_DEFAULT });
  });
});

// ─── Tier-2 layering: class override on top of tier-3 ───────────────────────

describe("resolveMonitorSettings — class override layering", () => {
  it("class override fields layer onto integration tier", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({
      config: { monitorSettings: TUNED_TIER },
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue({
      // Only intervalSeconds + probeTimeoutMs differ; the rest inherit.
      intervalSeconds:           300,
      failureThreshold:          null,
      probeTimeoutMs:            8000,
      telemetryIntervalSeconds:  null,
      systemInfoIntervalSeconds: null,
      sampleRetentionDays:       null,
      telemetryRetentionDays:    null,
      systemInfoRetentionDays:   null,
    });

    const out = await resolveMonitorSettings({
      assetType:                 "switch",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        null,
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out.intervalSeconds).toBe(300);
    expect(out.probeTimeoutMs).toBe(8000);
    // Untouched fields keep tier-3 values.
    expect(out.failureThreshold).toBe(TUNED_TIER.failureThreshold);
    expect(out.telemetryIntervalSeconds).toBe(TUNED_TIER.telemetryIntervalSeconds);
    expect(out.sampleRetentionDays).toBe(TUNED_TIER.sampleRetentionDays);
  });

  it("null integrationId is the manual-tier class override", async () => {
    (prisma.setting.findUnique as any).mockResolvedValue({ key: "manualMonitorSettings", value: TUNED_TIER });
    (prisma.monitorClassOverride.findFirst as any).mockImplementation(async (args: any) => {
      // Only return the override when (integrationId, assetType) matches
      // the orphan-asset scope.
      if (args.where.integrationId === null && args.where.assetType === "printer") {
        return { intervalSeconds: 900, failureThreshold: null, probeTimeoutMs: null,
                 telemetryIntervalSeconds: null, systemInfoIntervalSeconds: null,
                 sampleRetentionDays: null, telemetryRetentionDays: null, systemInfoRetentionDays: null };
      }
      return null;
    });

    const out = await resolveMonitorSettings({
      assetType:                 "printer",
      discoveredByIntegrationId: null,
      monitorIntervalSec:        null,
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out.intervalSeconds).toBe(900);
    expect(out.failureThreshold).toBe(TUNED_TIER.failureThreshold);
  });
});

// ─── Tier-1: per-asset overrides on top ─────────────────────────────────────

describe("resolveMonitorSettings — per-asset overrides win", () => {
  it("per-asset monitorIntervalSec / probeTimeoutMs override class + tier-3", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue({
      intervalSeconds: 300, failureThreshold: null, probeTimeoutMs: 8000,
      telemetryIntervalSeconds: null, systemInfoIntervalSeconds: null,
      sampleRetentionDays: null, telemetryRetentionDays: null, systemInfoRetentionDays: null,
    });

    const out = await resolveMonitorSettings({
      assetType:                 "switch",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        45,    // beats class (300) and tier (120)
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            500,   // beats class (8000) and tier (7500)
    });
    expect(out.intervalSeconds).toBe(45);
    expect(out.probeTimeoutMs).toBe(500);
    // No per-asset override on these → still resolves through class → tier.
    expect(out.failureThreshold).toBe(TUNED_TIER.failureThreshold);
    expect(out.telemetryIntervalSeconds).toBe(TUNED_TIER.telemetryIntervalSeconds);
  });

  it("per-asset overrides only apply for the four overridable fields (cadence + timeout)", async () => {
    // failureThreshold and the three retention fields are NOT in
    // AssetMonitorContext — they cascade only down to tier-2.
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "firewall",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        45,
      telemetryIntervalSec:      77,
      systemInfoIntervalSec:     333,
      probeTimeoutMs:            444,
    });
    expect(out.intervalSeconds).toBe(45);
    expect(out.telemetryIntervalSeconds).toBe(77);
    expect(out.systemInfoIntervalSeconds).toBe(333);
    expect(out.probeTimeoutMs).toBe(444);
    // failureThreshold + retentions inherit from tier-3.
    expect(out.failureThreshold).toBe(TUNED_TIER.failureThreshold);
    expect(out.sampleRetentionDays).toBe(TUNED_TIER.sampleRetentionDays);
    expect(out.telemetryRetentionDays).toBe(TUNED_TIER.telemetryRetentionDays);
    expect(out.systemInfoRetentionDays).toBe(TUNED_TIER.systemInfoRetentionDays);
  });
});

// ─── Resolver caching ──────────────────────────────────────────────────────

describe("resolveMonitorSettings — caches tier and class lookups", () => {
  it("hits Prisma at most once per (integrationId, assetType) pair across many calls", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const ctx = {
      assetType:                 "switch",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        null,
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    };

    // Cold call: 1 integration read + 1 class-override read.
    await resolveMonitorSettings(ctx);
    expect((prisma.integration.findUnique as any).mock.calls.length).toBe(1);
    expect((prisma.monitorClassOverride.findFirst as any).mock.calls.length).toBe(1);

    // 50 more calls with the same (integration, assetType) — cache hits.
    for (let i = 0; i < 50; i++) await resolveMonitorSettings(ctx);
    expect((prisma.integration.findUnique as any).mock.calls.length).toBe(1);
    expect((prisma.monitorClassOverride.findFirst as any).mock.calls.length).toBe(1);
  });

  it("invalidateMonitorSettingsCache(scope) clears just the matching tier + class entries", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    await resolveMonitorSettings({
      assetType: "switch", discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec: null, telemetryIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    await resolveMonitorSettings({
      assetType: "switch", discoveredByIntegrationId: "fmg-2",
      monitorIntervalSec: null, telemetryIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    expect((prisma.integration.findUnique as any).mock.calls.length).toBe(2);

    // Invalidate only fmg-1; fmg-2's tier should still be cached.
    invalidateMonitorSettingsCache({ integrationId: "fmg-1" });
    await resolveMonitorSettings({
      assetType: "switch", discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec: null, telemetryIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    await resolveMonitorSettings({
      assetType: "switch", discoveredByIntegrationId: "fmg-2",
      monitorIntervalSec: null, telemetryIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    // fmg-1 hit DB again; fmg-2 still cached.
    expect((prisma.integration.findUnique as any).mock.calls.length).toBe(3);
  });
});

// ─── Provenance helper ─────────────────────────────────────────────────────

describe("resolveMonitorSettingsWithProvenance — labels each field", () => {
  it("labels every field as integration when no class or asset override applies", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettingsWithProvenance({
      assetType:                 "firewall",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        null,
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out.tier3Source).toBe("integration");
    expect(out.classOverrideId).toBeNull();
    Object.values(out.provenance).forEach((tier) => expect(tier).toBe("integration"));
  });

  it("labels manual when asset has no integration", async () => {
    (prisma.setting.findUnique as any).mockResolvedValue({ key: "manualMonitorSettings", value: TUNED_TIER });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettingsWithProvenance({
      assetType:                 "workstation",
      discoveredByIntegrationId: null,
      monitorIntervalSec:        null,
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out.tier3Source).toBe("manual");
    Object.values(out.provenance).forEach((tier) => expect(tier).toBe("manual"));
  });

  it("labels per-field provenance correctly when class + asset overrides mix", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue({
      intervalSeconds: 300, failureThreshold: null, probeTimeoutMs: 8000,
      telemetryIntervalSeconds: null, systemInfoIntervalSeconds: null,
      sampleRetentionDays: null, telemetryRetentionDays: null, systemInfoRetentionDays: null,
    });
    // Class-row id lookup for the badge UI.
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValueOnce({
      intervalSeconds: 300, failureThreshold: null, probeTimeoutMs: 8000,
      telemetryIntervalSeconds: null, systemInfoIntervalSeconds: null,
      sampleRetentionDays: null, telemetryRetentionDays: null, systemInfoRetentionDays: null,
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValueOnce({ id: "class-row-id" });

    const out = await resolveMonitorSettingsWithProvenance({
      assetType:                 "switch",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        45,    // per-asset
      telemetryIntervalSec:      null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out.provenance.intervalSeconds).toBe("asset");
    expect(out.provenance.probeTimeoutMs).toBe("class");
    expect(out.provenance.failureThreshold).toBe("integration");
    expect(out.classOverrideId).toBe("class-row-id");
  });
});
