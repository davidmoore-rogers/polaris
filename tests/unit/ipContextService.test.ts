/**
 * tests/unit/ipContextService.test.ts
 *
 * Pure-function coverage for the Add Asset IP cross-reference service: which
 * NAME-only gate source wins when both answered (pickNamedGate) and what the
 * form is offered afterwards (buildSuggestions). The DB-bound wrapper
 * (lookupIpContext) is exercised through the route.
 */

import { describe, it, expect } from "vitest";
import {
  pickNamedGate,
  buildSuggestions,
  type IpContextFirewall,
  type IpContextReservation,
} from "../../src/services/ipContextService.js";

function reservation(over: Partial<IpContextReservation> = {}): IpContextReservation {
  return {
    id: "r1", hostname: null, macAddress: null, owner: null, createdBy: null,
    sourceType: "manual", dhcpBinding: null, pushStatus: null, expiresAt: null,
    lastSeenLeased: null, lastSeenArp: null, notes: null,
    ...over,
  };
}

function firewall(asset: IpContextFirewall["asset"]): IpContextFirewall {
  return { deviceName: "PLVCORFMG1", source: "subnet", asset };
}

describe("pickNamedGate", () => {
  it("prefers the subnet's gate over a sighting", () => {
    expect(pickNamedGate("GATE-A", "GATE-B")).toEqual({ name: "GATE-A", source: "subnet" });
  });

  it("falls back to the sighting when no network names a gate", () => {
    expect(pickNamedGate(null, "GATE-B")).toEqual({ name: "GATE-B", source: "sighting" });
  });

  it("returns null when neither source names one", () => {
    expect(pickNamedGate(null, null)).toBeNull();
  });
});

describe("buildSuggestions", () => {
  it("is empty when nothing was found", () => {
    expect(buildSuggestions({ mac: null, reservation: null, firewall: null })).toEqual({});
  });

  it("carries the MAC and the reservation's hostname", () => {
    const out = buildSuggestions({
      mac: "00:1A:2B:3C:4D:5E",
      reservation: reservation({ hostname: "plv-cam-04" }),
      firewall: null,
    });
    expect(out).toEqual({ macAddress: "00:1A:2B:3C:4D:5E", hostname: "plv-cam-04" });
  });

  it("takes the gate's operator location over its learned one", () => {
    const out = buildSuggestions({
      mac: null,
      reservation: null,
      firewall: firewall({
        id: "fw1", hostname: "plv-fgt", location: "Pleasant View Plant",
        learnedLocation: "PLVCORFMG1", latitude: null, longitude: null,
      }),
    });
    expect(out.location).toBe("Pleasant View Plant");
  });

  it("falls back to the gate's learned location", () => {
    const out = buildSuggestions({
      mac: null,
      reservation: null,
      firewall: firewall({
        id: "fw1", hostname: "plv-fgt", location: null,
        learnedLocation: "PLVCORFMG1", latitude: null, longitude: null,
      }),
    });
    expect(out.location).toBe("PLVCORFMG1");
  });

  it("suggests coordinates only as a complete pair", () => {
    const half = buildSuggestions({
      mac: null,
      reservation: null,
      firewall: firewall({
        id: "fw1", hostname: "plv-fgt", location: null, learnedLocation: null,
        latitude: 36.1627, longitude: null,
      }),
    });
    expect(half.latitude).toBeUndefined();
    expect(half.longitude).toBeUndefined();

    const both = buildSuggestions({
      mac: null,
      reservation: null,
      firewall: firewall({
        id: "fw1", hostname: "plv-fgt", location: null, learnedLocation: null,
        latitude: 36.1627, longitude: -86.7816,
      }),
    });
    expect(both).toEqual({ latitude: 36.1627, longitude: -86.7816 });
  });

  it("emits nothing for a gate name with no asset behind it", () => {
    expect(buildSuggestions({ mac: null, reservation: null, firewall: firewall(null) })).toEqual({});
  });

  it("does not invent a hostname from a reservation that has none", () => {
    const out = buildSuggestions({
      mac: null,
      reservation: reservation({ macAddress: "AA:BB:CC:DD:EE:FF" }),
      firewall: null,
    });
    expect(out.hostname).toBeUndefined();
  });
});
