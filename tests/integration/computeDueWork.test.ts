/**
 * tests/integration/computeDueWork.test.ts — the due-set computation extracted from
 * runMonitorPass. Pins the eligibility semantics the monitor tick lives by:
 * cadence due-ness, the dependency-suppression probe slowdown, the heavy-
 * cadence up-only gates, the per-method telemetry/systemInfo exclusions, the
 * fastFiltered skip-when-systemInfo-due rule, the agentless processes gating,
 * the absence of any mid-run probe acceleration, and the ICMP loss sampler's
 * warning/recovering-only window. Candidates are synthetic — computeDueWork touches the DB only
 * through the (cached) settings resolver -- which is why this lives in
 * tests/integration: the resolver reads the manual-tier Setting row.
 */

import { it, expect, beforeAll } from "vitest";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  computeDueWork,
  LOSS_SAMPLES_MAX_PER_PASS,
  resolveMonitorSettings,
  type MonitorPassCandidate,
  type MonitorCadence,
} from "../../src/services/monitoringService.js";

const ALL = new Set<MonitorCadence>(["probe", "fastFiltered", "telemetry", "systemInfo", "processes", "lossSample"]);
const now = new Date("2026-08-06T12:00:00.000Z");

let probeSec = 60;
let sysInfoSec = 600;

function cand(over: Partial<MonitorPassCandidate> & { id?: string } = {}): MonitorPassCandidate {
  return {
    id: "cand-1",
    assetType: "server",
    discoveredByIntegrationId: null,
    discoveredByIntegration: null,
    monitorStatus: "up",
    consecutiveFailures: 0,
    consecutiveSuccesses: 3,
    lastMonitorAt: null,
    monitorIntervalSec: null,
    lastTelemetryAt: null,
    cpuMemoryIntervalSec: null,
    temperatureIntervalSec: null,
    lastSystemInfoAt: null,
    systemInfoIntervalSec: null,
    probeTimeoutMs: null,
    responseTimePolling: null,
    cpuMemoryPolling: null,
    temperaturePolling: null,
    interfacesPolling: null,
    lldpPolling: null,
    storagePolling: null,
    monitoredInterfaces: [],
    monitoredStorage: [],
    monitoredIpsecTunnels: [],
    processesPolling: null,
    lastProcessesAt: null,
    lastProcessPinsAt: null,
    monitoredProcesses: [],
    mappedProcesses: [],
    dependencySuppressed: false,
    // ICMP loss-sampler inputs. An address is required (there is nothing to
    // ping without one) and `status` gates on maintenance.
    lastLossSampleAt: null,
    ipAddress: "10.0.0.9",
    dnsName: null,
    hostname: "cand-1.example",
    status: "active",
    ...over,
  } as MonitorPassCandidate;
}

function ago(sec: number): Date {
  return new Date(now.getTime() - sec * 1000);
}

beforeAll(async () => {
  if (!dbReachable) return;
  // Resolve the effective defaults once so relative-timestamp tests hold
  // whatever the manual tier / hardcoded floor happens to configure.
  const eff = await resolveMonitorSettings({
    ...cand(),
    discoveredByIntegrationType: null,
  } as never);
  probeSec = eff.intervalSeconds;
  sysInfoSec = eff.systemInfoIntervalSeconds;
});

dbDescribe("computeDueWork", () => {
  it("a never-probed asset is probe-due; a freshly probed one is not", async () => {
    const due = await computeDueWork([cand()], ALL, now);
    expect(due.probes.map((w) => w.id)).toEqual(["cand-1"]);

    const fresh = await computeDueWork([cand({ lastMonitorAt: now })], ALL, now);
    expect(fresh.probes).toEqual([]);
  });

  it("dependency suppression doubles the probe cadence", async () => {
    const staleBy1_5 = ago(Math.round(probeSec * 1.5));
    const normal = await computeDueWork([cand({ lastMonitorAt: staleBy1_5 })], ALL, now);
    expect(normal.probes).toHaveLength(1);

    const suppressed = await computeDueWork(
      [cand({ lastMonitorAt: staleBy1_5, dependencySuppressed: true })], ALL, now,
    );
    expect(suppressed.probes).toEqual([]);

    const veryStale = await computeDueWork(
      [cand({ lastMonitorAt: ago(Math.round(probeSec * 2.5)), dependencySuppressed: true })], ALL, now,
    );
    expect(veryStale.probes).toHaveLength(1);
  });

  it("telemetry runs only for confirmed-up assets on a telemetry-capable method", async () => {
    const up = await computeDueWork([cand({ cpuMemoryPolling: "snmp" })], ALL, now);
    expect(up.telemetries).toHaveLength(1);

    const warning = await computeDueWork(
      [cand({ cpuMemoryPolling: "snmp", monitorStatus: "warning" })], ALL, now,
    );
    expect(warning.telemetries).toEqual([]);

    const ssh = await computeDueWork([cand({ cpuMemoryPolling: "ssh" })], ALL, now);
    expect(ssh.telemetries).toEqual([]);

    // Managed FortiSwitch on REST has no direct telemetry endpoint…
    const restSwitch = await computeDueWork(
      [cand({ cpuMemoryPolling: "rest_api", assetType: "switch" })], ALL, now,
    );
    expect(restSwitch.telemetries).toEqual([]);
    // …but a managed FortiAP on REST does (managed_ap piggyback).
    const restAp = await computeDueWork(
      [cand({ cpuMemoryPolling: "rest_api", assetType: "access_point" })], ALL, now,
    );
    expect(restAp.telemetries).toHaveLength(1);
  });

  it("systemInfo excludes the REST + managed-switch/AP combination", async () => {
    const snmp = await computeDueWork([cand({ interfacesPolling: "snmp" })], ALL, now);
    expect(snmp.systemInfos).toHaveLength(1);

    const restSwitch = await computeDueWork(
      [cand({ interfacesPolling: "rest_api", assetType: "switch" })], ALL, now,
    );
    expect(restSwitch.systemInfos).toEqual([]);
  });

  it("fastFiltered rides the probe cadence but yields to a due systemInfo pass", async () => {
    const base = {
      interfacesPolling: "snmp" as const,
      monitoredInterfaces: ["port1"],
      lastMonitorAt: null,          // probe due
      lastSystemInfoAt: now,        // systemInfo NOT due
    };
    const rides = await computeDueWork([cand(base)], ALL, now);
    expect(rides.fastFiltereds).toHaveLength(1);

    // When the full pass is also due, the pinned scrape is skipped.
    const yields = await computeDueWork(
      [cand({ ...base, lastSystemInfoAt: ago(sysInfoSec * 2) })], ALL, now,
    );
    expect(yields.fastFiltereds).toEqual([]);
    expect(yields.systemInfos).toHaveLength(1);
  });

  it("agentless processes dispatch only for ssh/winrm, with the pinned sub-pass path", async () => {
    const ssh = await computeDueWork([cand({ processesPolling: "ssh" })], ALL, now);
    expect(ssh.processesWork).toHaveLength(1);

    const agent = await computeDueWork([cand({ processesPolling: "agent" })], ALL, now);
    expect(agent.processesWork).toEqual([]);

    // Inventory fresh, but a pinned program owes the 60s sub-pass.
    const subPass = await computeDueWork(
      [cand({ processesPolling: "winrm", lastProcessesAt: now, monitoredProcesses: ["postgres"], lastProcessPinsAt: null })],
      ALL, now,
    );
    expect(subPass.processesWork).toHaveLength(1);

    // No pins + fresh inventory → nothing owed.
    const idle = await computeDueWork(
      [cand({ processesPolling: "winrm", lastProcessesAt: now })], ALL, now,
    );
    expect(idle.processesWork).toEqual([]);
  });

  it("the enabled-cadence set filters what is emitted", async () => {
    const probeOnly = await computeDueWork(
      [cand({ cpuMemoryPolling: "snmp", interfacesPolling: "snmp", processesPolling: "ssh" })],
      new Set<MonitorCadence>(["probe"]),
      now,
    );
    expect(probeOnly.probes).toHaveLength(1);
    expect(probeOnly.telemetries).toEqual([]);
    expect(probeOnly.systemInfos).toEqual([]);
    expect(probeOnly.processesWork).toEqual([]);
  });
});

// ─── No confirmation acceleration (business rule 30) ─────────────────────────
// The fast-confirm re-probe was removed 2026-08-19: `down` is now
// `failureThreshold` misses of the configured transport at the configured
// cadence, full stop. These pin that computeDueWork does NOT accelerate a
// mid-run asset — reintroducing it here would silently change what `down`
// means, and would double-count a miss inside a probe timeout. The spacing
// arithmetic itself is unit-tested in tests/unit/probeCadence.test.ts.

dbDescribe("probe cadence is not accelerated mid-run", () => {
  const quarterIn = () => ago(Math.max(15, Math.floor(probeSec / 4)));

  it("leaves a warning asset on its configured interval", async () => {
    const midRun = cand({ monitorStatus: "warning", consecutiveFailures: 1, consecutiveSuccesses: 0, lastMonitorAt: quarterIn() });
    const steady = cand({ id: "steady", lastMonitorAt: quarterIn() });

    const due = await computeDueWork([midRun, steady], ALL, now);
    expect(due.probes).toEqual([]);
  });

  it("leaves an unconfirmed recovery on its configured interval", async () => {
    const recovering = cand({ monitorStatus: "recovering", consecutiveFailures: 0, consecutiveSuccesses: 1, lastMonitorAt: quarterIn() });

    const due = await computeDueWork([recovering], ALL, now);
    expect(due.probes).toEqual([]);
  });

  it("still probes a mid-run asset once its interval has elapsed", async () => {
    const midRun = cand({ monitorStatus: "warning", consecutiveFailures: 1, consecutiveSuccesses: 0, lastMonitorAt: ago(probeSec) });

    const due = await computeDueWork([midRun], ALL, now);
    expect(due.probes.map((p) => p.id)).toEqual(["cand-1"]);
  });

  it("leaves a down asset on its configured interval too", async () => {
    const down = cand({ monitorStatus: "down", consecutiveFailures: 12, consecutiveSuccesses: 0, lastMonitorAt: quarterIn() });

    const due = await computeDueWork([down], ALL, now);
    expect(due.probes).toEqual([]);
  });
});

// ─── ICMP packet-loss sampler (business rule 30) ──────────────────────────────
// The 10s side-probe that replaced fast-confirm. It exists to give probeLossPct
// resolution during a run and feeds NOTHING else — the predicate itself is
// unit-tested in tests/unit/lossSampler.test.ts; these pin that computeDueWork
// puts it in the due-set at the right times and, crucially, never for a `down`
// asset (where an uncorroborated ICMP reply could mask a 100% loss reading).

dbDescribe("loss-sample due-set", () => {
  it("samples a warning asset and a recovering one", async () => {
    const warning = cand({ id: "warning", monitorStatus: "warning", consecutiveFailures: 1, consecutiveSuccesses: 0 });
    const recovering = cand({ id: "recovering", monitorStatus: "recovering", consecutiveFailures: 0, consecutiveSuccesses: 1 });

    const due = await computeDueWork([warning, recovering], ALL, now);
    expect(due.lossSamples.map((w) => w.id).sort()).toEqual(["recovering", "warning"]);
    expect(due.lossSamples.every((w) => w.kind === "lossSample")).toBe(true);
  });

  it("does not sample a down asset, an up asset, or one never probed", async () => {
    const down = cand({ id: "down", monitorStatus: "down", consecutiveFailures: 9 });
    const up = cand({ id: "up", monitorStatus: "up" });
    const unknown = cand({ id: "unknown", monitorStatus: "unknown" });

    const due = await computeDueWork([down, up, unknown], ALL, now);
    expect(due.lossSamples).toEqual([]);
  });

  it("skips a suppressed asset — never ping into an upstream outage", async () => {
    const suppressed = cand({ monitorStatus: "warning", consecutiveFailures: 1, dependencySuppressed: true });

    const due = await computeDueWork([suppressed], ALL, now);
    expect(due.lossSamples).toEqual([]);
  });

  it("skips an asset with nothing to ping", async () => {
    const nameless = cand({ monitorStatus: "warning", consecutiveFailures: 1, ipAddress: null, dnsName: null, hostname: null });

    const due = await computeDueWork([nameless], ALL, now);
    expect(due.lossSamples).toEqual([]);
  });

  it("honours the 10s cadence", async () => {
    const fresh = cand({ id: "fresh", monitorStatus: "warning", consecutiveFailures: 1, lastLossSampleAt: ago(4) });
    const stale = cand({ id: "stale", monitorStatus: "warning", consecutiveFailures: 1, lastLossSampleAt: ago(11) });

    const due = await computeDueWork([fresh, stale], ALL, now);
    expect(due.lossSamples.map((w) => w.id)).toEqual(["stale"]);
  });

  it("is independent of the probe due-check — both can be due on one tick", async () => {
    // Separate anchors: the sampler must not disturb the response-time cadence,
    // and a warning asset whose interval has elapsed owes both.
    const both = cand({ monitorStatus: "warning", consecutiveFailures: 1, lastMonitorAt: ago(probeSec), lastLossSampleAt: ago(30) });

    const due = await computeDueWork([both], ALL, now);
    expect(due.probes.map((p) => p.id)).toEqual(["cand-1"]);
    expect(due.lossSamples.map((w) => w.id)).toEqual(["cand-1"]);
  });

  it("caps the due-set so one pass can never starve the probe cadence", async () => {
    // A site outage puts hundreds of assets into warning at once. runMonitorPass
    // awaits the whole pass, so an uncapped burst would delay the next light tick
    // and with it the probes that decide whether those assets are really down.
    const many = Array.from({ length: LOSS_SAMPLES_MAX_PER_PASS + 25 }, (_, i) =>
      cand({ id: `w-${i}`, monitorStatus: "warning", consecutiveFailures: 1 }),
    );

    const due = await computeDueWork(many, ALL, now);
    expect(due.lossSamples).toHaveLength(LOSS_SAMPLES_MAX_PER_PASS);
    // Probes are unaffected by the cap — they are the cadence being protected.
    expect(due.probes).toHaveLength(many.length);
  });

  it("collects nothing when the cadence is not enabled", async () => {
    const warning = cand({ monitorStatus: "warning", consecutiveFailures: 1 });

    const due = await computeDueWork([warning], new Set<MonitorCadence>(["probe"]), now);
    expect(due.lossSamples).toEqual([]);
  });
});
