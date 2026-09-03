/**
 * tests/unit/assetTypeMatch.test.ts
 *
 * The device-type inference layer.
 *
 * The load-bearing block is "shipped defaults reproduce the retired
 * predicates": the rules that ship replaced two hardcoded functions
 * (`inferAssetTypeFromOs` in discoveryEngine, `assetTypeForHit` in
 * networkScanService), and every existing install inherits them through a seed
 * migration. If the transcription drifts, a fleet silently re-types on its next
 * discovery run with nothing in the UI to explain it — so the old ladders are
 * reimplemented here as oracles and the resolver is held against them.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_TYPE_MATCHING,
  MATCH_CONTEXTS,
  clauseMatches,
  explainAssetType,
  normalizeMatchRules,
  orderTypes,
  resolveAssetType,
  resolveAssetTypeCached,
  resetAssetTypeMatchRegistry,
  setAssetTypeMatchRegistry,
  getAssetTypeMatchRegistry,
  validateMatchContexts,
  validateMatchRules,
  type MatchableType,
  type MatchContext,
} from "../../src/utils/assetTypeMatch.js";

/** The shipped registry, shaped for the resolver. */
function defaultTypes(): MatchableType[] {
  return Object.entries(DEFAULT_TYPE_MATCHING).map(([name, m]) => ({
    name,
    matchRules: m.rules,
    matchContexts: m.contexts,
    matchPriority: m.priority,
  }));
}

// ─── The retired predicates, verbatim, as oracles ──────────────────────────

function legacyInferAssetTypeFromOs(os: string | null | undefined): "workstation" | "server" | "other" {
  if (!os) return "other";
  const lower = os.toLowerCase();
  if (
    lower.includes("server") || lower.includes("centos") || lower.includes("red hat") ||
    lower.includes("rhel") || lower.includes("rocky linux") || lower.includes("almalinux") ||
    lower.includes("oracle linux") || lower.includes("freebsd") || lower.includes("openbsd") ||
    lower.includes("netbsd") || lower.includes("esxi") || lower.includes("vmware")
  ) return "server";
  if (
    /windows\s+(10|11|7|8|xp|vista)/i.test(os) ||
    lower.includes("macos") || lower.includes("mac os x") || lower.includes("os x") ||
    lower.includes("linux mint") || lower.includes("ubuntu") || lower.includes("fedora") ||
    lower.includes("debian") || lower.includes("arch linux") || lower.includes("manjaro") ||
    lower.includes("pop!_os") || lower.includes("elementary os") || lower.includes("zorin os")
  ) return "workstation";
  return "other";
}

function legacyAssetTypeForHit(os: string | null, hostname: string | null): string {
  const text = `${os ?? ""} ${hostname ?? ""}`.toLowerCase();
  if (/\bfortigate\b|\bfirewall\b|\bpalo alto\b|\bsonicwall\b/.test(text)) return "firewall";
  if (/\bfortiswitch\b|\bswitch\b|\bcatalyst\b|\bnexus\b/.test(text)) return "switch";
  if (/\bfortiap\b|access point|\bwlan\b|\bwireless\b/.test(text)) return "access_point";
  if (/\brouter\b|\bios\b.*\brouter\b/.test(text)) return "router";
  if (/\bprinter\b|laserjet|officejet/.test(text)) return "printer";
  return "other";
}

const OS_CORPUS = [
  null, "", "   ",
  "Windows 10 Pro", "Windows 11 Enterprise", "Windows 7", "Windows 8.1", "Windows XP", "Windows Vista",
  "Windows Server 2019 Datacenter", "Windows Server 2022", "Microsoft Windows Server 2016 Standard",
  "Ubuntu 22.04.3 LTS", "Debian GNU/Linux 12", "Fedora Linux 39", "Linux Mint 21", "Arch Linux",
  "Manjaro Linux", "Pop!_OS 22.04", "elementary OS 7", "Zorin OS 16",
  "CentOS Linux 7", "Red Hat Enterprise Linux 9", "RHEL 8.8", "Rocky Linux 9.3", "AlmaLinux 9",
  "Oracle Linux Server 8", "FreeBSD 14.0", "OpenBSD 7.4", "NetBSD 10",
  "VMware ESXi 8.0.3", "VMware Photon OS", "macOS 14.2 Sonoma", "Mac OS X 10.15", "OS X El Capitan",
  "iOS 17.2", "Android 14", "FortiOS 7.4.5", "JUNOS 21.4", "Cisco IOS XE",
  "HP LaserJet Pro", "Zebra Printer", "unknown", "Linux", "Windows",
];

const SCAN_CORPUS: { os: string | null; hostname: string | null }[] = [
  { os: null, hostname: null },
  { os: "FortiGate-100F", hostname: "fw-hq-01" },
  { os: "", hostname: "core-switch-3" },
  { os: "FortiSwitch 248E", hostname: null },
  { os: "FortiAP 431F", hostname: "ap-floor2" },
  { os: "Cisco Catalyst 9300", hostname: "cat9300" },
  { os: "Cisco Nexus 9000", hostname: null },
  { os: "Palo Alto PA-820", hostname: null },
  { os: "SonicWall TZ470", hostname: null },
  { os: "Cisco IOS Router 2911", hostname: "rtr-branch" },
  { os: "HP LaserJet MFP M428", hostname: "prn-acct" },
  { os: "Brother Printer", hostname: null },
  { os: "Canon OfficeJet", hostname: null },
  { os: "Aruba wireless controller", hostname: null },
  { os: null, hostname: "wlan-ctrl-1" },
  { os: "Generic Access Point", hostname: null },
  { os: "Eaton PDU", hostname: "pdu-rack4" },
  { os: "Axis Network Camera", hostname: "cam-lobby" },
  { os: "Ubuntu 22.04", hostname: "srv-app-1" },
  { os: "Windows Server 2019", hostname: "dc-01" },
];

describe("shipped defaults reproduce the retired predicates", () => {
  const types = defaultTypes();

  it("matches inferAssetTypeFromOs on the directory context, across the OS corpus", () => {
    for (const os of OS_CORPUS) {
      const got = resolveAssetType(types, { os }, "directory") ?? "other";
      expect(got, `OS ${JSON.stringify(os)}`).toBe(legacyInferAssetTypeFromOs(os));
    }
  });

  it("matches assetTypeForHit on the scan context, across the scan corpus", () => {
    for (const hit of SCAN_CORPUS) {
      const got = resolveAssetType(types, { os: hit.os, hostname: hit.hostname }, "scan") ?? "other";
      expect(got, `hit ${JSON.stringify(hit)}`).toBe(legacyAssetTypeForHit(hit.os, hit.hostname));
    }
  });

  it("keeps server ahead of workstation, so a Windows Server is not an endpoint", () => {
    // The old ladder tested server FIRST. Priority is what preserves that:
    // "Windows Server 2019" also satisfies workstation's windows regex only if
    // it were reached, which it must not be.
    expect(resolveAssetType(types, { os: "Windows Server 2019" }, "directory")).toBe("server");
    const ordered = orderTypes(types).map((t) => t.name);
    expect(ordered.indexOf("server")).toBeLessThan(ordered.indexOf("workstation"));
  });

  it("keeps the two contexts disjoint, so an OS string never yields an infra type", () => {
    // The bug this guards: collapsing the rule sets would type an AD computer
    // named "PRINTER-01" as a printer off the directory path.
    expect(resolveAssetType(types, { os: "HP LaserJet Pro" }, "directory")).toBeNull();
    expect(resolveAssetType(types, { os: "Windows 11", hostname: "switch-room-pc" }, "directory"))
      .toBe("workstation");
    // ...and conversely a scanned Ubuntu box is not a "server" on the scan path.
    expect(resolveAssetType(types, { os: "Ubuntu 22.04" }, "scan")).toBeNull();
  });

  it("ships every default with rules that pass validation", () => {
    for (const [name, m] of Object.entries(DEFAULT_TYPE_MATCHING)) {
      expect(validateMatchRules(m.rules), name).toBeNull();
      expect(validateMatchContexts(m.contexts), name).toBeNull();
    }
  });

  it("ships no rules for the types only an authoritative source assigns", () => {
    for (const name of ["other", "hypervisor", "kubernetes_cluster"]) {
      expect(DEFAULT_TYPE_MATCHING[name]).toBeUndefined();
    }
  });
});

describe("the process cache", () => {
  beforeEach(() => resetAssetTypeMatchRegistry());

  it("falls back to the shipped rules before it has ever been loaded", () => {
    // The bug this guards: `seedAssetTypes` runs only where `runsMigrations`
    // is true, so in the split-role layout the DISCOVERY process — the one
    // that types devices — reaches the resolver with a cold cache. Answering
    // "nothing matches" there would file an entire run under Other and look
    // exactly like a fleet of unrecognized devices.
    expect(resolveAssetTypeCached({ os: "Windows Server 2019" }, "directory")).toBe("server");
    expect(resolveAssetTypeCached({ os: "FortiGate-60F" }, "scan")).toBe("firewall");
  });

  it("distinguishes never-loaded from loaded-and-empty", () => {
    // An operator clearing every rule is a real answer and must be honoured;
    // only the cold cache falls back.
    setAssetTypeMatchRegistry([]);
    expect(resolveAssetTypeCached({ os: "Windows Server 2019" }, "directory")).toBeNull();
    resetAssetTypeMatchRegistry();
    expect(resolveAssetTypeCached({ os: "Windows Server 2019" }, "directory")).toBe("server");
  });

  it("serves what was loaded, in resolver order", () => {
    setAssetTypeMatchRegistry([
      { name: "b", matchPriority: 9, matchContexts: ["scan"], matchRules: { clauses: [{ field: "any", op: "contains", value: "x" }] } },
      { name: "a", matchPriority: 1, matchContexts: ["scan"], matchRules: { clauses: [{ field: "any", op: "contains", value: "x" }] } },
    ]);
    expect(getAssetTypeMatchRegistry().map((t) => t.name)).toEqual(["a", "b"]);
    expect(resolveAssetTypeCached({ os: "x" }, "scan")).toBe("a");
  });
});

describe("clause evaluation", () => {
  const facts = { os: "Ubuntu 22.04 LTS", hostname: "srv-app-01", manufacturer: "Dell Inc." };

  it("is case-insensitive on every operator", () => {
    expect(clauseMatches({ field: "os", op: "contains", value: "UBUNTU" }, facts)).toBe(true);
    expect(clauseMatches({ field: "manufacturer", op: "equals", value: "dell inc." }, facts)).toBe(true);
    expect(clauseMatches({ field: "hostname", op: "starts_with", value: "SRV-" }, facts)).toBe(true);
    expect(clauseMatches({ field: "hostname", op: "ends_with", value: "-01" }, facts)).toBe(true);
    expect(clauseMatches({ field: "os", op: "regex", value: "^ubuntu" }, facts)).toBe(true);
  });

  it("reads `any` as the space-joined facts", () => {
    expect(clauseMatches({ field: "any", op: "contains", value: "srv-app" }, facts)).toBe(true);
    expect(clauseMatches({ field: "any", op: "contains", value: "dell" }, facts)).toBe(true);
  });

  it("never matches an absent fact — negated or not", () => {
    // The invariant: at discovery time a missing field means "not yet known",
    // so letting absence satisfy a negation would let one field outage
    // re-type a fleet.
    const empty = { os: null, hostname: "  " };
    expect(clauseMatches({ field: "os", op: "contains", value: "x" }, empty)).toBe(false);
    expect(clauseMatches({ field: "os", op: "contains", value: "x", negate: true }, empty)).toBe(false);
    expect(clauseMatches({ field: "hostname", op: "contains", value: "x", negate: true }, empty)).toBe(false);
    expect(clauseMatches({ field: "any", op: "contains", value: "x" }, { os: null })).toBe(false);
  });

  it("negates a present fact", () => {
    expect(clauseMatches({ field: "os", op: "contains", value: "windows", negate: true }, facts)).toBe(true);
    expect(clauseMatches({ field: "os", op: "contains", value: "ubuntu", negate: true }, facts)).toBe(false);
  });

  it("treats an uncompilable stored regex as no-match rather than throwing", () => {
    // Write-time validation refuses these, but a hand-edited row or a restored
    // backup can still carry one, and it must not throw into the discovery loop.
    expect(() => clauseMatches({ field: "os", op: "regex", value: "([unclosed" }, facts)).not.toThrow();
    expect(clauseMatches({ field: "os", op: "regex", value: "([unclosed" }, facts)).toBe(false);
  });
});

describe("resolution", () => {
  const types: MatchableType[] = [
    { name: "pdu", matchPriority: 5, matchContexts: ["directory", "scan"], matchRules: { clauses: [{ field: "any", op: "contains", value: "eaton" }] } },
    { name: "camera", matchPriority: 5, matchContexts: ["scan"], matchRules: { clauses: [{ field: "any", op: "contains", value: "axis" }] } },
    { name: "server", matchPriority: 20, matchContexts: ["directory"], matchRules: { clauses: [{ field: "os", op: "contains", value: "server" }] } },
    { name: "unruled", matchPriority: 1, matchContexts: ["directory"], matchRules: null },
    { name: "outofcontext", matchPriority: 1, matchContexts: [], matchRules: { clauses: [{ field: "any", op: "contains", value: "eaton" }] } },
  ];

  it("returns null when nothing claims the device, leaving the default to the caller", () => {
    expect(resolveAssetType(types, { os: "TempleOS" }, "directory")).toBeNull();
  });

  it("honours priority, then name, deterministically", () => {
    const tied: MatchableType[] = [
      { name: "zebra", matchPriority: 10, matchContexts: ["scan"], matchRules: { clauses: [{ field: "any", op: "contains", value: "x" }] } },
      { name: "alpha", matchPriority: 10, matchContexts: ["scan"], matchRules: { clauses: [{ field: "any", op: "contains", value: "x" }] } },
    ];
    expect(resolveAssetType(tied, { os: "x" }, "scan")).toBe("alpha");
    expect(resolveAssetType([...tied].reverse(), { os: "x" }, "scan")).toBe("alpha");
  });

  it("skips a type whose contexts exclude this one", () => {
    expect(resolveAssetType(types, { os: "Axis camera" }, "directory")).toBeNull();
    expect(resolveAssetType(types, { os: "Axis camera" }, "scan")).toBe("camera");
  });

  it("skips a type with no rules at all, however high its priority", () => {
    expect(resolveAssetType(types, { os: "Windows Server 2019" }, "directory")).toBe("server");
  });

  it("skips a type declaring no contexts", () => {
    expect(resolveAssetType(
      types.filter((t) => t.name === "outofcontext"),
      { os: "Eaton PDU" },
      "directory",
    )).toBeNull();
  });

  it("explains which clause decided, agreeing with the resolver", () => {
    const { type, clause } = explainAssetType(types, { os: "Eaton ePDU G3" }, "scan");
    expect(type).toBe("pdu");
    expect(clause).toEqual({ field: "any", op: "contains", value: "eaton" });
    expect(type).toBe(resolveAssetType(types, { os: "Eaton ePDU G3" }, "scan"));
  });
});

describe("validation", () => {
  it("accepts null / absent rules", () => {
    expect(validateMatchRules(null)).toBeNull();
    expect(validateMatchRules(undefined)).toBeNull();
  });

  it("refuses an uncompilable regex at write time", () => {
    // The whole point of write-time validation: the resolver runs per device
    // per discovery run, so one typo must not be able to reach it.
    const err = validateMatchRules({ clauses: [{ field: "os", op: "regex", value: "([unclosed" }] });
    expect(err).toMatch(/Invalid regular expression/);
  });

  it("names the offending clause", () => {
    const err = validateMatchRules({
      clauses: [
        { field: "os", op: "contains", value: "ok" },
        { field: "nope", op: "contains", value: "x" },
      ],
    });
    expect(err).toMatch(/Clause 2/);
  });

  it("refuses unknown fields, operators, empty values and bad contexts", () => {
    expect(validateMatchRules({ clauses: [{ field: "serial", op: "contains", value: "x" }] })).toMatch(/field/);
    expect(validateMatchRules({ clauses: [{ field: "os", op: "matches", value: "x" }] })).toMatch(/operator/);
    expect(validateMatchRules({ clauses: [{ field: "os", op: "contains", value: "  " }] })).toMatch(/value is required/);
    expect(validateMatchRules({ clauses: [{ field: "os", op: "contains", value: "x".repeat(201) }] })).toMatch(/longer than/);
    expect(validateMatchRules({ notClauses: [] })).toMatch(/clauses/);
    expect(validateMatchContexts(["directory", "nope"])).toMatch(/Unknown match context/);
    expect(validateMatchContexts([...MATCH_CONTEXTS] as MatchContext[])).toBeNull();
  });

  it("normalizes an unusable blob to null rather than throwing", () => {
    expect(normalizeMatchRules({ clauses: [{ field: "bogus", op: "contains", value: "x" }] })).toBeNull();
    expect(normalizeMatchRules({ clauses: [] })).toBeNull();
    expect(normalizeMatchRules(null)).toBeNull();
    expect(normalizeMatchRules("not an object")).toBeNull();
  });

  it("drops a falsy negate rather than storing it", () => {
    const out = normalizeMatchRules({ clauses: [{ field: "os", op: "contains", value: "x", negate: false }] });
    expect(out?.clauses[0]).toEqual({ field: "os", op: "contains", value: "x" });
  });
});
