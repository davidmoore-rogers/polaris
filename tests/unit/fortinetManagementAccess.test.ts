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
