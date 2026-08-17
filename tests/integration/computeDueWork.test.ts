/**
 * tests/integration/computeDueWork.test.ts — the due-set computation extracted from
 * runMonitorPass. Pins the eligibility semantics the monitor tick lives by:
 * cadence due-ness, the dependency-suppression probe slowdown, the heavy-
 * cadence up-only gates, the per-method telemetry/systemInfo exclusions, the
 * fastFiltered skip-when-systemInfo-due rule, and the agentless processes
 * gating. Candidates are synthetic — computeDueWork touches the DB only
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

const ALL = new Set<MonitorCadence>(["probe", "fastFiltered", "telemetry", "systemInfo", "processes"]);
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

// ─── Fast-confirm re-probe (business rule 30) ────────────────────────────────
// The confirmation phase no longer waits a full interval per miss: an asset
// mid-run is due again after the fast-confirm cadence. The arithmetic itself is
// unit-tested in tests/unit/probeCadence.test.ts; these pin that computeDueWork
// actually applies it to the due-set.

dbDescribe("fast-confirm re-probe", () => {
  it("re-probes a warning asset inside its normal interval", async () => {
    const midRun = cand({
      monitorStatus: "warning",
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
      // A quarter of the way into the configured cadence: not due normally.
      lastMonitorAt: ago(Math.max(15, Math.floor(probeSec / 4))),
    });
    const steady = cand({ id: "steady", lastMonitorAt: ago(Math.max(15, Math.floor(probeSec / 4))) });

    const due = await computeDueWork([midRun, steady], ALL, now);
    expect(due.probes.map((p) => p.id)).toEqual(["cand-1"]);
  });

  it("re-probes an unconfirmed recovery the same way, but not a confirmed one", async () => {
    const recovering = cand({
      monitorStatus: "recovering",
      consecutiveFailures: 0,
      consecutiveSuccesses: 1,
      lastMonitorAt: ago(Math.max(15, Math.floor(probeSec / 4))),
    });
    const confirmed = cand({
      id: "confirmed",
      monitorStatus: "up",
      consecutiveFailures: 0,
      consecutiveSuccesses: 99,
      lastMonitorAt: ago(Math.max(15, Math.floor(probeSec / 4))),
    });

    const due = await computeDueWork([recovering, confirmed], ALL, now);
    expect(due.probes.map((p) => p.id)).toEqual(["cand-1"]);
  });

  it("does not accelerate a down asset — there is nothing left to confirm", async () => {
    const down = cand({
      monitorStatus: "down",
      consecutiveFailures: 12,
      consecutiveSuccesses: 0,
      lastMonitorAt: ago(Math.max(15, Math.floor(probeSec / 4))),
    });

    const due = await computeDueWork([down], ALL, now);
    expect(due.probes).toEqual([]);
  });
});
