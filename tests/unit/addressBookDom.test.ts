/**
 * tests/unit/addressBookDom.test.ts — DOM smoke for the address book
 * (public/js/automations-address-book.js).
 *
 * The module is a plain browser script, so this loads it via eval into a
 * happy-dom Window with the app-shell globals stubbed — the same idiom as
 * assetsFiltersDom.test.ts. It covers the wiring no server test can see:
 *
 *   - the tab table, and the Edit/Delete affordances appearing ONLY on rows the
 *     ownership dimension lets this caller touch (the client mirror of
 *     assertOwnership — if this drifts, operators get buttons that 403);
 *   - the STACKED-OVERLAY contract, which is the whole reason this module
 *     doesn't call openModal: the picker/editor must build their own overlay at
 *     a z-index above the base modal, or opening one from the automation wizard
 *     destroys the wizard's form DOM;
 *   - the picker returning the field it was opened from alongside the chosen
 *     entries, so the caller knows whether they land in To, Cc or Bcc.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let win: InstanceType<typeof Window>;

let contacts: Record<string, unknown>[];
let searchEntries: Record<string, unknown>[];
let deleted: string[];
let created: Record<string, unknown>[];
let toasts: string[];
let confirmAnswer = true;
let level = "fullwrite";

const PAGE_HTML = '<div id="contacts-list"></div>';

/** Let the module's awaited fetch + render settle. */
function flush(times = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

function click(el: unknown) {
  (el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(new win.Event("click", { bubbles: true }));
}

/** The topmost standalone overlay this module appended (never #modal-overlay). */
function overlays() {
  return Array.from(doc.body.querySelectorAll(".modal-overlay"));
}

beforeAll(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);

  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  g.showToast = (msg: string) => { toasts.push(msg); };
  g.showConfirm = async () => confirmAnswer;
  // Mirrors the server ladder: read < write < fullwrite.
  g.permAtLeast = (_key: string, want: string) => {
    const rank: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };
    return rank[level] >= rank[want];
  };
  g._trapFocus = () => () => {};
  g._focusFirstIn = () => {};
  g.currentUsername = "alice";
  (win as unknown as Record<string, unknown>).currentUsername = "alice";
  g.collectTagCriteria = () => null;

  g.api = {
    contacts: {
      list: async () => ({ contacts }),
      search: async () => ({ entries: searchEntries }),
      preview: async () => ({ matchCount: 0, sample: [] }),
      create: async (body: Record<string, unknown>) => { created.push(body); return { contact: { id: "new", ...body } }; },
      update: async (_id: string, body: Record<string, unknown>) => ({ contact: { id: _id, ...body } }),
      delete: async (id: string) => { deleted.push(id); },
    },
    assetTypes: { list: async () => ({ assetTypes: [] }) },
    assets: { list: async () => ({ assets: [] }) },
  };

  doc.body.innerHTML = PAGE_HTML;
  const src = readFileSync(resolve(__dirname, "../../public/js/automations-address-book.js"), "utf8");
  (0, eval)(src);
});

beforeEach(() => {
  deleted = [];
  created = [];
  toasts = [];
  confirmAnswer = true;
  level = "fullwrite";
  contacts = [
    { id: "c1", email: "mine@example.com", name: "Mine", description: "d1", assetCriteria: null, assetIds: [], createdBy: "alice" },
    { id: "c2", email: "theirs@example.com", name: "Theirs", description: "d2", assetCriteria: { version: 1, match: "all", rules: [{ field: "hostname", op: "contains", values: ["prod"] }] }, assetIds: ["a1", "a2"], createdBy: "bob" },
  ];
  searchEntries = [
    { source: "user", id: "u1", email: "jane@example.com", name: "Jane Doe", description: "Polaris user account", kind: "person" },
    { source: "contact", id: "c1", email: "mine@example.com", name: "Mine", description: "d1", kind: "person", owned: true },
  ];
  overlays().forEach((o) => o.remove());
  doc.body.innerHTML = PAGE_HTML;
});

describe("renderTab", () => {
  it("renders one row per contact with a device summary", async () => {
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    const rows = doc.querySelectorAll("#contacts-list tbody tr");
    expect(rows).toHaveLength(2);
    const text = (doc.getElementById("contacts-list") as unknown as { textContent: string }).textContent;
    expect(text).toContain("mine@example.com");
    // Criteria + pins are summarized rather than dumped.
    expect(text).toContain("1 filter rule + 2 pinned devices");
  });

  it("shows an empty state rather than a bare table", async () => {
    contacts = [];
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    expect((doc.getElementById("contacts-list") as unknown as { textContent: string }).textContent)
      .toMatch(/no contacts yet/i);
  });

  it("at fullwrite offers Edit/Delete on EVERY row", async () => {
    level = "fullwrite";
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    expect(doc.querySelectorAll("[data-ab-edit]")).toHaveLength(2);
    expect(doc.querySelectorAll("[data-ab-del]")).toHaveLength(2);
  });

  it("at write offers them ONLY on rows the caller created", async () => {
    // The client mirror of assertOwnership — a button here that 403s there is
    // the failure this guards.
    level = "write";
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    const edits = Array.from(doc.querySelectorAll("[data-ab-edit]"));
    expect(edits).toHaveLength(1);
    expect((edits[0] as unknown as { getAttribute: (a: string) => string }).getAttribute("data-ab-edit")).toBe("c1");
  });

  it("at read offers neither", async () => {
    level = "read";
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    expect(doc.querySelectorAll("[data-ab-edit]")).toHaveLength(0);
    expect(doc.querySelectorAll("[data-ab-del]")).toHaveLength(0);
  });

  it("deletes behind a confirm, and not when it is declined", async () => {
    const AB = (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook;
    await AB.renderTab();
    await flush();

    confirmAnswer = false;
    click(doc.querySelector('[data-ab-del="c1"]'));
    await flush();
    expect(deleted).toEqual([]);

    confirmAnswer = true;
    click(doc.querySelector('[data-ab-del="c1"]'));
    await flush();
    expect(deleted).toEqual(["c1"]);
  });
});

describe("stacked overlay contract", () => {
  it("the picker builds its OWN overlay above the base modal layer", async () => {
    // openModal reuses one shared #modal-overlay and overwrites its body, so a
    // picker opened from the wizard must never go through it.
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "cc" });
    await flush();

    const o = overlays();
    expect(o).toHaveLength(1);
    expect((o[0] as unknown as { id: string }).id).not.toBe("modal-overlay");
    expect(Number((o[0] as unknown as { style: { zIndex: string } }).style.zIndex)).toBeGreaterThanOrEqual(1300);
  });

  it("the editor stacks ABOVE the picker so both stay usable", async () => {
    const AB = (window as unknown as {
      PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> };
    }).PolarisAddressBook;
    AB.openPicker({ field: "to" });
    await flush();
    click(doc.querySelector('[data-ab="new"]'));
    await flush();

    const z = overlays().map((o) => Number((o as unknown as { style: { zIndex: string } }).style.zIndex));
    expect(z).toHaveLength(2);
    expect(Math.max(...z)).toBeGreaterThan(Math.min(...z));
  });

  it("highlights the field it was opened from without hiding the others", async () => {
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "bcc" });
    await flush();
    const bcc = doc.querySelector('[data-ab="add-bcc"]') as unknown as { className: string };
    const to = doc.querySelector('[data-ab="add-to"]') as unknown as { className: string };
    expect(bcc.className).toContain("btn-primary");
    expect(to.className).toContain("btn-secondary");
  });
});

describe("picker selection", () => {
  it("resolves the chosen entries with the field the operator dropped them into", async () => {
    const p = (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush();

    const cb = doc.querySelector('[data-ab-pick="jane@example.com"]') as unknown as {
      checked: boolean; dispatchEvent: (e: unknown) => void;
    };
    cb.checked = true;
    cb.dispatchEvent(new win.Event("change", { bubbles: true }));

    // Opened from To, but the operator chose Cc — the result must follow the
    // button, not the origin.
    click(doc.querySelector('[data-ab="add-cc"]'));
    await flush();

    const res = (await p) as { field: string; entries: Array<{ email: string }> };
    expect(res.field).toBe("cc");
    expect(res.entries.map((e) => e.email)).toEqual(["jane@example.com"]);
  });

  it("refuses an empty selection with a toast instead of resolving nothing", async () => {
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush();
    click(doc.querySelector('[data-ab="add-to"]'));
    await flush();
    expect(toasts.join(" ")).toMatch(/select at least one/i);
    expect(overlays()).toHaveLength(1); // still open
  });

  it("resolves null when dismissed", async () => {
    const p = (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush();
    click(doc.querySelector(".modal-close"));
    await flush();
    expect(await p).toBeNull();
  });
});
