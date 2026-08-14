/**
 * tests/unit/rowContextMenu.test.ts — the shared row context menu
 * (`showRowMenu` / `closeRowMenu` in public/js/app.js).
 *
 * The list pages moved their per-row verbs out of an Actions column and behind
 * the row's name, so this one helper is now the ONLY way to reach Edit, Clone,
 * Delete on Automations and Open, Edit, Delete on IPAM's Blocks and Networks.
 * A regression here doesn't degrade a page, it removes every per-row action
 * from three tables at once — hence the coverage.
 *
 * app.js is a classic browser script, so it's eval'd into a happy-dom Window.
 * Positioning is NOT asserted: happy-dom reports zero-size rects for everything,
 * so getBoundingClientRect-driven placement can only be checked in a real
 * browser. What's pinned here is behaviour that doesn't depend on layout —
 * which items render, which are reachable, and every path that closes the menu.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const APP_SRC = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");

interface MenuItem {
  label?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  separator?: boolean;
  heading?: string;
}

let win: InstanceType<typeof Window>;
let doc: Window["document"];
let showRowMenu: (anchor: unknown, items: MenuItem[], opts?: unknown) => void;
let closeRowMenu: (opts?: unknown) => void;
let anchor: HTMLElement;

/** Fresh document + a fresh eval of app.js, so menu state can't leak between tests. */
beforeEach(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  g.api = {};
  g.escapeHtml = (s: unknown) => String(s ?? "");

  doc.body.innerHTML = '<table><tbody><tr><td><button id="anchor">Row name</button></td></tr></tbody></table>';
  try { (0, eval)(APP_SRC); } catch (_e) { /* app.js boot wiring touches page-specific DOM */ }

  showRowMenu = (win as unknown as { showRowMenu: typeof showRowMenu }).showRowMenu;
  closeRowMenu = (win as unknown as { closeRowMenu: typeof closeRowMenu }).closeRowMenu;
  anchor = doc.querySelector("#anchor") as unknown as HTMLElement;
  expect(typeof showRowMenu, "app.js no longer exports showRowMenu").toBe("function");
});

function menu() { return doc.querySelector(".row-context-menu"); }
function itemLabels() {
  return Array.from(doc.querySelectorAll(".row-context-menu button")).map((b) => b.textContent);
}

describe("showRowMenu — rendering", () => {
  it("renders one button per action, in order", () => {
    showRowMenu(anchor, [
      { label: "Open", onSelect: () => {} },
      { label: "Edit", onSelect: () => {} },
      { label: "Delete", onSelect: () => {} },
    ]);
    expect(menu()).toBeTruthy();
    expect(itemLabels()).toEqual(["Open", "Edit", "Delete"]);
  });

  it("renders separators and headings without turning them into actions", () => {
    showRowMenu(anchor, [
      { heading: "Manage" },
      { label: "Edit", onSelect: () => {} },
      { separator: true },
      { label: "Delete", onSelect: () => {}, danger: true },
    ]);
    expect(itemLabels()).toEqual(["Edit", "Delete"]);
    expect(doc.querySelectorAll(".row-context-menu .dropdown-divider").length).toBe(1);
    expect(doc.querySelector(".row-context-menu .dropdown-heading")!.textContent).toBe("Manage");
  });

  it("marks a danger item so Delete reads as destructive", () => {
    showRowMenu(anchor, [{ label: "Delete", onSelect: () => {}, danger: true }]);
    expect(doc.querySelector(".row-context-menu button")!.classList.contains("danger")).toBe(true);
  });

  it("carries an item's title through as the button tooltip", () => {
    showRowMenu(anchor, [{ label: "Clone", onSelect: () => {}, title: "Create a disabled copy" }]);
    expect(doc.querySelector(".row-context-menu button")!.getAttribute("title")).toBe("Create a disabled copy");
  });

  it("is a menu for assistive tech, and marks the anchor expanded", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }], { label: "Actions for Row name" });
    expect(menu()!.getAttribute("role")).toBe("menu");
    expect(menu()!.getAttribute("aria-label")).toBe("Actions for Row name");
    expect(doc.querySelector(".row-context-menu button")!.getAttribute("role")).toBe("menuitem");
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders nothing for an empty or missing item list", () => {
    showRowMenu(anchor, []);
    expect(menu()).toBeFalsy();
    showRowMenu(null, [{ label: "Open", onSelect: () => {} }]);
    expect(menu()).toBeFalsy();
  });

  it("mounts on <body>, not in the row — table wrappers clip overflow", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    expect(menu()!.parentElement!.tagName).toBe("BODY");
  });
});

describe("showRowMenu — activation", () => {
  it("runs the item's handler and closes first, so a modal isn't covered", () => {
    const order: string[] = [];
    showRowMenu(anchor, [{
      label: "Edit",
      onSelect: () => { order.push(menu() ? "menu-still-open" : "menu-closed"); },
    }]);
    (doc.querySelector(".row-context-menu button") as unknown as { click: () => void }).click();
    expect(order).toEqual(["menu-closed"]);
    expect(menu()).toBeFalsy();
  });

  it("a disabled item is inert and not focusable", () => {
    let ran = false;
    showRowMenu(anchor, [{ label: "Delete", onSelect: () => { ran = true; }, disabled: true }]);
    const b = doc.querySelector(".row-context-menu button") as unknown as { click: () => void; disabled: boolean };
    expect(b.disabled).toBe(true);
    b.click();
    expect(ran).toBe(false);
  });

  it("a throwing handler doesn't leave the menu on screen", () => {
    showRowMenu(anchor, [{ label: "Edit", onSelect: () => { throw new Error("boom"); } }]);
    (doc.querySelector(".row-context-menu button") as unknown as { click: () => void }).click();
    expect(menu()).toBeFalsy();
  });
});

describe("showRowMenu — dismissal", () => {
  it("closes on Escape", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu()).toBeFalsy();
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a pointerdown outside itself", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    doc.body.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    expect(menu()).toBeFalsy();
  });

  it("stays open on a pointerdown inside itself", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    doc.querySelector(".row-context-menu")!.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    expect(menu()).toBeTruthy();
  });

  it("closes on scroll — it is fixed and cannot follow its anchor", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    win.dispatchEvent(new win.Event("scroll"));
    expect(menu()).toBeFalsy();
  });

  it("closes on resize", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    win.dispatchEvent(new win.Event("resize"));
    expect(menu()).toBeFalsy();
  });

  it("a second click on the same anchor toggles it shut instead of stacking", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    expect(doc.querySelectorAll(".row-context-menu").length).toBe(0);
  });

  it("opening from a different anchor replaces the open menu", () => {
    const other = doc.createElement("button");
    doc.body.appendChild(other);
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    showRowMenu(other, [{ label: "Edit", onSelect: () => {} }]);
    expect(doc.querySelectorAll(".row-context-menu").length).toBe(1);
    expect(itemLabels()).toEqual(["Edit"]);
    // The anchor that lost the menu must not be left claiming it's expanded.
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
  });

  it("closeRowMenu is safe when nothing is open", () => {
    expect(() => closeRowMenu()).not.toThrow();
  });

  it("removes its listeners on close — a later scroll can't throw", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    closeRowMenu();
    expect(() => win.dispatchEvent(new win.Event("scroll"))).not.toThrow();
    expect(menu()).toBeFalsy();
  });
});
