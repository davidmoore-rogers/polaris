import { describe, it, expect } from "vitest";
import {
  computeFirmwareChange,
  buildFirmwareChangedEvent,
  buildConnectionChangedEvent,
  buildFirewallChangedEvent,
} from "../../src/services/eventLogService.js";

// The pure half of the per-asset change events (firmware / switch port /
// wireless AP / gateway FortiGate). These builders decide WHETHER a write is a
// reportable change, so their silences are the load-bearing part: a discovery
// cycle restates most of these values verbatim every pass, and anything that
// emits on a restatement floods the 7-day Event table at 2000 assets.

const CTX = { assetId: "a1", assetName: "wks-042" };

describe("computeFirmwareChange", () => {
  it("returns undefined when the staged firmware matches", () => {
    expect(
      computeFirmwareChange(
        { os: "Windows 11 Pro", osVersion: "23H2 (10.0.22631.7219)" },
        { os: "Windows 11 Pro", osVersion: "23H2 (10.0.22631.7219)" },
      ),
    ).toBeUndefined();
  });

  it("reports an osVersion bump", () => {
    const changes = computeFirmwareChange({ osVersion: "7.4.5" }, { osVersion: "7.4.8" });
    expect(changes).toEqual({ osVersion: { from: "7.4.5", to: "7.4.8" } });
  });

  it("reports an os-only change", () => {
    const changes = computeFirmwareChange(
      { os: "Windows 10 Pro", osVersion: "10.0.22631" },
      { os: "Windows 11 Pro", osVersion: "10.0.22631" },
    );
    expect(changes).toEqual({ os: { from: "Windows 10 Pro", to: "Windows 11 Pro" } });
  });

  it("ignores fields the caller did not stage", () => {
    // Discovery writes a field only when it has an opinion; an absent key is
    // "no comment", not "cleared".
    expect(computeFirmwareChange({ os: "Linux", osVersion: "5.4" }, { hostname: "x" })).toBeUndefined();
  });

  it("does NOT report a first learn (null → value)", () => {
    // Polaris learning what the device runs is identification, already covered
    // by asset.discovered / asset.discovery_updated — not an upgrade.
    expect(computeFirmwareChange({ osVersion: null }, { osVersion: "7.4.8" })).toBeUndefined();
    expect(computeFirmwareChange({}, { osVersion: "7.4.8" })).toBeUndefined();
  });

  it("does NOT report a source going quiet (value → null)", () => {
    expect(computeFirmwareChange({ osVersion: "7.4.8" }, { osVersion: null })).toBeUndefined();
  });
});

describe("buildFirmwareChangedEvent", () => {
  it("shapes an asset-scoped row the Events tab can find", () => {
    const ev = buildFirmwareChangedEvent(
      { ...CTX, actor: "system:agent", source: "polaris-agent" },
      { osVersion: "7.4.5" },
      { osVersion: "7.4.8" },
    )!;
    expect(ev.action).toBe("asset.firmware.changed");
    // The slide-over Events tab filters strictly on resourceType + resourceId.
    expect(ev.resourceType).toBe("asset");
    expect(ev.resourceId).toBe("a1");
    expect(ev.resourceName).toBe("wks-042");
    expect(ev.actor).toBe("system:agent");
    expect(ev.level).toBe("info");
    // details.changes[field].from/.to is exactly what the Events detail modal
    // renders — the shape is a contract with public/js/events.js.
    expect((ev.details as any).changes).toEqual({ osVersion: { from: "7.4.5", to: "7.4.8" } });
    expect((ev.details as any).source).toBe("polaris-agent");
    expect(ev.message).toContain("7.4.5 → 7.4.8");
  });

  it("names both halves when the OS family moved too", () => {
    const ev = buildFirmwareChangedEvent(
      CTX,
      { os: "Windows 10 Pro", osVersion: "10.0.22000" },
      { os: "Windows 11 Pro", osVersion: "10.0.22631" },
    )!;
    expect(ev.message).toContain("firmware changed: 10.0.22000 → 10.0.22631");
    expect(ev.message).toContain("OS Windows 10 Pro → Windows 11 Pro");
    expect(Object.keys((ev.details as any).changes).sort()).toEqual(["os", "osVersion"]);
  });

  it("defaults the actor to system:discovery", () => {
    const ev = buildFirmwareChangedEvent(CTX, { osVersion: "1" }, { osVersion: "2" })!;
    expect(ev.actor).toBe("system:discovery");
  });

  it("returns undefined when nothing changed", () => {
    expect(buildFirmwareChangedEvent(CTX, { osVersion: "7.4.8" }, { osVersion: "7.4.8" })).toBeUndefined();
  });
});

describe("buildConnectionChangedEvent", () => {
  it("reports a switch-port move", () => {
    const ev = buildConnectionChangedEvent("switch", CTX, "SW-A/port3", "SW-B/port12")!;
    expect(ev.action).toBe("asset.switch_port.changed");
    expect((ev.details as any).changes).toEqual({
      lastSeenSwitch: { from: "SW-A/port3", to: "SW-B/port12" },
    });
    expect(ev.message).toContain("SW-A/port3 → SW-B/port12");
  });

  it("reports a roam with both APs named", () => {
    const ev = buildConnectionChangedEvent("ap", CTX, "AP-1F-DOCK", "AP-2F-LOBBY")!;
    expect(ev.action).toBe("asset.wireless_ap.changed");
    expect(ev.message).toBe('Asset "wks-042" roamed to AP "AP-2F-LOBBY" (was "AP-1F-DOCK")');
  });

  it("emits on a first observed attachment (null → value)", () => {
    // Unlike firmware, "where is this plugged in" is worth recording the first
    // time it's known.
    const ev = buildConnectionChangedEvent("ap", CTX, null, "AP-2F-LOBBY")!;
    expect(ev).toBeDefined();
    expect((ev.details as any).changes.lastSeenAp).toEqual({ from: null, to: "AP-2F-LOBBY" });
    expect(ev.message).toContain("connected to AP");
  });

  it("stays silent when the value is merely restated", () => {
    expect(buildConnectionChangedEvent("switch", CTX, "SW-A/port3", "SW-A/port3")).toBeUndefined();
  });

  it("stays silent on a pure case or whitespace difference", () => {
    // Discovery writes inv.apName while the wireless scrape writes the AP
    // asset's hostname; a case difference between the two would otherwise
    // alternate an event every cycle.
    expect(buildConnectionChangedEvent("ap", CTX, "ap-2f-lobby", "AP-2F-Lobby")).toBeUndefined();
    expect(buildConnectionChangedEvent("switch", CTX, "SW-A/port3", " SW-A/port3 ")).toBeUndefined();
  });

  it("stays silent when nothing was observed this pass", () => {
    // A null `to` means "not seen", never "detached".
    expect(buildConnectionChangedEvent("ap", CTX, "AP-1F-DOCK", null)).toBeUndefined();
    expect(buildConnectionChangedEvent("ap", CTX, "AP-1F-DOCK", "   ")).toBeUndefined();
  });
});

describe("buildFirewallChangedEvent", () => {
  it("shapes the gateway move", () => {
    const ev = buildFirewallChangedEvent({ ...CTX, source: "dhcp-sighting" }, "GATE-A", "GATE-B")!;
    expect(ev.action).toBe("asset.gateway_firewall.changed");
    expect(ev.resourceType).toBe("asset");
    expect((ev.details as any).changes).toEqual({ seenFirewall: { from: "GATE-A", to: "GATE-B" } });
    expect(ev.message).toContain("GATE-A → GATE-B");
  });

  it("stays silent on an unchanged gate", () => {
    expect(buildFirewallChangedEvent(CTX, "GATE-A", "gate-a")).toBeUndefined();
    expect(buildFirewallChangedEvent(CTX, "GATE-A", "")).toBeUndefined();
  });
});
