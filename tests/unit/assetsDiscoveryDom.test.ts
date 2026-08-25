/**
 * tests/unit/assetsDiscoveryDom.test.ts — the network Discovery wizard shell
 * (public/js/assets-discovery.js).
 *
 * The step bodies land phase by phase; the SHELL is what this file pins,
 * because it is the machinery every step depends on and it fails silently when
 * it breaks — a wizard that doesn't open renders nothing and raises no toast,
 * which is the exact class of bug tests/unit/automationsWizardDom.test.ts
 * exists for.
 *
 * What's pinned:
 *  - the module loads and exposes the namespace assets.js reads lazily;
 *  - `.stepper` is the DIRECT FIRST CHILD of `.modal-body`. Both the sticky
 *    rule and the `:has(> .stepper:first-child)` padding rule key off that, so
 *    a stray wrapper silently unpins the header mid-scroll;
 *  - one `.step-panel` per step with exactly one `.visible` at a time;
 *  - Back never appears on step 1, Next never on the last step;
 *  - **Save is absent for a read-level caller.** Authoring is `networkScan:write`
 *    and this is the read-only walkthrough — a button whose click can only 403
 *    must not render;
 *  - free navigation reaches visited steps only, which is what stops a fresh
 *    draft jumping to the Run step before it has targets.
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

/** Load the module into a fresh happy-dom with the app-shell globals stubbed. */
function load(opts: { scan?: "none" | "read" | "write" } = {}) {
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
  g.closeModal = () => { doc.getElementById("modal-overlay")?.remove(); };
  g.showRowMenu = () => {};
  g.permAtLeast = (key: string, level: string) =>
    key === "networkScan" ? RANK[scan] >= RANK[level] : true;
  // Mirror production: ONE #modal-overlay, reused, with .modal-body and
  // .modal-footer replaced per call. A stub that appends a fresh overlay would
  // leave two #nd-save in the document and getElementById returns the first.
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
  g.api = {};
  (0, eval)(SRC);
  return win.PolarisAssetDiscovery as {
    open: (existing?: unknown, opts?: unknown) => void;
    openList: () => void;
    STEPS: string[];
    emptyDraft: () => Record<string, unknown>;
  };
}

const visiblePanels = () =>
  Array.from(doc.querySelectorAll(".step-panel.visible")).map((el) => (el as HTMLElement).id);
const activeStep = () =>
  (doc.querySelector("#nd-stepper .stepper-step.active") as HTMLElement | null)?.getAttribute("data-step");
const shown = (id: string) => {
  const el = doc.getElementById(id) as HTMLElement | null;
  return !!el && el.style.display !== "none";
};

beforeEach(() => { load(); });

describe("PolarisAssetDiscovery — namespace", () => {
  it("exposes what assets.js reads plus the pure helpers", () => {
    const D = load();
    expect(typeof D.open).toBe("function");
    expect(typeof D.openList).toBe("function");
    expect(D.STEPS).toEqual(["Name", "Targets", "Methods", "Run", "Results", "Monitoring", "Summary"]);
  });

  it("emptyDraft carries configuration and run state separately", () => {
    const d = load().emptyDraft();
    // Saved/exported configuration mirrors the NetworkScan columns…
    expect(d).toMatchObject({ name: "", targets: [], methods: [], autoMonitor: null });
    // …while run state is not configuration and must never be saved with it.
    expect(d).toMatchObject({ runId: null, hits: [], selectedAddresses: [] });
  });
});

describe("PolarisAssetDiscovery — wizard shell", () => {
  it("opens with the stepper as the direct first child of .modal-body", () => {
    load().open();
    const body = doc.querySelector(".modal-body")!;
    expect(body.firstElementChild?.classList.contains("stepper")).toBe(true);
    expect(doc.getElementById("nd-stepper")).toBeTruthy();
  });

  it("renders one panel per step with exactly one visible", () => {
    const D = load();
    D.open();
    expect(doc.querySelectorAll(".step-panel").length).toBe(D.STEPS.length);
    expect(visiblePanels()).toEqual(["nd-step-1"]);
    expect(activeStep()).toBe("1");
  });

  it("hides Back on the first step and Next on the last", () => {
    const D = load();
    D.open();
    expect(shown("nd-back")).toBe(false);
    expect(shown("nd-next")).toBe(true);
    for (let i = 1; i < D.STEPS.length; i++) (doc.getElementById("nd-next") as HTMLElement).click();
    expect(activeStep()).toBe(String(D.STEPS.length));
    expect(shown("nd-next")).toBe(false);
    expect(shown("nd-back")).toBe(true);
    expect(shown("nd-save")).toBe(true);
  });

  it("walks forward and back, keeping one visible panel", () => {
    load().open();
    (doc.getElementById("nd-next") as HTMLElement).click();
    expect(visiblePanels()).toEqual(["nd-step-2"]);
    (doc.getElementById("nd-back") as HTMLElement).click();
    expect(visiblePanels()).toEqual(["nd-step-1"]);
  });

  it("jumps to a visited step from the stepper but not to an unvisited one", () => {
    load().open();
    (doc.getElementById("nd-next") as HTMLElement).click();
    (doc.getElementById("nd-next") as HTMLElement).click();
    expect(activeStep()).toBe("3");
    (doc.querySelector('#nd-stepper .stepper-step[data-step="1"]') as HTMLElement).click();
    expect(activeStep()).toBe("1");
    // Step 5 was never reached, so it isn't clickable and the click is inert.
    (doc.querySelector('#nd-stepper .stepper-step[data-step="5"]') as HTMLElement).click();
    expect(activeStep()).toBe("1");
  });

  it("marks visited steps clickable and earlier ones done", () => {
    load().open();
    (doc.getElementById("nd-next") as HTMLElement).click();
    const step1 = doc.querySelector('#nd-stepper .stepper-step[data-step="1"]')!;
    expect(step1.classList.contains("done")).toBe(true);
    expect(step1.classList.contains("clickable")).toBe(true);
    expect(doc.querySelector('#nd-stepper .stepper-line[data-line="1"]')!.classList.contains("done")).toBe(true);
  });

  it("unlocks every step when editing a saved discovery", () => {
    const D = load();
    D.open({ id: "s1", name: "Ashfield mgmt", targets: [], methods: [] });
    // visited = last step, so the summary is reachable in one click.
    (doc.querySelector(`#nd-stepper .stepper-step[data-step="${D.STEPS.length}"]`) as HTMLElement).click();
    expect(activeStep()).toBe(String(D.STEPS.length));
  });

  it("titles the modal by mode", () => {
    const title = () => doc.querySelector(".modal-header h3")!.textContent;
    load().open();
    expect(title()).toBe("New discovery");
    load().open({ id: "s1", name: "x" });
    expect(title()).toBe("Edit discovery");
    load().open({ name: "x" }, { import: true });
    expect(title()).toBe("Imported discovery");
  });

  it("treats an import as a create — it must not carry the source id", () => {
    load().open({ id: "from-another-install", name: "x" }, { import: true });
    // An import saves as a CREATE, so the title is the tell that `editing` is
    // null; the id is dropped so a save can't overwrite an unrelated row.
    expect(doc.querySelector(".modal-header h3")!.textContent).toBe("Imported discovery");
  });

  it("does not mutate the row it was opened with", () => {
    const row = { id: "s1", name: "Ashfield mgmt", targets: [{ kind: "cidr", value: "10.0.0.0/24" }], methods: [] };
    const before = JSON.stringify(row);
    load().open(row);
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe("PolarisAssetDiscovery — permission gating", () => {
  it("omits Save entirely for a read-level caller", () => {
    const D = load({ scan: "read" });
    D.open({ id: "s1", name: "x" });
    expect(doc.getElementById("nd-save")).toBeNull();
    // …and the walkthrough still works, so the operator can read the config.
    (doc.getElementById("nd-next") as HTMLElement).click();
    expect(activeStep()).toBe("2");
  });

  it("renders Save for a write-level caller", () => {
    load({ scan: "write" }).open({ id: "s1", name: "x" });
    expect(doc.getElementById("nd-save")).toBeTruthy();
  });

  it("syncing the footer never throws when Save is absent", () => {
    const D = load({ scan: "read" });
    D.open();
    for (let i = 1; i < D.STEPS.length; i++) (doc.getElementById("nd-next") as HTMLElement).click();
    expect(activeStep()).toBe(String(D.STEPS.length));
  });
});

describe("PolarisAssetDiscovery — cancel", () => {
  it("closes the modal", () => {
    load().open();
    (doc.getElementById("nd-cancel") as HTMLElement).click();
    expect(doc.getElementById("modal-overlay")).toBeNull();
  });
});
