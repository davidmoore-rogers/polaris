import { describe, it, expect } from "vitest";
import { classifyPresenceSignal, type PresenceCandidate } from "../../src/services/presenceVerificationService.js";

const FLOOR = new Date("2026-06-01T00:00:00Z").getTime();
const FRESH = new Date("2026-06-01T06:00:00Z"); // after floor
const STALE = new Date("2026-05-20T00:00:00Z"); // before floor

function candidate(over: Partial<PresenceCandidate>): PresenceCandidate {
  return {
    lastSeen: null,
    monitored: false,
    monitorStatus: null,
    lastMonitorAt: null,
    managedAgent: null,
    ...over,
  };
}

describe("classifyPresenceSignal", () => {
  it("fresh lastSeen wins before everything", () => {
    const a = candidate({
      lastSeen: FRESH,
      managedAgent: { lastSeenAt: FRESH },
      monitored: true, monitorStatus: "up", lastMonitorAt: FRESH,
    });
    expect(classifyPresenceSignal(a, FLOOR)).toEqual({ kind: "fresh" });
  });

  it("stale lastSeen falls through to agent heartbeat", () => {
    const a = candidate({ lastSeen: STALE, managedAgent: { lastSeenAt: FRESH } });
    expect(classifyPresenceSignal(a, FLOOR)).toEqual({ kind: "agent", evidenceAt: FRESH });
  });

  it("stale agent heartbeat does not count", () => {
    const a = candidate({ managedAgent: { lastSeenAt: STALE } });
    expect(classifyPresenceSignal(a, FLOOR)).toEqual({ kind: "ping" });
  });

  it("monitored + up + fresh probe → probe", () => {
    const a = candidate({ monitored: true, monitorStatus: "up", lastMonitorAt: FRESH });
    expect(classifyPresenceSignal(a, FLOOR)).toEqual({ kind: "probe", evidenceAt: FRESH });
  });

  it("recovering also counts as answering", () => {
    const a = candidate({ monitored: true, monitorStatus: "recovering", lastMonitorAt: FRESH });
    expect(classifyPresenceSignal(a, FLOOR).kind).toBe("probe");
  });

  it("down / warning / unmonitored assets fall through to ping", () => {
    expect(classifyPresenceSignal(candidate({ monitored: true, monitorStatus: "down", lastMonitorAt: FRESH }), FLOOR).kind).toBe("ping");
    expect(classifyPresenceSignal(candidate({ monitored: true, monitorStatus: "warning", lastMonitorAt: FRESH }), FLOOR).kind).toBe("ping");
    expect(classifyPresenceSignal(candidate({ monitored: false, monitorStatus: "up", lastMonitorAt: FRESH }), FLOOR).kind).toBe("ping");
  });

  it("monitored + up but stale probe falls through to ping", () => {
    const a = candidate({ monitored: true, monitorStatus: "up", lastMonitorAt: STALE });
    expect(classifyPresenceSignal(a, FLOOR).kind).toBe("ping");
  });

  it("no signals at all → ping", () => {
    expect(classifyPresenceSignal(candidate({}), FLOOR)).toEqual({ kind: "ping" });
  });
});
