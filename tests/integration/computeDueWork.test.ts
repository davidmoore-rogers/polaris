/**
 * tests/integration/computeDueWork.test.ts — the due-set computation extracted from
 * runMonitorPass. Pins the eligibility semantics the monitor tick lives by:
 * cadence due-ness, the dependency-suppression probe slowdown, the heavy-
 * cadence up-only gates, the per-method telemetry/systemInfo exclusions, the
 * fastFiltered skip-when-systemInfo-due rule, the agentless processes gating,
 * the absence of any mid-run probe acceleration, and the ICMP loss sampler's
 * disabled state (LOSS_SAMPLER_ENABLED kill switch — see utils/lossSampler.ts).
 * Candidates are synthetic — computeDueWork touches the DB only
 * through the (cached) settings resolver -- which is why this lives in
 * tests/integration: the resolver reads the manual-tier Setting row.
 */

import { it, expect, beforeAll } from "vitest";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  computeDueWork,
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

    // ssh / winrm used to be excluded here because no collector existed;
    // agentlessHostService supplies one, so they enqueue like any other
    // transport now. icmp still carries no payload and stays out.
    const ssh = await computeDueWork([cand({ cpuMemoryPolling: "ssh" })], ALL, now);
    expect(ssh.telemetries).toHaveLength(1);
    const winrm = await computeDueWork([cand({ cpuMemoryPolling: "winrm" })], ALL, now);
    expect(winrm.telemetries).toHaveLength(1);
    const icmp = await computeDueWork([cand({ cpuMemoryPolling: "icmp" })], ALL, now);
    expect(icmp.telemetries).toEqual([]);

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
// The 10s side-probe that replaced fast-confirm — currently DISABLED via the
// LOSS_SAMPLER_ENABLED kill switch in utils/lossSampler.ts (operator decision,
// 2026-08-20: the non-uniform sampling bias made alert readings diverge from
// the wall-clock chart average; packet loss reads from the response-time poll
// alone for now). These pin the disabled state: an otherwise-eligible asset
// collects nothing, and probes are untouched. The window predicate itself
// stays verified in tests/unit/lossSampler.test.ts (explicit enabled=true);
// the enabled-path due-set tests (window, 10s cadence, per-pass cap,
// probe-independence) lived here before the switch — restore them from this
// block's git history when the sampler is re-enabled.

dbDescribe("loss-sample due-set (sampler disabled)", () => {
  it("collects nothing even for warning/recovering assets while the kill switch is off", async () => {
    const warning = cand({ id: "warning", monitorStatus: "warning", consecutiveFailures: 1, consecutiveSuccesses: 0 });
    const recovering = cand({ id: "recovering", monitorStatus: "recovering", consecutiveFailures: 0, consecutiveSuccesses: 1 });

    const due = await computeDueWork([warning, recovering], ALL, now);
    expect(due.lossSamples).toEqual([]);
  });

  it("leaves the probe cadence untouched — down detection is unaffected", async () => {
    const warning = cand({ monitorStatus: "warning", consecutiveFailures: 1, lastMonitorAt: ago(probeSec), lastLossSampleAt: ago(30) });

    const due = await computeDueWork([warning], ALL, now);
    expect(due.probes.map((p) => p.id)).toEqual(["cand-1"]);
    expect(due.lossSamples).toEqual([]);
  });
});
