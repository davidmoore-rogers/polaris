/**
 * tests/unit/fortinetManagementAccess.test.ts
 *
 * Pure-parser coverage for the management-access (allowaccess) reader. These
 * functions must never throw on malformed/missing FortiOS payloads — they
 * degrade to empty lists / null summaries.
 */

import { describe, it, expect } from "vitest";
import {
  parseAllowaccess,
  protocolFlags,
  findInterfaceRow,
  buildFirewallSummary,
  parseWtpProfiles,
  parseWtpToProfile,
  buildApSummary,
  buildSwitchSummary,
  parseLocalAccessPolicies,
  localAccessHalfFor,
  pickLocalAccessPolicy,
  shapeManagementAccessForClient,
} from "../../src/services/fortinetManagementAccessService.js";

const TS = "2026-06-19T00:00:00.000Z";

describe("parseAllowaccess", () => {
  it("splits a space-separated string and lowercases", () => {
    expect(parseAllowaccess("PING HTTPS SSH snmp")).toEqual(["ping", "https", "ssh", "snmp"]);
  });
  it("handles an array of strings", () => {
    expect(parseAllowaccess(["https", "ssh"])).toEqual(["https", "ssh"]);
  });
  it("handles FortiOS array-of-objects (q_origin_key / name)", () => {
    expect(parseAllowaccess([{ q_origin_key: "https" }, { name: "ssh" }])).toEqual(["https", "ssh"]);
  });
  it("dedupes while preserving order", () => {
    expect(parseAllowaccess("https https ssh")).toEqual(["https", "ssh"]);
  });
  it("returns [] for null/undefined/number/garbage", () => {
    expect(parseAllowaccess(null)).toEqual([]);
    expect(parseAllowaccess(undefined)).toEqual([]);
    expect(parseAllowaccess(42 as unknown)).toEqual([]);
    expect(parseAllowaccess({} as unknown)).toEqual([]);
  });
});

describe("protocolFlags", () => {
  it("maps presence to booleans", () => {
    expect(protocolFlags(["https", "snmp"])).toEqual({ https: true, ssh: false, snmp: true });
  });
  it("null protocols → all false (unknown)", () => {
    expect(protocolFlags(null)).toEqual({ https: false, ssh: false, snmp: false });
  });
});

describe("findInterfaceRow", () => {
  const cmdb = { results: [{ name: "mgmt", ip: "10.0.0.1 255.255.255.0", allowaccess: "https ssh" }, { name: "port1" }] };
  it("matches case-insensitively inside a results wrapper", () => {
    expect(findInterfaceRow(cmdb, "MGMT")?.name).toBe("mgmt");
  });
  it("returns null for a missing or blank name", () => {
    expect(findInterfaceRow(cmdb, "wan1")).toBeNull();
    expect(findInterfaceRow(cmdb, "")).toBeNull();
    expect(findInterfaceRow(cmdb, null)).toBeNull();
  });
});

describe("buildFirewallSummary", () => {
  const cmdb = [{ name: "mgmt", ip: "10.0.0.1 255.255.255.0", allowaccess: "ping https ssh" }];
  it("reads the named interface's allowaccess + ip", () => {
    const s = buildFirewallSummary(cmdb, "mgmt", "1.2.3.4", TS)!;
    expect(s.source).toBe("firewall-interface");
    expect(s.interfaceName).toBe("mgmt");
    expect(s.mgmtIp).toBe("10.0.0.1");
    expect(s.https).toBe(true);
    expect(s.ssh).toBe(true);
    expect(s.snmp).toBe(false);
    expect(s.protocols).toEqual(["ping", "https", "ssh"]);
  });
  it("falls back to the supplied mgmtIp when the interface has no usable ip", () => {
    const s = buildFirewallSummary([{ name: "mgmt", ip: "0.0.0.0 0.0.0.0", allowaccess: "https" }], "mgmt", "9.9.9.9", TS)!;
    expect(s.mgmtIp).toBe("9.9.9.9");
  });
  it("returns null when the named interface is absent", () => {
    expect(buildFirewallSummary(cmdb, "doesnotexist", "1.2.3.4", TS)).toBeNull();
  });
});

describe("AP profile join", () => {
  const profiles = parseWtpProfiles([
    { name: "branch-aps", allowaccess: "https ssh" },
    { name: "lobby-aps", allowaccess: "" },
  ]);
  const wtpToProfile = parseWtpToProfile([
    { serial: "FP231KABC", "wtp-profile": "branch-aps" },
    { "wtp-id": "FP231KDEF", "wtp-profile": "lobby-aps" },
  ]);

  it("resolves an AP serial → profile → allowaccess", () => {
    const s = buildApSummary("FP231KABC", "10.1.1.5", wtpToProfile, profiles, TS)!;
    expect(s.source).toBe("fortiap-profile");
    expect(s.profileName).toBe("branch-aps");
    expect(s.https).toBe(true);
    expect(s.ssh).toBe(true);
    expect(s.snmp).toBe(false);
    expect(s.mgmtIp).toBe("10.1.1.5");
  });
  it("resolves via wtp-id when serial field is absent, empty allowaccess → all false", () => {
    const s = buildApSummary("fp231kdef", null, wtpToProfile, profiles, TS)!;
    expect(s.profileName).toBe("lobby-aps");
    expect(s.https).toBe(false);
    expect(s.snmp).toBe(false);
    expect(s.protocols).toEqual([]);
  });
  it("returns null when the AP isn't mapped to a profile", () => {
    expect(buildApSummary("UNKNOWN", null, wtpToProfile, profiles, TS)).toBeNull();
  });
});

describe("buildSwitchSummary", () => {
  it("yields unknown (protocols null) when the row has no interface allowaccess", () => {
    const s = buildSwitchSummary({ "switch-id": "S248ABC" }, "internal", "10.2.2.2", TS);
    expect(s.source).toBe("fortiswitch");
    expect(s.protocols).toBeNull();
    expect(s.https).toBe(false);
    expect(s.mgmtIp).toBe("10.2.2.2");
    expect(s.interfaceName).toBe("internal");
  });
  it("reads allowaccess when the firmware exposes a switch-interface array", () => {
    const row = { "switch-id": "S248ABC", "switch-interface": [{ name: "internal", allowaccess: "https ping" }] };
    const s = buildSwitchSummary(row, "internal", null, TS);
    expect(s.protocols).toEqual(["https", "ping"]);
    expect(s.https).toBe(true);
    expect(s.ssh).toBe(false);
  });
  it("null row → unknown", () => {
    expect(buildSwitchSummary(null, "internal", null, TS).protocols).toBeNull();
  });
});

describe("parseLocalAccessPolicies", () => {
  // The operator's own config, as FortiOS returns it over REST.
  const RES = {
    results: [
      { name: "default", "mgmt-allowaccess": "https ping ssh snmp", "internal-allowaccess": "https ping ssh snmp" },
      { name: "Locked", "mgmt-allowaccess": "ping", "internal-allowaccess": "ping snmp" },
    ],
  };
  it("keys by lowercased name and normalizes both halves", () => {
    const m = parseLocalAccessPolicies(RES);
    expect([...m.keys()]).toEqual(["default", "locked"]);
    expect(m.get("default")!.internal).toEqual(["https", "ping", "ssh", "snmp"]);
    expect(m.get("locked")!.mgmt).toEqual(["ping"]);
    // The display name keeps its original casing.
    expect(m.get("locked")!.name).toBe("Locked");
  });
  it("accepts a bare array and the underscore field spelling", () => {
    const m = parseLocalAccessPolicies([{ name: "d", mgmt_allowaccess: "ssh", internal_allowaccess: ["https"] }]);
    expect(m.get("d")!.mgmt).toEqual(["ssh"]);
    expect(m.get("d")!.internal).toEqual(["https"]);
  });
  it("leaves an unstated half NULL rather than an empty allowaccess", () => {
    // [] would read as "no protocol permitted" — a positive claim the payload
    // never made, and one that would hide both verbs on the asset page.
    const m = parseLocalAccessPolicies([{ name: "d", "internal-allowaccess": "https" }]);
    expect(m.get("d")!.mgmt).toBeNull();
    expect(m.get("d")!.internal).toEqual(["https"]);
  });
  it("skips unnamed / malformed rows and never throws", () => {
    expect(parseLocalAccessPolicies(null).size).toBe(0);
    expect(parseLocalAccessPolicies({ results: [null, 7, { name: "  " }] }).size).toBe(0);
  });
});

describe("localAccessHalfFor", () => {
  it("reads the mgmt half only for the dedicated MGMT port", () => {
    expect(localAccessHalfFor("mgmt")).toBe("mgmt");
    expect(localAccessHalfFor("MGMT1")).toBe("mgmt");
  });
  it("treats internal and any operator-named SVI as in-band", () => {
    expect(localAccessHalfFor("internal")).toBe("internal");
    expect(localAccessHalfFor("fortilink-mgmt-svi")).toBe("internal");
    expect(localAccessHalfFor("")).toBe("internal");
  });
});

describe("pickLocalAccessPolicy", () => {
  const policies = parseLocalAccessPolicies([
    { name: "default", "internal-allowaccess": "https ssh" },
    { name: "Locked", "internal-allowaccess": "ping" },
  ]);
  it("falls back to the default policy when the switch names none", () => {
    expect(pickLocalAccessPolicy(policies, { "switch-id": "S1" })!.name).toBe("default");
  });
  it("honors an assignment on any key that mentions local-access", () => {
    // The exact FortiOS field name is unverified, so the match is on the key's
    // shape rather than a guessed literal.
    expect(pickLocalAccessPolicy(policies, { "local-access-policy": "Locked" })!.name).toBe("Locked");
    expect(pickLocalAccessPolicy(policies, { "security-policy-local-access": { name: "Locked" } })!.name).toBe("Locked");
  });
  it("ignores an assignment naming a policy that doesn't exist", () => {
    expect(pickLocalAccessPolicy(policies, { "local-access-policy": "Ghost" })!.name).toBe("default");
  });
  it("uses the only policy when it isn't called default", () => {
    const one = parseLocalAccessPolicies([{ name: "RGI-Switches", "internal-allowaccess": "ssh" }]);
    expect(pickLocalAccessPolicy(one, {})!.name).toBe("RGI-Switches");
  });
  it("returns null with no policies at all", () => {
    expect(pickLocalAccessPolicy(new Map(), {})).toBeNull();
    expect(pickLocalAccessPolicy(null, {})).toBeNull();
  });
});

describe("buildSwitchSummary + local-access policy", () => {
  const policies = parseLocalAccessPolicies([
    { name: "default", "mgmt-allowaccess": "https ping ssh snmp", "internal-allowaccess": "https ping snmp" },
  ]);
  it("reads the internal half for a FortiLink-managed switch", () => {
    const s = buildSwitchSummary({ "switch-id": "S1" }, "internal", "10.2.2.2", TS, policies);
    expect(s.protocols).toEqual(["https", "ping", "snmp"]);
    expect(s.https).toBe(true);
    // SSH is permitted on the out-of-band port only — the verb must not show.
    expect(s.ssh).toBe(false);
    expect(s.profileName).toBe("default");
  });
  it("reads the mgmt half when the operator polls the MGMT port", () => {
    const s = buildSwitchSummary({ "switch-id": "S1" }, "mgmt", null, TS, policies);
    expect(s.ssh).toBe(true);
    expect(s.interfaceName).toBe("mgmt");
  });
  it("a per-switch interface allowaccess still wins over the policy", () => {
    const row = { "switch-id": "S1", "switch-interface": [{ name: "internal", allowaccess: "ssh" }] };
    const s = buildSwitchSummary(row, "internal", null, TS, policies);
    expect(s.protocols).toEqual(["ssh"]);
    // The device spoke for itself, so no policy is credited.
    expect(s.profileName).toBeNull();
  });
  it("stays unknown when the policy read failed", () => {
    const s = buildSwitchSummary({ "switch-id": "S1" }, "internal", null, TS, new Map());
    expect(s.protocols).toBeNull();
    expect(s.profileName).toBeNull();
  });
  it("stays unknown when the policy states no list for the half in use", () => {
    const half = parseLocalAccessPolicies([{ name: "default", "mgmt-allowaccess": "https" }]);
    expect(buildSwitchSummary({}, "internal", null, TS, half).protocols).toBeNull();
  });
});

describe("shapeManagementAccessForClient", () => {
  it("keeps protocols null so the client stays optimistic", () => {
    const out = shapeManagementAccessForClient({ mgmtIp: "10.0.0.1", protocols: null, https: false, ssh: false });
    expect(out).toEqual({ mgmtIp: "10.0.0.1", protocols: null, https: false, ssh: false });
  });
  it("drops the fields only the slide-over reads", () => {
    const out = shapeManagementAccessForClient({
      source: "fortiswitch", interfaceName: "internal", profileName: "default", snmp: true,
      checkedAt: TS, mgmtIp: "10.0.0.2", protocols: ["https"], https: true, ssh: false,
    });
    expect(out).toEqual({ mgmtIp: "10.0.0.2", protocols: ["https"], https: true, ssh: false });
  });
  it("null for a missing / non-object blob", () => {
    expect(shapeManagementAccessForClient(null)).toBeNull();
    expect(shapeManagementAccessForClient("nope")).toBeNull();
  });
});
