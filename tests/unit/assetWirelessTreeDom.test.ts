/**
 * tests/unit/assetWirelessTreeDom.test.ts — the asset-details Wireless tab's
 * radio → SSID → client tree (public/js/assets.js).
 *
 * The tab used to be a flat list of connected clients, which answered "who is
 * connected" and nothing about the radio they are connected to. What's pinned
 * here is the part that would rot silently:
 *  - a client is filed under the SSID it actually joined, BSSID first, with
 *    (radio, SSID-name) as the fallback — file it wrong and the tree reads as
 *    confidently as when it is right;
 *  - a client that matches nothing is SHOWN rather than dropped, or the tree
 *    quietly disagrees with the client count;
 *  - the per-radio client count is counted from the rows below it rather than
 *    taken from the controller's own tally, which disagrees mid-roam;
 *  - transmit power is rendered as the sources reported it (a percentage from
 *    the controller, dBm from the MIB) and never converted, since converting
 *    needs a per-model maximum Polaris does not have;
 *  - an AP with no radio inventory yet still gets the old flat table, so the
 *    tab never regresses to empty while discovery fills it in.
 *
 * assets.js is a ~17k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd with the app-shell
 * globals stubbed — the approach of tests/unit/assetAlertsTabDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_getCollapsedIfaces",
  "_setCollapsedIfaces",
  "_radioBandLabel",
  "_wirelessChip",
  "_radioPowerLabel",
  "_buildWirelessTree",
  "_stationEndpointHTML",
  "_wirelessStationRow",
  "_wirelessRadioRow",
  "_wirelessVapRow",
  "_renderWirelessTree",
  "_wirelessBandLabel",
  "_renderWirelessStationsCard",
];

let container: HTMLElement;

beforeEach(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.currentUsername = "wireless-tester";
  g._staleBannerHTML = () => "";
  g.applyTableLayout = vi.fn();
  g._assetTableTypeKey = () => "asset-wireless";
  g._screenshotTableEl = vi.fn();
  g._assetMonitorStreamSource = () => ({ polling: "snmp" });
  g.openViewModal = vi.fn();
  try { globalThis.localStorage.clear(); } catch { /* happy-dom always has one */ }

  // eslint-disable-next-line no-eval
  (0, eval)(FN_NAMES.map(fnSrc).join("\n\n"));

  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById("mount")!;
});

/** Two radios, three SSIDs — the shape a real dual-band FortiAP reports. */
function makeRadios() {
  return [
    {
      radioIndex: 1, band: "2.4GHz", mode: "ap", radioType: "802.11n", channel: 6,
      bandwidthMhz: 20, txPowerPct: 70, txPowerDbm: null, txPowerMinDbm: null,
      txPowerMaxDbm: null, txPowerMode: null, baseBssid: "AA:BB:CC:00:00:00",
      clientCount: 99, countryCode: "US", source: "fortios",
      vaps: [{ vapName: "corp-2g", ssid: "CORP", bssid: "AA:BB:CC:00:00:01", vlanId: 10, clientCount: null }],
    },
    {
      radioIndex: 2, band: "5GHz", mode: "ap", radioType: "802.11ax", channel: 149,
      bandwidthMhz: 80, txPowerPct: 100, txPowerDbm: 17, txPowerMinDbm: 1,
      txPowerMaxDbm: 20, txPowerMode: "auto", baseBssid: "AA:BB:CC:00:00:10",
      clientCount: 99, countryCode: "US", source: "snmp",
      vaps: [
        { vapName: "corp-5g", ssid: "CORP", bssid: "AA:BB:CC:00:00:11", vlanId: 10, clientCount: null },
        { vapName: "guest-5g", ssid: "GUEST", bssid: "AA:BB:CC:00:00:12", vlanId: 20, clientCount: null },
      ],
    },
  ];
}

const ASSET = { id: "ap-1", assetType: "access_point", monitored: true };

describe("_buildWirelessTree", () => {
  it("files a client under the SSID whose BSSID it reported", () => {
    const tree = g._buildWirelessTree(makeRadios(), [
      { staMacAddr: "11:11:11:11:11:11", bssid: "AA:BB:CC:00:00:12", ssid: "GUEST", radioId: 2 },
    ]);
    expect(tree.radios[1].vaps[1].stations.map((s: any) => s.staMacAddr)).toEqual(["11:11:11:11:11:11"]);
    expect(tree.unplaced).toEqual([]);
  });

  // One SSID on two radios is the normal case, so a name-only match has to be
  // scoped by radio or every 5 GHz client lands under the 2.4 GHz VAP.
  it("falls back to (radio, SSID) when no BSSID was reported, scoped to that radio", () => {
    const tree = g._buildWirelessTree(makeRadios(), [
      { staMacAddr: "22:22:22:22:22:22", bssid: null, ssid: "CORP", radioId: 2 },
    ]);
    expect(tree.radios[0].vaps[0].stations).toEqual([]);
    expect(tree.radios[1].vaps[0].stations.map((s: any) => s.staMacAddr)).toEqual(["22:22:22:22:22:22"]);
  });

  it("prefers the BSSID over the SSID name when the two disagree", () => {
    const tree = g._buildWirelessTree(makeRadios(), [
      // Says CORP on radio 1, but the BSSID is the 5 GHz GUEST VAP's.
      { staMacAddr: "33:33:33:33:33:33", bssid: "AA:BB:CC:00:00:12", ssid: "CORP", radioId: 1 },
    ]);
    expect(tree.radios[1].vaps[1].stations.map((s: any) => s.staMacAddr)).toEqual(["33:33:33:33:33:33"]);
    expect(tree.radios[0].vaps[0].stations).toEqual([]);
  });

  it("keeps a client that matches nothing instead of dropping it", () => {
    const tree = g._buildWirelessTree(makeRadios(), [
      { staMacAddr: "44:44:44:44:44:44", bssid: "DE:AD:BE:EF:00:01", ssid: "OLD-SSID", radioId: 9 },
    ]);
    expect(tree.unplaced.map((s: any) => s.staMacAddr)).toEqual(["44:44:44:44:44:44"]);
  });
});

describe("_renderWirelessTree", () => {
  it("renders a row per radio, per SSID and per client", () => {
    g._renderWirelessTree(container, makeRadios(), [
      { staMacAddr: "11:11:11:11:11:11", bssid: "AA:BB:CC:00:00:11", ssid: "CORP", radioId: 2, staIpAddr: "10.0.0.5", band: "5GHz", signalStrength: -52 },
    ], ASSET, null);
    const text = container.textContent || "";
    expect(text).toContain("Radio 1");
    expect(text).toContain("2.4 GHz");
    expect(text).toContain("Radio 2");
    expect(text).toContain("CORP");
    expect(text).toContain("GUEST");
    expect(text).toContain("11:11:11:11:11:11");
    expect(text).toContain("10.0.0.5");
    expect(text).toContain("-52 dBm");
    // Channel + width ride the radio row.
    expect(text).toContain("ch 149");
    expect(text).toContain("80 MHz");
  });

  // The controller's own clientCount (99 in the fixture) disagrees with the
  // list while a client is roaming; the number next to a list must match it.
  it("counts clients from the rows below, not from the controller's tally", () => {
    g._renderWirelessTree(container, makeRadios(), [
      { staMacAddr: "11:11:11:11:11:11", bssid: "AA:BB:CC:00:00:11", ssid: "CORP", radioId: 2 },
      { staMacAddr: "22:22:22:22:22:22", bssid: "AA:BB:CC:00:00:11", ssid: "CORP", radioId: 2 },
    ], ASSET, null);
    const text = container.textContent || "";
    expect(text).toContain("2 clients");
    expect(text).toContain("0 clients");
    expect(text).not.toContain("99 clients");
  });

  it("shows power as each source reported it, never converted", () => {
    g._renderWirelessTree(container, makeRadios(), [], ASSET, null);
    const text = container.textContent || "";
    // Radio 2 has both: dBm with the floor/ceiling from the MIB, % from the controller.
    expect(text).toContain("17 dBm (1–20)");
    expect(text).toContain("100%");
    // Radio 1 has only the controller's percentage.
    expect(text).toContain("70%");
  });

  it("lists unmatched clients under their own heading with a count", () => {
    g._renderWirelessTree(container, makeRadios(), [
      { staMacAddr: "44:44:44:44:44:44", bssid: "DE:AD:BE:EF:00:01", ssid: "OLD", radioId: 9 },
    ], ASSET, null);
    const text = container.textContent || "";
    expect(text).toContain("Not matched to a broadcast SSID");
    expect(text).toContain("1 of 1");
    expect(text).toContain("44:44:44:44:44:44");
  });

  it("says so when a radio broadcasts nothing", () => {
    const radios = makeRadios();
    radios[0].vaps = [];
    g._renderWirelessTree(container, radios, [], ASSET, null);
    expect(container.textContent).toContain("No SSIDs reported for this radio");
  });

  it("collapses a radio's subtree and remembers it per asset", () => {
    g._renderWirelessTree(container, makeRadios(), [
      { staMacAddr: "11:11:11:11:11:11", bssid: "AA:BB:CC:00:00:11", ssid: "CORP", radioId: 2 },
    ], ASSET, null);
    const toggle = container.querySelectorAll(".wireless-expand-toggle")[1] as HTMLElement;
    expect(toggle.textContent).toBe("▼");
    toggle.click();

    const hidden = Array.from(container.querySelectorAll('.wireless-child[data-parent="radio-2"]'));
    expect(hidden.length).toBeGreaterThan(0);
    hidden.forEach((row) => expect((row as HTMLElement).style.display).toBe("none"));
    // Radio 1's subtree is untouched — one toggle collapses one radio.
    const other = container.querySelector('.wireless-child[data-parent="radio-1"]') as HTMLElement;
    expect(other.style.display).not.toBe("none");

    // Re-render: the collapsed radio comes back collapsed.
    g._renderWirelessTree(container, makeRadios(), [], ASSET, null);
    const again = container.querySelectorAll(".wireless-expand-toggle")[1] as HTMLElement;
    expect(again.textContent).toBe("▶");
  });

  it("keeps its collapsed set apart from the System tab's interface tree", () => {
    g._setCollapsedIfaces("ap-1", new Set(["port9"]));
    g._setCollapsedIfaces("ap-1", new Set(["radio-2"]), "wireless");
    expect(Array.from(g._getCollapsedIfaces("ap-1"))).toEqual(["port9"]);
    expect(Array.from(g._getCollapsedIfaces("ap-1", "wireless"))).toEqual(["radio-2"]);
  });
});

describe("_renderWirelessStationsCard dispatch", () => {
  it("renders the tree when the AP has radio inventory", () => {
    g._renderWirelessStationsCard(container, { apRadios: makeRadios(), wirelessStations: [] }, ASSET);
    expect(container.textContent).toContain("Radio 1");
    expect(container.querySelector("th")?.textContent).toContain("Radio / SSID / Client");
  });

  // Discovery has not reached this AP yet — the flat list is what keeps the
  // tab from reading as empty while the radio inventory fills in.
  it("falls back to the flat station table when there is no radio inventory", () => {
    g._renderWirelessStationsCard(container, {
      apRadios: [],
      wirelessStations: [{ staMacAddr: "11:11:11:11:11:11", ssid: "CORP", band: "5GHz", staIpAddr: "10.0.0.5" }],
    }, ASSET);
    const text = container.textContent || "";
    expect(text).toContain("11:11:11:11:11:11");
    expect(text).not.toContain("Radio 1");
    expect(container.querySelector("th")?.textContent).toContain("SSID");
  });

  it("explains both sources when an AP reports neither radios nor clients", () => {
    g._renderWirelessStationsCard(container, { apRadios: [], wirelessStations: [] }, ASSET);
    const text = container.textContent || "";
    expect(text).toContain("discovery run");
    expect(text).toContain("fapStationTable");
  });
});
