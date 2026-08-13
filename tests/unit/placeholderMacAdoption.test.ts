import { describe, it, expect } from "vitest";
import {
  buildMacEvidenceIndex,
  isAdoptionCandidate,
  createAdoptionBudget,
  ADOPTION_RUN_CEILING,
  type AdoptionCandidateRow,
} from "../../src/services/placeholderMacAdoptionService.js";

const PREFIX = "02:0F:5E";
const INTEGRATION = "int-1";

function row(over: Partial<AdoptionCandidateRow> = {}): AdoptionCandidateRow {
  return {
    status: "active",
    ipAddress: "10.0.0.5",
    macAddress: "02:0f:5e:aa:bb:cc",
    pushStatus: "synced",
    subnetDiscoveredBy: INTEGRATION,
    subnetFortigateDevice: "FGT-Nashville",
    ...over,
  };
}

const REAL_MAC = "FC:AA:14:11:22:33";

describe("buildMacEvidenceIndex", () => {
  it("keys on device+ip so overlapping RFC1918 subnets can't cross-match", () => {
    const idx = buildMacEvidenceIndex(
      [
        { fortigateDevice: "FGT-A", ip: "10.0.0.5", mac: "aa:aa:aa:aa:aa:aa" },
        { fortigateDevice: "FGT-B", ip: "10.0.0.5", mac: "bb:bb:bb:bb:bb:bb" },
      ],
      [],
    );
    expect(idx.get("fgt-a|10.0.0.5")?.mac).toBe("AA:AA:AA:AA:AA:AA");
    expect(idx.get("fgt-b|10.0.0.5")?.mac).toBe("BB:BB:BB:BB:BB:BB");
  });

  it("matches case-insensitively on the device but keeps the original for the DB filter", () => {
    const idx = buildMacEvidenceIndex(
      [{ fortigateDevice: "FGT-Nashville", ip: "10.0.0.5", mac: REAL_MAC }],
      [],
    );
    const hit = idx.get("fgt-nashville|10.0.0.5");
    expect(hit?.device).toBe("FGT-Nashville");
  });

  it("prefers ARP over device inventory for the same address", () => {
    const idx = buildMacEvidenceIndex(
      [{ fortigateDevice: "FGT-A", ip: "10.0.0.5", mac: "aa:aa:aa:aa:aa:aa" }],
      [{ device: "FGT-A", ipAddress: "10.0.0.5", macAddress: "bb:bb:bb:bb:bb:bb", isOnline: true }],
    );
    expect(idx.get("fgt-a|10.0.0.5")).toMatchObject({ mac: "AA:AA:AA:AA:AA:AA", source: "arp" });
  });

  it("uses inventory when ARP has nothing for that address", () => {
    const idx = buildMacEvidenceIndex(
      [],
      [{ device: "FGT-A", ipAddress: "10.0.0.5", macAddress: REAL_MAC, isOnline: true }],
    );
    expect(idx.get("fgt-a|10.0.0.5")).toMatchObject({ mac: REAL_MAC, source: "device-inventory" });
  });

  it("an offline inventory row does not displace an online one", () => {
    const idx = buildMacEvidenceIndex(
      [],
      [
        { device: "FGT-A", ipAddress: "10.0.0.5", macAddress: "aa:aa:aa:aa:aa:aa", isOnline: true },
        { device: "FGT-A", ipAddress: "10.0.0.5", macAddress: "bb:bb:bb:bb:bb:bb", isOnline: false },
      ],
    );
    expect(idx.get("fgt-a|10.0.0.5")?.mac).toBe("AA:AA:AA:AA:AA:AA");
  });

  // A duplicate IP on the wire: neither answer is safe to burn into DHCP config.
  it("drops an address two ARP rows disagree about, permanently", () => {
    const idx = buildMacEvidenceIndex(
      [
        { fortigateDevice: "FGT-A", ip: "10.0.0.5", mac: "aa:aa:aa:aa:aa:aa" },
        { fortigateDevice: "FGT-A", ip: "10.0.0.5", mac: "bb:bb:bb:bb:bb:bb" },
        { fortigateDevice: "FGT-A", ip: "10.0.0.5", mac: "aa:aa:aa:aa:aa:aa" },
      ],
      [],
    );
    expect(idx.has("fgt-a|10.0.0.5")).toBe(false);
  });

  it("keeps an address two ARP rows agree about", () => {
    const idx = buildMacEvidenceIndex(
      [
        { fortigateDevice: "FGT-A", ip: "10.0.0.5", mac: "aa:aa:aa:aa:aa:aa" },
        { fortigateDevice: "FGT-A", ip: "10.0.0.5", mac: "AA-AA-AA-AA-AA-AA" },
      ],
      [],
    );
    expect(idx.get("fgt-a|10.0.0.5")?.mac).toBe("AA:AA:AA:AA:AA:AA");
  });

  it("drops rows missing a device, an IP, or a usable MAC", () => {
    const idx = buildMacEvidenceIndex(
      [
        { fortigateDevice: null, ip: "10.0.0.5", mac: REAL_MAC },
        { fortigateDevice: "FGT-A", ip: null, mac: REAL_MAC },
        { fortigateDevice: "FGT-A", ip: "10.0.0.6", mac: "nonsense" },
        { fortigateDevice: "FGT-A", ip: "10.0.0.7", mac: "00:00:00:00:00:00" },
      ],
      [{ device: "FGT-A", ipAddress: "10.0.0.8", macAddress: null }],
    );
    expect(idx.size).toBe(0);
  });
});

describe("isAdoptionCandidate", () => {
  it("accepts a placeholder row with a real MAC observed at its IP", () => {
    expect(isAdoptionCandidate(row(), REAL_MAC, PREFIX, INTEGRATION)).toBe(true);
  });

  // The single condition that makes an unattended overwrite defensible.
  it("refuses to touch an operator-typed real MAC", () => {
    expect(isAdoptionCandidate(
      row({ macAddress: "00:50:56:aa:bb:cc" }), REAL_MAC, PREFIX, INTEGRATION,
    )).toBe(false);
  });

  it("never swaps one placeholder for another", () => {
    expect(isAdoptionCandidate(row(), "02:0F:5E:99:88:77", PREFIX, INTEGRATION)).toBe(false);
  });

  it("does nothing when the observed MAC is already the stored one", () => {
    expect(isAdoptionCandidate(row(), "02:0F:5E:AA:BB:CC", PREFIX, INTEGRATION)).toBe(false);
  });

  it("refuses a row this integration does not own", () => {
    expect(isAdoptionCandidate(
      row({ subnetDiscoveredBy: "other-int" }), REAL_MAC, PREFIX, INTEGRATION,
    )).toBe(false);
  });

  it("refuses a row with no gate to write to", () => {
    expect(isAdoptionCandidate(
      row({ subnetFortigateDevice: null }), REAL_MAC, PREFIX, INTEGRATION,
    )).toBe(false);
  });

  // Stops a gate that refuses the write from being asked again every cycle.
  it("refuses a row already parked at failed_permanent", () => {
    expect(isAdoptionCandidate(
      row({ pushStatus: "failed_permanent" }), REAL_MAC, PREFIX, INTEGRATION,
    )).toBe(false);
  });

  it("accepts a queued row — the retry tick will carry the new MAC", () => {
    expect(isAdoptionCandidate(row({ pushStatus: "pending" }), REAL_MAC, PREFIX, INTEGRATION))
      .toBe(true);
  });

  it("accepts a never-pushed row", () => {
    expect(isAdoptionCandidate(row({ pushStatus: null }), REAL_MAC, PREFIX, INTEGRATION))
      .toBe(true);
  });

  it("refuses a released or expired row", () => {
    for (const status of ["released", "expired"]) {
      expect(isAdoptionCandidate(row({ status }), REAL_MAC, PREFIX, INTEGRATION)).toBe(false);
    }
  });

  it("refuses rows missing an IP or a MAC", () => {
    expect(isAdoptionCandidate(row({ ipAddress: null }), REAL_MAC, PREFIX, INTEGRATION)).toBe(false);
    expect(isAdoptionCandidate(row({ macAddress: null }), REAL_MAC, PREFIX, INTEGRATION)).toBe(false);
  });

  it("refuses unusable observed MACs", () => {
    for (const mac of [null, undefined, "", "nonsense", "00:00:00:00:00:00"]) {
      expect(isAdoptionCandidate(row(), mac, PREFIX, INTEGRATION)).toBe(false);
    }
  });

  // The documented escape hatch for installs that generated MACs before this
  // feature: with prefix "02", a genuine 02: device presents that same 02: MAC
  // in ARP, so its row reads as placeholder-observed and is skipped rather than
  // churned. That is what keeps the broad prefix safe.
  it("a real 02: device at a 02: reservation is skipped under the legacy prefix", () => {
    expect(isAdoptionCandidate(
      row({ macAddress: "02:11:22:33:44:55" }), "02:AA:BB:CC:DD:EE", "02", INTEGRATION,
    )).toBe(false);
  });
});

describe("createAdoptionBudget", () => {
  it("defaults to the run ceiling", () => {
    expect(createAdoptionBudget().remaining).toBe(ADOPTION_RUN_CEILING);
  });

  it("clamps a negative ceiling to zero rather than inverting the guard", () => {
    expect(createAdoptionBudget(-5).remaining).toBe(0);
  });

  it("is a shared mutable object, so every gate in a run draws from one pool", () => {
    const budget = createAdoptionBudget(10);
    budget.remaining -= 4;
    budget.remaining -= 4;
    expect(budget.remaining).toBe(2);
  });
});
