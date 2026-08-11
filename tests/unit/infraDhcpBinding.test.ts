/**
 * tests/unit/infraDhcpBinding.test.ts — the lease-vs-binding decisions behind
 * Fortinet-infra reservation rows (src/utils/infraDhcpBinding.ts).
 *
 * The bug these exist to prevent: Phase 3a/3b create a fortiswitch/fortinap
 * reservation for every managed switch/AP, sometimes from an address read out of
 * the gate's DHCP lease table, and Phase 5 had no branch for those source types
 * — so a leased address rendered as an authoritative reservation with no Reserve
 * action while the FortiGate reported "Not Reserved".
 *
 * Four properties are pinned hardest, because each one is a way the feature could
 * silently do damage rather than merely misbehave:
 *   - `expiresAt` is NEVER staged (it would hand these rows to expireReservations
 *     and churn a live AP through expired/re-created cycles),
 *   - the MAC is fill-only and comes from the lease entry (a wrong MAC yields a
 *     device-side binding that looks right everywhere and never binds),
 *   - only an explicit "lease" is claimable — NULL means unobserved, not free,
 *   - a reservation for THIS device isn't a conflict with this device (otherwise
 *     the first reserved AP produces a conflict card per cycle).
 */

import { describe, it, expect } from "vitest";
import {
  INFRA_SOURCE_TYPES,
  decideInfraDhcpBinding,
  isInfraSourceType,
  isLeaseBackedInfraRow,
  reservationBelongsToInfraDevice,
  type InfraDhcpEntry,
  type InfraReservationRow,
} from "../../src/utils/infraDhcpBinding.js";

const leaseEntry: InfraDhcpEntry = { type: "dhcp-lease", macAddress: "48:3a:02:90:1b:68" };
const reservedEntry: InfraDhcpEntry = { type: "dhcp-reservation", macAddress: "48:3a:02:90:1b:68" };

function apRow(over: Partial<InfraReservationRow> = {}): InfraReservationRow {
  return { sourceType: "fortinap", macAddress: null, hostname: "APPOMATTOX-108F-3", dhcpBinding: null, ...over };
}

describe("isInfraSourceType", () => {
  it("covers exactly the two managed-infra source types", () => {
    for (const t of INFRA_SOURCE_TYPES) expect(isInfraSourceType(t)).toBe(true);
    for (const t of ["manual", "dhcp_lease", "dhcp_reservation", "vip", "interface_ip", "dns_resolved"]) {
      expect(isInfraSourceType(t)).toBe(false);
    }
    expect(isInfraSourceType(null)).toBe(false);
    expect(isInfraSourceType(undefined)).toBe(false);
  });
});

describe("isLeaseBackedInfraRow", () => {
  it("admits an infra row the gate only leases", () => {
    expect(isLeaseBackedInfraRow(apRow({ dhcpBinding: "lease" }))).toBe(true);
    expect(isLeaseBackedInfraRow({ sourceType: "fortiswitch", dhcpBinding: "lease" })).toBe(true);
  });

  it("refuses a row backed by a real MAC-to-IP binding", () => {
    expect(isLeaseBackedInfraRow(apRow({ dhcpBinding: "reservation" }))).toBe(false);
  });

  it("refuses NULL — unobserved is not the same as free", () => {
    // The AP may be on a static address or simply not leasing right now.
    // Treating absence of evidence as "claimable" would hand an operator an
    // address a device is actively using.
    expect(isLeaseBackedInfraRow(apRow({ dhcpBinding: null }))).toBe(false);
    expect(isLeaseBackedInfraRow(apRow({ dhcpBinding: undefined }))).toBe(false);
  });

  it("never admits a non-infra row, whatever its binding says", () => {
    expect(isLeaseBackedInfraRow({ sourceType: "manual", dhcpBinding: "lease" })).toBe(false);
    expect(isLeaseBackedInfraRow(null)).toBe(false);
  });
});

describe("decideInfraDhcpBinding", () => {
  it("records a lease-backed address and fills the MAC from the lease entry", () => {
    const patch = decideInfraDhcpBinding(apRow(), leaseEntry);
    expect(patch).toEqual({ dhcpBinding: "lease", macAddress: "48:3A:02:90:1B:68" });
  });

  it("records a real device-side reservation as such", () => {
    const patch = decideInfraDhcpBinding(apRow(), reservedEntry);
    expect(patch?.dhcpBinding).toBe("reservation");
  });

  it("NEVER stages expiresAt", () => {
    // A lease carries an expiry; stamping it here would let expireReservations
    // flip a live AP's row to `expired`, which discovery then re-creates —
    // churn, plus windows where the device reads as unreserved.
    const patch = decideInfraDhcpBinding(apRow(), { ...leaseEntry, seenLeased: true });
    expect(patch).not.toHaveProperty("expiresAt");
    expect(Object.keys(patch!).sort()).toEqual(["dhcpBinding", "lastSeenLeased", "macAddress"]);
  });

  it("never touches sourceType — ownership is a separate fact", () => {
    const patch = decideInfraDhcpBinding(apRow(), leaseEntry);
    expect(patch).not.toHaveProperty("sourceType");
  });

  it("leaves an existing MAC alone (fill-only)", () => {
    const row = apRow({ macAddress: "AA:BB:CC:DD:EE:FF", dhcpBinding: "lease" });
    expect(decideInfraDhcpBinding(row, leaseEntry)).toBeNull();
  });

  it("returns null in steady state so the hot path issues no write", () => {
    // This runs per DHCP entry per discovery cycle; at 2000 assets an
    // unconditional write here is the cost the surrounding code bulks to avoid.
    const settled = apRow({ macAddress: "48:3A:02:90:1B:68", dhcpBinding: "lease" });
    expect(decideInfraDhcpBinding(settled, leaseEntry)).toBeNull();
  });

  it("still bumps presence when the entry is actively leased", () => {
    const settled = apRow({ macAddress: "48:3A:02:90:1B:68", dhcpBinding: "lease" });
    expect(decideInfraDhcpBinding(settled, { ...leaseEntry, seenLeased: true }))
      .toEqual({ lastSeenLeased: true });
  });

  it("flips binding when the gate's state changes in either direction", () => {
    const leased = apRow({ macAddress: "48:3A:02:90:1B:68", dhcpBinding: "lease" });
    expect(decideInfraDhcpBinding(leased, reservedEntry)).toEqual({ dhcpBinding: "reservation" });
    const reserved = apRow({ macAddress: "48:3A:02:90:1B:68", dhcpBinding: "reservation" });
    expect(decideInfraDhcpBinding(reserved, leaseEntry)).toEqual({ dhcpBinding: "lease" });
  });

  it("normalizes the lease MAC into storage form", () => {
    const patch = decideInfraDhcpBinding(apRow(), { type: "dhcp-lease", macAddress: "48-3a-02-90-1b-68" });
    expect(patch?.macAddress).toBe("48:3A:02:90:1B:68");
  });

  it("tolerates a lease entry with no MAC", () => {
    const patch = decideInfraDhcpBinding(apRow(), { type: "dhcp-lease" });
    expect(patch).toEqual({ dhcpBinding: "lease" });
  });

  it("declines to decide anything about a non-infra row", () => {
    expect(decideInfraDhcpBinding({ sourceType: "dhcp_lease" }, leaseEntry)).toBeNull();
    expect(decideInfraDhcpBinding({ sourceType: "manual" }, reservedEntry)).toBeNull();
  });
});

describe("reservationBelongsToInfraDevice", () => {
  it("matches on MAC", () => {
    const row: InfraReservationRow = { sourceType: "manual", macAddress: "48:3a:02:90:1b:68", hostname: "typo-name" };
    expect(reservationBelongsToInfraDevice(row, { mac: "48:3A:02:90:1B:68", name: "APPOMATTOX-108F-3" })).toBe(true);
  });

  it("trusts MAC over hostname when both are known and MAC disagrees", () => {
    // Hostname collisions across sites are common; a MAC mismatch is decisive,
    // so this must stay a conflict rather than being waved through by the name.
    const row: InfraReservationRow = { sourceType: "manual", macAddress: "AA:BB:CC:DD:EE:FF", hostname: "AP-1" };
    expect(reservationBelongsToInfraDevice(row, { mac: "48:3A:02:90:1B:68", name: "AP-1" })).toBe(false);
  });

  it("falls back to hostname when either side has no MAC", () => {
    const row: InfraReservationRow = { sourceType: "manual", macAddress: null, hostname: "appomattox-108f-3" };
    expect(reservationBelongsToInfraDevice(row, { mac: null, name: "APPOMATTOX-108F-3" })).toBe(true);
    expect(reservationBelongsToInfraDevice(row, { mac: "48:3A:02:90:1B:68", name: "APPOMATTOX-108F-3" })).toBe(true);
  });

  it("accepts a Polaris-pushed row at the device's own address", () => {
    const row: InfraReservationRow = { sourceType: "manual", macAddress: null, hostname: null, pushedToId: "int-1" };
    expect(reservationBelongsToInfraDevice(row, { mac: null, name: "AP-1" })).toBe(true);
  });

  it("still reports a genuine collision", () => {
    // An operator reserved this address for something else entirely — the
    // conflict card is the correct outcome and must survive.
    const row: InfraReservationRow = { sourceType: "manual", macAddress: null, hostname: "printer-3" };
    expect(reservationBelongsToInfraDevice(row, { mac: "48:3A:02:90:1B:68", name: "AP-1" })).toBe(false);
    expect(reservationBelongsToInfraDevice(row, { mac: null, name: null })).toBe(false);
  });

  it("is false for a missing row", () => {
    expect(reservationBelongsToInfraDevice(null, { mac: "48:3A:02:90:1B:68", name: "AP-1" })).toBe(false);
  });
});
