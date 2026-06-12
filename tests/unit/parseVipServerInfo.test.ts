import { describe, it, expect } from "vitest";
import { parseVipServerInfo } from "../../src/services/fortimanagerService.js";

// parseVipServerInfo() classifies a raw firewall/vip row as a load-balance
// Virtual Server and extracts its realserver pool IPs. Shared by the FMG
// proxy path and the standalone FortiGate REST path. The function is pure —
// no DB, no network.

describe("parseVipServerInfo", () => {
  it("plain static-nat VIP — not a virtual server, empty pool", () => {
    const r = parseVipServerInfo({
      name: "web-dnat",
      type: "static-nat",
      extip: "203.0.113.10",
      mappedip: [{ range: "10.1.1.10" }],
    });
    expect(r.isVirtualServer).toBe(false);
    expect(r.realservers).toEqual([]);
  });

  it("server-load-balance VIP — string type + realserver pool", () => {
    const r = parseVipServerInfo({
      name: "lb-web",
      type: "server-load-balance",
      extip: "203.0.113.20",
      realservers: [
        { id: 1, ip: "10.1.2.11", port: 443 },
        { id: 2, ip: "10.1.2.12", port: 443 },
      ],
    });
    expect(r.isVirtualServer).toBe(true);
    expect(r.realservers).toEqual(["10.1.2.11", "10.1.2.12"]);
  });

  it("structural detection — non-empty pool wins even when FMG returns a numeric type enum", () => {
    const r = parseVipServerInfo({
      name: "lb-app",
      type: 2,
      realservers: [{ id: 1, ip: "10.1.3.5", port: 8080 }],
    });
    expect(r.isVirtualServer).toBe(true);
    expect(r.realservers).toEqual(["10.1.3.5"]);
  });

  it("empty-pool virtual server — string type alone still classifies", () => {
    const r = parseVipServerInfo({ name: "lb-new", type: "server-load-balance", realservers: [] });
    expect(r.isVirtualServer).toBe(true);
    expect(r.realservers).toEqual([]);
  });

  it("dedupes pool members sharing one IP on different ports", () => {
    const r = parseVipServerInfo({
      name: "lb-multi",
      type: "server-load-balance",
      realservers: [
        { id: 1, ip: "10.1.4.7", port: 80 },
        { id: 2, ip: "10.1.4.7", port: 443 },
      ],
    });
    expect(r.realservers).toEqual(["10.1.4.7"]);
  });

  it("skips address-type members (0.0.0.0) and unparseable IPs", () => {
    const r = parseVipServerInfo({
      name: "lb-mixed",
      type: "server-load-balance",
      realservers: [
        { id: 1, ip: "0.0.0.0", address: "srv-addr-obj" },
        { id: 2, ip: "not-an-ip" },
        { id: 3, ip: "10.1.5.9" },
      ],
    });
    expect(r.isVirtualServer).toBe(true);
    expect(r.realservers).toEqual(["10.1.5.9"]);
  });

  it("tolerates FMG array-wrapped ip fields", () => {
    const r = parseVipServerInfo({
      name: "lb-fmg",
      type: "server-load-balance",
      realservers: [{ id: 1, ip: ["10.1.6.3"], port: 22 }],
    });
    expect(r.realservers).toEqual(["10.1.6.3"]);
  });

  it("tolerates missing / malformed realservers field", () => {
    expect(parseVipServerInfo({ name: "x", type: "static-nat" }).realservers).toEqual([]);
    expect(parseVipServerInfo({ name: "x", realservers: "bogus" }).isVirtualServer).toBe(false);
    expect(parseVipServerInfo({}).isVirtualServer).toBe(false);
  });

  // Shapes observed live against FMG 7.x /pm/config fields-projected get
  // (2026-06-12): type is a numeric enum (0 = static-nat, 3 =
  // server-load-balance), realservers is null on non-VS rows, member ip is
  // a plain string, member status/healthcheck are numeric.
  it("FMG pm/config static-nat row — numeric type 0 + null realservers", () => {
    const r = parseVipServerInfo({ name: "Syntech FMLive", type: 0, realservers: null, extip: ["68.75.2.203"], mappedip: ["172.23.19.130"] });
    expect(r.isVirtualServer).toBe(false);
    expect(r.realservers).toEqual([]);
  });

  it("FMG pm/config server-load-balance row — numeric type 3, pool classifies structurally", () => {
    const r = parseVipServerInfo({
      name: "Axis ACS Pro 443",
      type: 3,
      extip: ["68.75.2.202"],
      mappedip: [],
      realservers: [{ id: 1, ip: "172.23.19.64", port: 443, status: 0, healthcheck: 3, weight: 1 }],
    });
    expect(r.isVirtualServer).toBe(true);
    expect(r.realservers).toEqual(["172.23.19.64"]);
  });
});
