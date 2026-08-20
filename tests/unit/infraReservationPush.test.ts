/**
 * tests/unit/infraReservationPush.test.ts — the eligibility gate in front of an
 * automatic write to a production FortiGate (src/services/infraReservationPushService.ts).
 *
 * This predicate is the only thing standing between a discovery cycle and a
 * DHCP config change on a live device, so each condition is pinned separately
 * rather than tested in aggregate. The ones that matter most:
 *   - a MAC is mandatory, because a reservation bound to the wrong MAC looks
 *     correct on both sides and silently never binds,
 *   - a previously-attempted row is never retried, which is what stops a gate
 *     that refuses these entries from being asked on every cycle forever, and
 *   - only addresses the device already holds by LEASE are eligible, so this
 *     can never claim free pool space.
 */

import { describe, it, expect } from "vitest";
import {
  isInfraPushCandidate,
  type InfraPushCandidateRow,
} from "../../src/services/infraReservationPushService.js";

const INT = "int-fmg";

function candidate(over: Partial<InfraPushCandidateRow> = {}): InfraPushCandidateRow {
  return {
    sourceType: "fortinap",
    dhcpBinding: "lease",
    macAddress: "48:3A:02:00:00:01",
    pushedToId: null,
    pushStatus: null,
    subnetDiscoveredBy: INT,
    subnetFortigateDevice: "STONEHAVEN-101F-1",
    ...over,
  };
}

describe("isInfraPushCandidate", () => {
  it("accepts a lease-backed managed AP or switch with a lease MAC", () => {
    expect(isInfraPushCandidate(candidate(), INT)).toBe(true);
    expect(isInfraPushCandidate(candidate({ sourceType: "fortiswitch" }), INT)).toBe(true);
  });

  it("only ever targets managed-infra rows", () => {
    for (const sourceType of ["manual", "dhcp_lease", "dhcp_reservation", "vip", "interface_ip", "dns_resolved"]) {
      expect(isInfraPushCandidate(candidate({ sourceType }), INT)).toBe(false);
    }
  });

  it("requires the address to be LEASED, not already reserved or unobserved", () => {
    // "reservation" means the binding already exists — nothing to do.
    expect(isInfraPushCandidate(candidate({ dhcpBinding: "reservation" }), INT)).toBe(false);
    // null means DHCP never reported the address at all (a statically-addressed
    // AP). Writing a binding for an address we never saw leased is exactly the
    // guess this feature must not make.
    expect(isInfraPushCandidate(candidate({ dhcpBinding: null }), INT)).toBe(false);
    expect(isInfraPushCandidate(candidate({ dhcpBinding: undefined }), INT)).toBe(false);
  });

  it("refuses without a MAC", () => {
    // DHCP reservations are MAC→IP. No MAC means no binding is possible, and the
    // MAC on these rows only ever comes from the gate's own lease table.
    expect(isInfraPushCandidate(candidate({ macAddress: null }), INT)).toBe(false);
    expect(isInfraPushCandidate(candidate({ macAddress: "" }), INT)).toBe(false);
  });

  it("never re-attempts a row that already carries push state", () => {
    expect(isInfraPushCandidate(candidate({ pushedToId: INT }), INT)).toBe(false);
    expect(isInfraPushCandidate(candidate({ pushStatus: "synced" }), INT)).toBe(false);
    // The important one: a gate that permanently refused must not be asked again
    // on the next discovery cycle, and the next, and the next.
    expect(isInfraPushCandidate(candidate({ pushStatus: "failed_permanent" }), INT)).toBe(false);
    expect(isInfraPushCandidate(candidate({ pushStatus: "pending" }), INT)).toBe(false);
  });

  it("only touches subnets this integration discovered", () => {
    expect(isInfraPushCandidate(candidate({ subnetDiscoveredBy: "int-other" }), INT)).toBe(false);
    expect(isInfraPushCandidate(candidate({ subnetDiscoveredBy: null }), INT)).toBe(false);
  });

  it("needs a FortiGate to write to", () => {
    expect(isInfraPushCandidate(candidate({ subnetFortigateDevice: null }), INT)).toBe(false);
    expect(isInfraPushCandidate(candidate({ subnetFortigateDevice: "" }), INT)).toBe(false);
  });
});
