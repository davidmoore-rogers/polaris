/**
 * tests/unit/assetInterfacesTableDom.test.ts — the asset-details Interfaces
 * table (public/js/assets.js): per-column sort + filter over a nested tree.
 *
 * assets.js is a ~17k-line browser script with no module boundary, so the three
 * functions under test are sliced out by name and eval'd into a happy-dom Window
 * with the app-shell globals stubbed — the eval-with-stubs approach of
 * tests/unit/tableColumnOrder.test.ts, narrowed to the functions that matter.
 *
 * What's pinned here is what silently rots now that the table re-renders itself:
 *  - a sort or filter rewrites the tbody, so every row handler must be delegated
 *    and the pin sets must be mutated in place (a rebound local leaves a
 *    re-render drawing stale checkboxes);
 *  - select-all must not un-pin an interface a filter is hiding — that would
 *    silently stop its fast-cadence polling and drop it to 24h retention;
 *  - the collapse tree has to survive the System tab's refresh-tick rebuild,
 *    which is why collapsed state is baked into the row markup rather than
 *    applied to the DOM afterwards.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);
const tableSfSrc = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_assetTableTypeKey",
  "_getCollapsedIfaces",
  "_setCollapsedIfaces",
  "_lldpNeighborInlineCell",
  "_distinctSorted",
  "_renderInterfacesTable",
  "_buildInterfacesTableDOM",
  "_wireInterfacesTable",
];

/** A FortiSwitch-ish device: PoE ports, an aggregate + member, VLAN, tunnels. */
function makeSi() {
  return {
    lastSystemInfoAt: new Date().toISOString(),
    monitoredInterfaces: ["port2"],
    monitoredIpsecTunnels: [],
    lldpNeighbors: [
      { localIfName: "port1", systemName: "core-sw", portId: "ge-0/0/1", matchedAsset: { id: "A1" } },
    ],
    interfaces: [
      { ifName: "port1", ifType: "physical", adminStatus: "up", operStatus: "up", speedBps: 1e9,
        ipAddress: "10.0.0.5", macAddress: "aa:bb:cc:00:00:01", inOctets: 900, outOctets: 100,
        inErrors: 0, outErrors: 0, poeStatus: "delivering", poeClass: "class3", nativeVlan: 10 },
      { ifName: "port2", ifType: "physical", adminStatus: "up", operStatus: "down", speedBps: 1e8,
        ipAddress: null, macAddress: null, inOctets: null, outOctets: null,
        poeStatus: "fault", nativeVlan: 20, taggedVlans: ["30", "40"] },
      { ifName: "port3", ifType: "physical", adminStatus: "down", operStatus: "down",
        poeStatus: "searching", nativeVlan: 10 },
      { ifName: "lag1", ifType: "aggregate", adminStatus: "up", operStatus: "up", inOctets: 5000, outOctets: 4000 },
      { ifName: "port9", ifType: "physical", ifParent: "lag1", adminStatus: "up", operStatus: "up", inOctets: 2500 },
      { ifName: "vlan50", ifType: "vlan", vlanId: 50, adminStatus: "up", operStatus: "up", ipAddress: "10.9.9.1" },
    ],
    ipsecTunnels: [
      { tunnelName: "to-hq", status: "up", parentInterface: "port1", incomingBytes: 10, outgoingBytes: 20 },
      { tunnelName: "orphan-tn", status: "down", parentInterface: "wan9" },
    ],
  };
}
const ASSET = { id: "AST1", assetType: "switch", monitoredInterfaces: ["port2"], monitoredIpsecTunnels: [] };
/** localStorage key the sort/filter state persists under (per user + type). */
const PREFS_KEY = "polaris-prefs-asset-interfaces-switch-tester";

let win: Window;
let doc: Window["document"];
let putCalls: Record<string, any>[];
let openedIface: string | null;

function setup(): void {
  win = new Window();
  doc = win.document;
  putCalls = [];
  openedIface = null;

  g.window = win;
  g.document = doc;
  g.localStorage = (win as any).localStorage;
  g.MutationObserver = (win as any).MutationObserver;
  g.ResizeObserver = (win as any).ResizeObserver;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.CSS = (win as any).CSS;
  g.currentUsername = "tester";
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = () => {};
  g.canManageAssets = () => true;
  g._staleBannerHTML = () => "";
  g._fmtSpeed = (b: number) => `${b}bps`;
  g._fmtBytes = (b: number) => `${b}B`;
  g._screenshotTableEl = () => {};
  g.openInterfaceDetailPanel = (_a: unknown, n: string) => { openedIface = n; };
  g.openIpsecTunnelDetailPanel = () => {};
  g.openViewModal = () => {};
  g.api = { assets: { update: (_id: string, body: Record<string, any>) => { putCalls.push(body); return Promise.resolve({}); } } };

  (0, eval)(tableSfSrc);
  // table-sf.js publishes this on `window`, which IS the global in a browser.
  g.PolarisPrefs = (win as any).PolarisPrefs;
  for (const name of FN_NAMES) (0, eval)(fnSrc(name));
}

/** Render (or re-render, as the System tab's refresh tick does) the table. */
function render(): void {
  doc.body.innerHTML = '<div id="ifaces"></div>';
  g._renderInterfacesTable(doc.getElementById("ifaces"), makeSi(), ASSET);
}

const allRows = () => Array.from(doc.querySelectorAll("#asset-iface-tbody > tr"));
const dataRows = () => allRows().filter((tr) => tr.querySelectorAll(":scope > td").length > 1);
function nameOf(tr: Element): string {
  const a = tr.querySelector(".asset-iface-link, .asset-ipsec-link");
  return a ? a.textContent!.trim() : "(none)";
}
const names = () => dataRows().map(nameOf);
const rowFor = (name: string) => dataRows().find((tr) => nameOf(tr) === name)!;
const sectionLabels = () =>
  allRows().filter((tr) => tr.querySelectorAll(":scope > td").length === 1)
    .map((tr) => tr.textContent!.replace(/\s+/g, " ").trim());

const click = (el: any) => el.dispatchEvent(new (win as any).Event("click", { bubbles: true, cancelable: true }));
const change = (el: any) => el.dispatchEvent(new (win as any).Event("change", { bubbles: true }));
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const sortBy = (key: string) => click(doc.querySelector(`th[data-sf-key="${key}"] .sf-header`));
/** TableSF debounces text filters by 200ms. */
async function typeFilter(key: string, value: string): Promise<void> {
  const inp: any = doc.querySelector(`th[data-sf-key="${key}"] input.sf-filter`);
  inp.value = value;
  inp.dispatchEvent(new (win as any).Event("input", { bubbles: true }));
  await settle(260);
}
function checkboxFilter(key: string, value: string, on: boolean): void {
  const cb: any = Array.from(doc.querySelectorAll(`th[data-sf-key="${key}"] input[type="checkbox"]`))
    .find((el: any) => el.value === value);
  cb.checked = on;
  change(cb);
}

beforeEach(() => { setup(); render(); });

describe("default (tree) view", () => {
  it("renders every interface and tunnel — nothing is hidden for lack of traffic", () => {
    // The "Show N inactive interfaces" expander is gone: port3 (admin-shut, no
    // counters) and orphan-tn (dead tunnel) are ordinary visible rows now.
    expect(names().sort()).toEqual(
      ["lag1", "orphan-tn", "port1", "port2", "port3", "port9", "to-hq", "vlan50"],
    );
    expect(dataRows().every((tr) => tr.getAttribute("style") !== "display:none")).toBe(true);
  });

  it("keeps the nesting and the section headers", () => {
    const n = names();
    expect(n.indexOf("port9")).toBe(n.indexOf("lag1") + 1);   // member under its aggregate
    expect(sectionLabels()).toHaveLength(3);
    expect(sectionLabels()[0]).toMatch(/Interfaces \(4\)/);   // top-level count, not row count
  });

  it("offers filter options for only the states this device reports", () => {
    const opts = (key: string) =>
      Array.from(doc.querySelectorAll(`th[data-sf-key="${key}"] .sf-multi-option`))
        .map((l) => l.textContent!.trim());
    expect(opts("poe")).toEqual(["Delivering", "Fault", "Searching"]);
    expect(opts("status")).toEqual(["admin shut", "down", "up"]);
  });
});

describe("sorting", () => {
  it("flattens the tree — no section headers, no expand toggles", () => {
    sortBy("in");
    expect(sectionLabels()).toEqual([]);
    expect(doc.querySelectorAll(".iface-expand-toggle")).toHaveLength(0);
    // A member port is no longer indented under anything, so its badge is the
    // only thing left identifying it as one.
    expect(rowFor("port9").outerHTML).toMatch(/Member/);
  });

  it("orders by the numeric counter, with unreported rows last", () => {
    sortBy("in");
    expect(names().slice(0, 4)).toEqual(["to-hq", "port1", "port9", "lag1"]);
    sortBy("in");
    expect(names()[0]).toBe("lag1");   // second click reverses
  });

  it("reveals the children of a collapsed parent instead of stranding them", () => {
    click(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]'));
    expect(rowFor("port9").style.display).toBe("none");
    sortBy("ifname");
    expect(names()).toContain("port9");
    expect(dataRows().every((tr) => tr.getAttribute("style") !== "display:none")).toBe(true);
  });
});

describe("filtering", () => {
  it("matches text against the interface name", async () => {
    await typeFilter("ifname", "port");
    expect(names().sort()).toEqual(["port1", "port2", "port3", "port9"]);
  });

  it("renders an empty state rather than a blank table", async () => {
    await typeFilter("ifname", "no-such-port");
    expect(dataRows()).toHaveLength(0);
    expect(doc.getElementById("asset-iface-tbody")!.textContent).toMatch(/No interfaces match/);
  });

  it("excludes tunnels from a PoE filter — they report null, not zero", () => {
    checkboxFilter("poe", "fault", true);
    expect(names()).toEqual(["port2"]);
  });
});

describe("re-render safety", () => {
  it("keeps the drill-down link working after the tbody is rewritten", () => {
    sortBy("ifname");
    click(rowFor("port1").querySelector(".asset-iface-link"));
    expect(openedIface).toBe("port1");
  });

  it("still renders a pin made after load as checked", async () => {
    const cb: any = rowFor("port1").querySelector(".asset-iface-toggle");
    cb.checked = true;
    change(cb);
    await settle();
    expect(putCalls.at(-1)!.monitoredInterfaces).toContain("port1");
    sortBy("mac");   // re-render from the row model
    expect((rowFor("port1").querySelector(".asset-iface-toggle") as any).checked).toBe(true);
  });

  it("persists sort + filter state per user and device type", async () => {
    sortBy("mac");
    await typeFilter("ifname", "port");
    const saved = JSON.parse(g.localStorage.getItem(PREFS_KEY));
    expect(saved.sortKey).toBe("mac");
    expect(saved.sfFilters.ifname).toBe("port");
    render();   // a refresh tick rebuilds the whole container
    expect(names().sort()).toEqual(["port1", "port2", "port3", "port9"]);
  });

  it("keeps a collapsed parent collapsed across a rebuild", () => {
    click(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]'));
    render();
    expect(rowFor("port9").getAttribute("style")).toBe("display:none");
    expect(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]')!.textContent!.trim()).toBe("▶");
  });
});

describe("select-all", () => {
  it("clears every listed row when nothing is filtered", async () => {
    const all: any = doc.getElementById("iface-poll-all");
    all.checked = false;
    change(all);
    await settle();
    expect(putCalls[0].monitoredInterfaces).toEqual([]);
  });

  it("leaves a filtered-out pin alone — un-pinning it would silently stop its polling", async () => {
    // port2 ships pinned; filter it out of the list, then clear-all.
    await typeFilter("ifname", "port1");
    const all: any = doc.getElementById("iface-poll-all");
    all.checked = false;
    change(all);
    await settle();
    expect(putCalls[0].monitoredInterfaces).toEqual(["port2"]);
  });

  it("pins only the listed rows when checked", async () => {
    await typeFilter("ifname", "port3");
    const all: any = doc.getElementById("iface-poll-all");
    all.checked = true;
    change(all);
    await settle();
    expect(putCalls[0].monitoredInterfaces.sort()).toEqual(["port2", "port3"]);
  });
});
