/**
 * tests/unit/assetsDiscoveryDom.test.ts — the network Discovery wizard
 * (public/js/assets-discovery.js).
 *
 * A wizard that doesn't open renders nothing and raises no toast, which is the
 * class of bug tests/unit/automationsWizardDom.test.ts exists for. On top of
 * that shell coverage, what's pinned here is the behaviour that is a decision
 * rather than an implementation detail:
 *
 *  - `.stepper` is the DIRECT FIRST CHILD of `.modal-body` — both the sticky
 *    rule and the `:has(> .stepper:first-child)` padding rule key off that, so
 *    a stray wrapper silently unpins the header mid-scroll;
 *  - **Save is absent, not disabled, for a read-level caller.** Authoring is
 *    `networkScan:write`; a button whose click can only 403 must not render;
 *  - **step validation blocks Next** — a Discovery with no name or no target is
 *    not saveable, and the wizard says so on the step rather than at the POST;
 *  - free navigation reaches visited steps only, so a fresh draft can't jump to
 *    the Run step before it has targets;
 *  - the target rows are add/removable and never collapse to zero;
 *  - a method toggle keeps the stored order = the METHOD priority order, since
 *    the runner treats array order as "try this first";
 *  - `groupKeyForHit` mirrors the server's `methodKeyForHit`, because step 6's
 *    per-group selections are keyed by it and a mismatch would silently pin
 *    nothing;
 *  - the saved-Discovery list's row verbs are gated per key, and a read-level
 *    caller gets Export only.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const SRC = readFileSync(resolve(__dirname, "../../public/js/assets-discovery.js"), "utf8");

const g = globalThis as Record<string, any>;
let doc: Window["document"];
let toasts: { msg: string; kind?: string }[];

interface Api {
  open: (existing?: unknown, opts?: unknown) => Promise<void>;
  openList: () => Promise<void>;
  STEPS: string[];
  emptyDraft: () => Record<string, unknown>;
  groupKeyForHit: (hit: unknown) => string;
  listRowItems: (scan: unknown) => { label?: string; separator?: boolean; onSelect?: () => void }[];
  METHOD_ORDER: string[];
}

/** Load the module into a fresh happy-dom with the app-shell globals stubbed. */
function load(opts: { scan?: "none" | "read" | "write"; assets?: boolean; scans?: unknown[] } = {}): Api {
  const scan = opts.scan ?? "write";
  const RANK: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };
  const win = new Window();
  doc = win.document;
  toasts = [];
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = (msg: string, kind?: string) => { toasts.push({ msg, kind }); };
  g.showConfirm = async () => true;
  g.closeModal = () => { doc.getElementById("modal-overlay")?.remove(); };
  g.showRowMenu = () => {};
  g.permAtLeast = (key: string, level: string) => {
    if (key === "networkScan") return RANK[scan] >= RANK[level];
    if (key === "assets") return opts.assets !== false;
    return true;
  };
  // Mirror production: ONE #modal-overlay, reused, with body/footer replaced.
  g.openModal = (title: string, body: string, footer: string) => {
    let overlay = doc.getElementById("modal-overlay");
    if (!overlay) {
      overlay = doc.createElement("div");
      overlay.id = "modal-overlay";
      overlay.innerHTML =
        '<div class="modal"><div class="modal-header"><h3></h3></div>' +
        '<div class="modal-body"></div><div class="modal-footer"></div></div>';
      doc.body.appendChild(overlay);
    }
    overlay.querySelector(".modal-header h3")!.textContent = title;
    overlay.querySelector(".modal-body")!.innerHTML = body;
    overlay.querySelector(".modal-footer")!.innerHTML = footer;
  };
  g.api = {
    credentials: { list: async () => ({ credentials: [{ id: "c1", name: "public", type: "snmp" }] }) },
    networkScans: {
      list: async () => ({ scans: opts.scans ?? [] }),
      previewTargets: async () => ({ total: 6, dropped: 0, droppedBy: { invalid: 0, excluded: 0, cap: 0 }, perTarget: [{ count: 6 }], sample: ["10.4.0.1"], alreadyKnown: 0, cap: 65536 }),
      getRun: async () => ({ run: { id: "r1", status: "completed", totalTargets: 6, scannedCount: 6, hitCount: 0, hits: [] } }),
      run: async () => ({ run: { id: "r1", status: "queued", totalTargets: 0, scannedCount: 0, hitCount: 0 } }),
      create: async () => ({ scan: { id: "s1" } }),
      update: async () => ({ scan: { id: "s1" } }),
      delete: async () => ({}),
      cancelRun: async () => ({}),
      adopt: async () => ({ created: 1, skipped: [], assetIds: ["a1"] }),
    },
  };
  (0, eval)(SRC);
  return win.PolarisAssetDiscovery as Api;
}

const activeStep = () =>
  (doc.querySelector("#nd-stepper .stepper-step.active") as HTMLElement | null)?.getAttribute("data-step");
const visiblePanels = () =>
  Array.from(doc.querySelectorAll(".step-panel.visible")).map((el) => (el as HTMLElement).id);
const shown = (id: string) => {
  const el = doc.getElementById(id) as HTMLElement | null;
  return !!el && el.style.display !== "none";
};
const click = (id: string) => (doc.getElementById(id) as HTMLElement).click();

/** Fill step 1 + 2 so Next is allowed through. */
function fillBasics() {
  (doc.getElementById("nd-name") as HTMLInputElement).value = "Ashfield mgmt";
  (doc.querySelector("#nd-targets .nd-t-value") as HTMLInputElement).value = "10.4.0.0/29";
}

beforeEach(() => { /* each test loads its own window */ });

describe("PolarisAssetDiscovery — namespace", () => {
  it("exposes what assets.js reads plus the pure helpers", async () => {
    const D = load();
    expect(typeof D.open).toBe("function");
    expect(typeof D.openList).toBe("function");
    expect(D.STEPS).toEqual(["Name", "Targets", "Methods", "Run", "Results", "Monitoring", "Summary"]);
    expect(D.METHOD_ORDER).toEqual(["icmp", "snmp", "restapi", "ssh", "winrm"]);
  });

  it("emptyDraft separates configuration from run state", async () => {
    const d = load().emptyDraft();
    expect(d).toMatchObject({ name: "", autoMonitor: {} });
    // Run state must never be saved with the configuration.
    expect(d).toMatchObject({ runId: null, hits: [], selected: [] });
    // A usable starting shape rather than empty arrays the operator must seed.
    expect(d.targets).toHaveLength(1);
    expect(d.methods).toEqual([{ type: "icmp", credentialIds: [] }]);
  });
});

describe("PolarisAssetDiscovery — shell", () => {
  it("opens with the stepper as the direct first child of .modal-body", async () => {
    const D = load();
    await D.open();
    const body = doc.querySelector(".modal-body")!;
    expect(body.firstElementChild?.classList.contains("stepper")).toBe(true);
  });

  it("renders one panel per step with exactly one visible", async () => {
    const D = load();
    await D.open();
    expect(doc.querySelectorAll(".step-panel").length).toBe(D.STEPS.length);
    expect(visiblePanels()).toEqual(["nd-step-1"]);
  });

  it("hides Back on the first step", async () => {
    await load().open();
    expect(shown("nd-back")).toBe(false);
    expect(shown("nd-next")).toBe(true);
  });

  it("titles the modal by mode", async () => {
    const title = () => doc.querySelector(".modal-header h3")!.textContent;
    await load().open();
    expect(title()).toBe("New discovery");
    await load().open({ id: "s1", name: "x", targets: [], methods: [] });
    expect(title()).toBe("Edit discovery");
    await load().open({ name: "x", targets: [], methods: [] }, { import: true });
    expect(title()).toBe("Imported discovery");
  });

  it("does not mutate the row it was opened with", async () => {
    const row = { id: "s1", name: "Ashfield", targets: [{ kind: "cidr", value: "10.0.0.0/24" }], methods: [] };
    const before = JSON.stringify(row);
    await load().open(row);
    expect(JSON.stringify(row)).toBe(before);
  });

  it("unlocks every step when editing a saved Discovery", async () => {
    const D = load();
    await D.open({ id: "s1", name: "x", targets: [{ kind: "cidr", value: "10.4.0.0/29" }], methods: [{ type: "icmp" }] });
    (doc.querySelector('#nd-stepper .stepper-step[data-step="7"]') as HTMLElement).click();
    expect(activeStep()).toBe("7");
  });
});

describe("PolarisAssetDiscovery — step validation", () => {
  it("refuses Next with no name", async () => {
    await load().open();
    click("nd-next");
    expect(activeStep()).toBe("1");
    expect(toasts.some((t) => /name/i.test(t.msg))).toBe(true);
  });

  it("refuses Next with no target", async () => {
    await load().open();
    (doc.getElementById("nd-name") as HTMLInputElement).value = "Ashfield mgmt";
    click("nd-next");
    expect(activeStep()).toBe("2");
    click("nd-next");
    expect(activeStep()).toBe("2");
    expect(toasts.some((t) => /address, range or subnet/i.test(t.msg))).toBe(true);
  });

  it("walks to the methods step once name and target are filled", async () => {
    await load().open();
    fillBasics();
    click("nd-next");
    click("nd-next");
    expect(activeStep()).toBe("3");
    expect(visiblePanels()).toEqual(["nd-step-3"]);
  });

  it("refuses to leave the Run step before a run exists", async () => {
    await load().open();
    fillBasics();
    click("nd-next"); click("nd-next"); click("nd-next");
    expect(activeStep()).toBe("4");
    click("nd-next");
    expect(activeStep()).toBe("4");
    expect(toasts.some((t) => /Run the scan/i.test(t.msg))).toBe(true);
  });

  it("jumps to a visited step but not an unvisited one", async () => {
    await load().open();
    fillBasics();
    click("nd-next"); click("nd-next");
    expect(activeStep()).toBe("3");
    (doc.querySelector('#nd-stepper .stepper-step[data-step="1"]') as HTMLElement).click();
    expect(activeStep()).toBe("1");
    (doc.querySelector('#nd-stepper .stepper-step[data-step="6"]') as HTMLElement).click();
    expect(activeStep()).toBe("1");
  });
});

describe("PolarisAssetDiscovery — targets step", () => {
  it("adds and removes target rows, never collapsing to zero", async () => {
    await load().open();
    (doc.getElementById("nd-name") as HTMLInputElement).value = "x";
    click("nd-next");
    expect(doc.querySelectorAll("#nd-targets .nd-target-row").length).toBe(1);
    click("nd-add-target");
    expect(doc.querySelectorAll("#nd-targets .nd-target-row").length).toBe(2);
    // Removing the last remaining row leaves an empty one to type into.
    (doc.querySelectorAll("#nd-targets .nd-t-remove")[1] as HTMLElement).click();
    (doc.querySelectorAll("#nd-targets .nd-t-remove")[0] as HTMLElement).click();
    expect(doc.querySelectorAll("#nd-targets .nd-target-row").length).toBe(1);
  });

  it("renders every preview state through one shell so the box can't resize", async () => {
    await load().open();
    const box = doc.getElementById("nd-target-preview")!;
    expect(box.classList.contains("aw-preview-box")).toBe(true);
    expect(box.querySelector(".aw-preview-head")).toBeTruthy();
    expect(box.querySelector(".aw-preview-body")).toBeTruthy();
  });
});

describe("PolarisAssetDiscovery — methods step", () => {
  it("offers all five methods with ICMP on by default", async () => {
    await load().open();
    fillBasics();
    click("nd-next"); click("nd-next");
    const boxes = Array.from(doc.querySelectorAll(".nd-m-enable")) as HTMLInputElement[];
    expect(boxes.map((b) => b.getAttribute("data-type"))).toEqual(["icmp", "snmp", "restapi", "ssh", "winrm"]);
    expect(boxes[0].checked).toBe(true);
  });

  it("refuses Next for a credentialed method with no credential", async () => {
    await load().open();
    fillBasics();
    click("nd-next"); click("nd-next");
    const snmp = doc.querySelector('.nd-m-enable[data-type="snmp"]') as HTMLInputElement;
    snmp.checked = true;
    snmp.dispatchEvent(new (doc.defaultView as any).Event("change", { bubbles: true }));
    click("nd-next");
    expect(activeStep()).toBe("3");
    expect(toasts.some((t) => /credential for SNMP/i.test(t.msg))).toBe(true);
  });

  it("says so when a method has no credential rather than looking configured", async () => {
    await load().open();
    fillBasics();
    click("nd-next"); click("nd-next");
    const snmp = doc.querySelector('.nd-m-enable[data-type="snmp"]') as HTMLInputElement;
    snmp.checked = true;
    snmp.dispatchEvent(new (doc.defaultView as any).Event("change", { bubbles: true }));
    expect(doc.getElementById("nd-step-3")!.innerHTML).toMatch(/can't be attempted/i);
  });
});

describe("PolarisAssetDiscovery — groupKeyForHit", () => {
  it("mirrors the server's methodKeyForHit", () => {
    const D = load();
    // Step 6 keys its per-group selections by this; a mismatch with the
    // server's methodKeyForHit would silently pin nothing.
    expect(D.groupKeyForHit({ respondedTo: ["icmp", "snmp"], identifiedBy: "snmp" })).toBe("snmp");
    expect(D.groupKeyForHit({ respondedTo: ["icmp"] })).toBe("icmp");
    expect(D.groupKeyForHit({ respondedTo: [] })).toBe("unknown");
    expect(D.groupKeyForHit(null)).toBe("unknown");
  });
});

describe("PolarisAssetDiscovery — permission gating", () => {
  it("omits Save entirely for a read-level caller", async () => {
    const D = load({ scan: "read" });
    await D.open({ id: "s1", name: "x", targets: [{ kind: "cidr", value: "10.4.0.0/29" }], methods: [{ type: "icmp" }] });
    expect(doc.getElementById("nd-save")).toBeNull();
    // …and the walkthrough still works, so the config can be read.
    (doc.querySelector('#nd-stepper .stepper-step[data-step="2"]') as HTMLElement).click();
    expect(activeStep()).toBe("2");
  });

  it("renders Save for a write-level caller", async () => {
    const D = load({ scan: "write" });
    await D.open({ id: "s1", name: "x", targets: [{ kind: "cidr", value: "10.4.0.0/29" }], methods: [{ type: "icmp" }] });
    expect(doc.getElementById("nd-save")).toBeTruthy();
  });

  it("offers no Run button to a read-level caller", async () => {
    const D = load({ scan: "read", scans: [] });
    await D.open({ id: "s1", name: "x", targets: [{ kind: "cidr", value: "10.4.0.0/29" }], methods: [{ type: "icmp" }] });
    (doc.querySelector('#nd-stepper .stepper-step[data-step="4"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.getElementById("nd-run-btn")).toBeNull();
    expect(doc.getElementById("nd-step-4")!.innerHTML).toMatch(/permission/i);
  });
});

describe("PolarisAssetDiscovery — saved list row verbs", () => {
  const scan = { id: "s1", name: "Ashfield", targets: [], methods: [], latestRun: null };
  const labels = (items: { label?: string; separator?: boolean }[]) =>
    items.filter((i) => !i.separator).map((i) => i.label);

  it("gives a write-level caller the full set", () => {
    const D = load({ scan: "write" });
    (g.window as any).PolarisDiscoveryPortability = { buildExportFile: () => ({}), filenameForExport: () => "x.json" };
    expect(labels(D.listRowItems(scan))).toEqual(["Open…", "Run now", "Export config", "Delete"]);
  });

  it("gives a read-level caller Export only", () => {
    const D = load({ scan: "read" });
    (g.window as any).PolarisDiscoveryPortability = { buildExportFile: () => ({}), filenameForExport: () => "x.json" };
    // No trigger for verbs the routes would refuse — and no leading separator
    // stranded before an empty group.
    const items = D.listRowItems(scan);
    expect(labels(items)).toEqual(["Export config"]);
    expect(items.some((i) => i.separator)).toBe(false);
  });

  it("omits Export when the portability module is not loaded", () => {
    const D = load({ scan: "write" });
    delete (g.window as any).PolarisDiscoveryPortability;
    expect(labels(D.listRowItems(scan))).toEqual(["Open…", "Run now", "Delete"]);
  });
});
