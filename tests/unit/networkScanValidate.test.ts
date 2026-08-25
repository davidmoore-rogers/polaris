/**
 * tests/unit/networkScanValidate.test.ts — the pure halves of
 * src/services/networkScanService.ts.
 *
 * `validateScanInput` deliberately lives in the service rather than as Zod in
 * the route, because an imported `.discovery.json` has to pass exactly the same
 * checks and the caps are properties of the feature rather than of one HTTP
 * body. What's pinned:
 *
 *  - a target that expands to nothing is refused **at save time**, not at run
 *    time minutes later, and the message names the row that's wrong;
 *  - ICMP with credentials is refused rather than ignored — the credential
 *    store has no icmp type, so such a value would be a stored secret nothing
 *    reads;
 *  - a credentialed method with NO credential is refused, because it can't be
 *    attempted and would silently report every address as silent on it.
 *
 * `assetTypeForHit` is pinned for the opposite reason: it is deliberately
 * SHALLOW. Guessing "switch" from a vendor name is the kind of inference that
 * is right often enough to look correct and wrong the rest of the time, so
 * anything not saying what it is in as many words lands as `other`.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/queueService.js", () => ({ publishScanJob: async () => false }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: async () => {} }));
vi.mock("../../src/services/monitoringService.js", () => ({
  probeCredentialAgainstHost: async () => ({ success: false, responseTimeMs: 0 }),
  snmpWalkRaw: async () => ({ rows: [], truncated: false, durationMs: 0 }),
}));
vi.mock("../../src/services/credentialService.js", () => ({ getCredential: async () => { throw new Error("unused"); } }));

const { validateScanInput, assetTypeForHit, methodKeyForHit, MAX_CREDENTIALS_PER_METHOD, MAX_SCAN_TARGET_ROWS } =
  await import("../../src/services/networkScanService.js");
import type { ScanHit } from "../../src/services/networkScanRunner.js";

const base = {
  name: "Ashfield management",
  targets: [{ kind: "cidr" as const, value: "10.4.0.0/24" }],
  methods: [{ type: "icmp" as const, credentialIds: [] }],
};

const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

describe("validateScanInput — identity", () => {
  it("accepts a minimal Discovery", () => {
    expect(validateScanInput(base)).toBeNull();
  });

  it("requires a name", () => {
    expect(validateScanInput({ ...base, name: "   " })).toMatch(/name/i);
  });
});

describe("validateScanInput — targets", () => {
  it("requires at least one target", () => {
    expect(validateScanInput({ ...base, targets: [] })).toMatch(/at least one/i);
  });

  it("refuses a bad target at SAVE time, naming what's wrong", () => {
    // The alternative is a run that fails minutes later with the operator
    // looking at a progress bar.
    const problem = validateScanInput({ ...base, targets: [{ kind: "cidr", value: "10.0.0.0/8" }] });
    expect(problem).toMatch(/more than/);
  });

  it("refuses a range that runs backwards", () => {
    expect(
      validateScanInput({ ...base, targets: [{ kind: "range", value: "10.4.0.60-10.4.0.10" }] }),
    ).toMatch(/backwards/);
  });

  it("refuses targets that are entirely excluded addresses", () => {
    const problem = validateScanInput({ ...base, targets: [{ kind: "single", value: "127.0.0.1" }] });
    expect(problem).toMatch(/excluded/i);
  });

  it("caps the number of target rows", () => {
    const many = Array.from({ length: MAX_SCAN_TARGET_ROWS + 1 }, (_, i) => ({
      kind: "single" as const, value: `10.4.0.${i + 1}`,
    }));
    expect(validateScanInput({ ...base, targets: many })).toMatch(/target rows/i);
  });
});

describe("validateScanInput — methods", () => {
  it("requires at least one method", () => {
    expect(validateScanInput({ ...base, methods: [] })).toMatch(/probe method/i);
  });

  it("refuses credentials on ICMP", () => {
    // Not a formality: the credential store has no icmp type, so this would be
    // a stored reference nothing ever reads.
    expect(
      validateScanInput({ ...base, methods: [{ type: "icmp", credentialIds: [uuid(1)] }] }),
    ).toMatch(/ICMP takes no credentials/i);
  });

  it("refuses a credentialed method with no credential", () => {
    expect(
      validateScanInput({ ...base, methods: [{ type: "snmp", credentialIds: [] }] }),
    ).toMatch(/at least one credential for snmp/i);
  });

  it("refuses duplicate credentials on one method", () => {
    expect(
      validateScanInput({ ...base, methods: [{ type: "snmp", credentialIds: [uuid(1), uuid(1)] }] }),
    ).toMatch(/duplicate/i);
  });

  it("caps credentials per method", () => {
    const ids = Array.from({ length: MAX_CREDENTIALS_PER_METHOD + 1 }, (_, i) => uuid(i));
    expect(validateScanInput({ ...base, methods: [{ type: "snmp", credentialIds: ids }] })).toMatch(/At most/);
  });

  it("accepts ICMP plus a credentialed method", () => {
    expect(
      validateScanInput({
        ...base,
        methods: [
          { type: "icmp", credentialIds: [] },
          { type: "snmp", credentialIds: [uuid(1), uuid(2)] },
        ],
      }),
    ).toBeNull();
  });
});

describe("assetTypeForHit", () => {
  const hit = (over: Partial<ScanHit> = {}): ScanHit => ({
    address: "10.4.0.9",
    respondedTo: ["snmp"],
    ...over,
  });

  it("reads a device that says what it is", () => {
    expect(assetTypeForHit(hit({ identity: { os: "FortiSwitch-148F v7.2.5" } }))).toBe("switch");
    expect(assetTypeForHit(hit({ identity: { os: "FortiGate-60F v7.4.1" } }))).toBe("firewall");
    expect(assetTypeForHit(hit({ identity: { os: "FortiAP-431F" } }))).toBe("access_point");
    expect(assetTypeForHit(hit({ identity: { os: "HP LaserJet 4250" } }))).toBe("printer");
  });

  it("falls back to `other` rather than guessing from a vendor name", () => {
    // An APC PDU and an Eaton UPS are not switches because APC makes switches.
    expect(assetTypeForHit(hit({ identity: { os: "APC Web/SNMP Management Card", manufacturer: "APC" } }))).toBe("other");
    expect(assetTypeForHit(hit({ identity: { manufacturer: "Cisco" } }))).toBe("other");
    expect(assetTypeForHit(hit())).toBe("other");
  });

  it("reads the hostname as well as the OS", () => {
    expect(assetTypeForHit(hit({ identity: { hostname: "core-switch-01" } }))).toBe("switch");
  });
});

describe("methodKeyForHit", () => {
  it("keys on the method that supplied the identity", () => {
    expect(methodKeyForHit({ address: "a", respondedTo: ["icmp", "snmp"], identifiedBy: "snmp" })).toBe("snmp");
  });

  it("keys an ICMP-only responder on icmp", () => {
    // Its monitoring selection is a different question from an SNMP hit's: it
    // reported no interfaces, so only a rule-based selection can apply.
    expect(methodKeyForHit({ address: "a", respondedTo: ["icmp"] })).toBe("icmp");
  });

  it("keys a responder with neither on `unknown` rather than crashing", () => {
    expect(methodKeyForHit({ address: "a", respondedTo: [] })).toBe("unknown");
  });
});
