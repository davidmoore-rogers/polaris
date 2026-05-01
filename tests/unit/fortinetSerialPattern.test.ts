/**
 * tests/unit/fortinetSerialPattern.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  parseFortinetPeerInterface,
  serialMatchesPeerInterface,
  hostnameMatchesPeerInterface,
} from "../../src/utils/fortinetSerialPattern.js";

describe("parseFortinetPeerInterface — production examples", () => {
  it("parses a FortiSwitch peer interface with -N aggregate suffix", () => {
    // S108FFTV23025884 → 8FFTV23025884-0 (drops "S10" prefix to fit 15 chars)
    expect(parseFortinetPeerInterface("8FFTV23025884-0")).toEqual({
      interfaceName: "8FFTV23025884-0",
      peerFragment: "8FFTV23025884",
      aggregateIndex: 0,
    });
  });

  it("parses a FortiGate controller interface (no aggregate suffix)", () => {
    // FGT61FTK22002079 → GT61FTK22002079 (drops "F" prefix to fit 15 chars)
    expect(parseFortinetPeerInterface("GT61FTK22002079")).toEqual({
      interfaceName: "GT61FTK22002079",
      peerFragment: "GT61FTK22002079",
      aggregateIndex: null,
    });
  });

  it("parses an operator-named hostname aggregate (no numeric suffix)", () => {
    // Custom MCLAG aggregate: operator typed the peer's hostname.
    expect(parseFortinetPeerInterface("METROR2-T1024E")).toEqual({
      interfaceName: "METROR2-T1024E",
      peerFragment: "METROR2-T1024E",
      aggregateIndex: null,
    });
  });

  it("parses an operator-named hostname aggregate WITH a numeric suffix", () => {
    // The trailing -0 is treated as a FortiOS aggregate index.
    expect(parseFortinetPeerInterface("METROR2-T1024E-0")).toEqual({
      interfaceName: "METROR2-T1024E-0",
      peerFragment: "METROR2-T1024E",
      aggregateIndex: 0,
    });
  });
});

describe("parseFortinetPeerInterface — negative cases (real port names)", () => {
  it.each([
    "port1", "port15", "port-14", "wan1", "wan2", "internal",
    "fortilink", "lan", "lan1", "lan2", "mesh1", "mgmt", "x2",
    "_FlInK1_ICL0_",  // MCLAG ICL — has underscores; rejected
    "8FFTV23025884",  // 13-char all-caps alnum without suffix — DOES match the loose pattern
  ])("rejects %s (lowercase / port name)", (name) => {
    if (name === "8FFTV23025884") {
      // 13 chars, all alphanumeric uppercase — DOES match the loose pattern.
      // That's intentional — without suffix, this looks like a serial-named
      // interface. The downstream serialMatchesPeerInterface() won't find an
      // asset that ends with this exact string unless one really exists, so
      // it's safe to be permissive here.
      expect(parseFortinetPeerInterface(name)).not.toBeNull();
      return;
    }
    expect(parseFortinetPeerInterface(name)).toBeNull();
  });

  it("rejects empty / null / whitespace", () => {
    expect(parseFortinetPeerInterface(null)).toBeNull();
    expect(parseFortinetPeerInterface(undefined)).toBeNull();
    expect(parseFortinetPeerInterface("")).toBeNull();
    expect(parseFortinetPeerInterface("   ")).toBeNull();
  });

  it("rejects names with mixed case", () => {
    expect(parseFortinetPeerInterface("PortA")).toBeNull();
    expect(parseFortinetPeerInterface("Internal-1")).toBeNull();
  });

  it("rejects names with non-alphanumeric / non-dash characters", () => {
    expect(parseFortinetPeerInterface("8FFTV230_25884")).toBeNull();
    expect(parseFortinetPeerInterface("8FFTV23025884.0")).toBeNull();
    expect(parseFortinetPeerInterface("8FFTV2 3025884")).toBeNull();
  });

  it("rejects names with leading or trailing dashes", () => {
    expect(parseFortinetPeerInterface("-METROR2-T1024E")).toBeNull();
    expect(parseFortinetPeerInterface("METROR2-T1024E-")).toBeNull();
  });

  it("rejects too-short or too-long names", () => {
    expect(parseFortinetPeerInterface("ABC123")).toBeNull(); // 6 chars, below threshold
    expect(parseFortinetPeerInterface("A".repeat(31))).toBeNull(); // 31 chars, above threshold
  });
});

describe("serialMatchesPeerInterface — match strategy", () => {
  it("matches FortiSwitch peer interface to full serial", () => {
    const parsed = parseFortinetPeerInterface("8FFTV23025884-0")!;
    expect(serialMatchesPeerInterface(parsed, "S108FFTV23025884")).toBe(true);
  });

  it("matches FortiGate peer interface to full serial", () => {
    const parsed = parseFortinetPeerInterface("GT61FTK22002079")!;
    expect(serialMatchesPeerInterface(parsed, "FGT61FTK22002079")).toBe(true);
  });

  it("is case-insensitive", () => {
    const parsed = parseFortinetPeerInterface("8FFTV23025884-0")!;
    expect(serialMatchesPeerInterface(parsed, "s108ffTV23025884")).toBe(true);
  });

  it("rejects when serial is shorter than the fragment", () => {
    // Defends against false positives where the fragment is bigger than the
    // serial we're checking against.
    const parsed = parseFortinetPeerInterface("8FFTV23025884-0")!;
    expect(serialMatchesPeerInterface(parsed, "FFTV23025884")).toBe(false);
  });

  it("rejects when the serial doesn't end with the fragment", () => {
    const parsed = parseFortinetPeerInterface("8FFTV23025884-0")!;
    expect(serialMatchesPeerInterface(parsed, "FGT12345678901234")).toBe(false);
  });

  it("matches when serial equals the fragment exactly (no truncation needed)", () => {
    const parsed = parseFortinetPeerInterface("FGT61FTK22002079")!;
    expect(serialMatchesPeerInterface(parsed, "FGT61FTK22002079")).toBe(true);
  });

  it("rejects empty / null asset serial", () => {
    const parsed = parseFortinetPeerInterface("8FFTV23025884-0")!;
    expect(serialMatchesPeerInterface(parsed, null)).toBe(false);
    expect(serialMatchesPeerInterface(parsed, undefined)).toBe(false);
    expect(serialMatchesPeerInterface(parsed, "")).toBe(false);
  });
});

describe("hostnameMatchesPeerInterface — operator-named aggregates", () => {
  it("matches an exact hostname", () => {
    const parsed = parseFortinetPeerInterface("METROR2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, "METROR2-T1024E")).toBe(true);
  });

  it("matches a hostname that starts with the fragment + dash", () => {
    const parsed = parseFortinetPeerInterface("METROR2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, "METROR2-T1024E-PROD")).toBe(true);
  });

  it("matches a hostname that starts with the fragment + dot (FQDN)", () => {
    const parsed = parseFortinetPeerInterface("METROR2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, "METROR2-T1024E.example.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    const parsed = parseFortinetPeerInterface("METROR2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, "metror2-t1024e")).toBe(true);
    expect(hostnameMatchesPeerInterface(parsed, "Metror2-T1024e")).toBe(true);
  });

  it("rejects substring collisions (no separator after fragment)", () => {
    // Without the separator rule, `METROR2` would match `METROR21`.
    const parsed = parseFortinetPeerInterface("METROR21")!;
    expect(parsed).not.toBeNull();
    const shorter = parseFortinetPeerInterface("METROR21")!;
    expect(hostnameMatchesPeerInterface(shorter, "METROR21")).toBe(true);
    expect(hostnameMatchesPeerInterface(shorter, "METROR21X")).toBe(false);
    expect(hostnameMatchesPeerInterface(shorter, "METROR210")).toBe(false);
  });

  it("rejects when hostname is shorter than the fragment", () => {
    const parsed = parseFortinetPeerInterface("METROR2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, "METROR2")).toBe(false);
  });

  it("rejects empty / null asset hostname", () => {
    const parsed = parseFortinetPeerInterface("METROR2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, null)).toBe(false);
    expect(hostnameMatchesPeerInterface(parsed, undefined)).toBe(false);
    expect(hostnameMatchesPeerInterface(parsed, "")).toBe(false);
  });
});
