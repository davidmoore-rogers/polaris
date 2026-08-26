/**
 * tests/unit/userAccountMenu.test.ts — the page-header account menu
 * (`openUserMenu` in public/js/app.js).
 *
 * Push enrollment, two-factor enrollment and logout live behind the user
 * badge, which means a regression here doesn't misalign a button — it removes
 * the only way to log out from every page at once. The theme toggle is NOT
 * here: it sits at the bottom of the sidebar (see sidebarThemeToggleDom).
 *
 * openUserMenu is pulled out of app.js rather than evaluating the whole file
 * (119 KB with polling loops that would fire here); everything it reaches for
 * is stubbed, so what's pinned is the item set it hands showRowMenu.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");

function extractFn(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  let depth = 0;
  let i = APP_JS.indexOf("{", start);
  for (; i < APP_JS.length; i++) {
    if (APP_JS[i] === "{") depth++;
    else if (APP_JS[i] === "}") { depth--; if (depth === 0) break; }
  }
  return APP_JS.slice(start, i + 1);
}

interface Item {
  label?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

function open(opts: { push?: Item | null; totp?: Item | null } = {}) {
  const captured: { items: Item[]; opts: Record<string, unknown>; anchor: unknown } =
    { items: [], opts: {}, anchor: null };
  const fetches: string[] = [];

  const g = globalThis as Record<string, unknown>;
  g.showRowMenu = (anchor: unknown, items: Item[], o: Record<string, unknown>) => {
    captured.anchor = anchor; captured.items = items; captured.opts = o;
  };
  g._pushMenuItem = () => (opts.push === undefined ? null : opts.push);
  g._totpMenuItem = () => (opts.totp === undefined ? null : opts.totp);
  g._csrfHeaders = () => ({ "x-csrf-token": "t" });
  g.ICONS = { logout: "<svg id='logout'/>", bell: "<svg id='bell'/>", shield: "<svg id='shield'/>" };
  g.fetch = vi.fn((url: string) => { fetches.push(url); return Promise.resolve({}); });

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const openUserMenu = new Function(extractFn("openUserMenu") + "\nreturn openUserMenu;")() as (a: unknown) => void;
  openUserMenu({ id: "badge" });
  return { ...captured, fetches, labels: captured.items.map((i) => (i.separator ? "—" : i.label)) };
}

describe("openUserMenu", () => {
  it("offers logout even when nothing conditional is available", () => {
    // Push (browser support / alerts:read / a configured channel) and 2FA
    // (local accounts only) are both conditional. Logout is not — losing it
    // would strand the user. With neither, there is nothing for a separator
    // to separate, so the menu is Logout alone.
    expect(open().labels).toEqual(["Logout"]);
  });

  it("carries no theme row — the toggle lives in the sidebar", () => {
    const r = open({ push: { label: "Enable push", icon: "<svg/>", onSelect: () => {} } });
    expect(r.labels).not.toContain("Light Mode");
    expect(r.labels).not.toContain("Dark Mode");
  });

  it("slots the push row above the logout separator", () => {
    const r = open({ push: { label: "Enable push", icon: "<svg/>", onSelect: () => {} } });
    expect(r.labels).toEqual(["Enable push", "—", "Logout"]);
  });

  it("slots the two-factor row after push, still above the separator", () => {
    const r = open({
      push: { label: "Enable push", icon: "<svg/>", onSelect: () => {} },
      totp: { label: "Set up two-factor auth", icon: "<svg/>", onSelect: () => {} },
    });
    expect(r.labels).toEqual(["Enable push", "Set up two-factor auth", "—", "Logout"]);
  });

  it("omits the two-factor row for an SSO account without disturbing the rest", () => {
    const r = open({ push: { label: "Enable push", icon: "<svg/>", onSelect: () => {} }, totp: null });
    expect(r.labels).toEqual(["Enable push", "—", "Logout"]);
  });

  it("marks logout destructive and gives every row an icon", () => {
    const r = open({
      push: { label: "Enable push", icon: "<svg/>", onSelect: () => {} },
      totp: { label: "Set up two-factor auth", icon: "<svg/>", onSelect: () => {} },
    });
    const logout = r.items[r.items.length - 1];
    expect(logout.danger).toBe(true);
    expect(r.items.filter((i) => !i.separator).every((i) => Boolean(i.icon))).toBe(true);
  });

  it("right-aligns under its trigger — the badge sits at the page's right edge", () => {
    const r = open();
    expect(r.opts.align).toBe("end");
    expect(r.opts.label).toBe("Account menu");
  });

  it("POSTs the logout before leaving", () => {
    const r = open();
    r.items[r.items.length - 1].onSelect!();
    expect(r.fetches).toEqual(["/api/v1/auth/logout"]);
  });
});
