/**
 * tests/unit/userAccountMenu.test.ts — the page-header account menu
 * (`openUserMenu` in public/js/app.js).
 *
 * Theme, push enrollment and logout used to be three always-visible controls
 * at the bottom of the sidebar. They now live behind the user badge, which
 * means a regression here doesn't misalign a button — it removes the only way
 * to log out or switch themes from every page at once.
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

function open(opts: { theme?: string; push?: Item | null } = {}) {
  const captured: { items: Item[]; opts: Record<string, unknown>; anchor: unknown } =
    { items: [], opts: {}, anchor: null };
  const themeWrites: string[] = [];
  const fetches: string[] = [];

  const g = globalThis as Record<string, unknown>;
  g.showRowMenu = (anchor: unknown, items: Item[], o: Record<string, unknown>) => {
    captured.anchor = anchor; captured.items = items; captured.opts = o;
  };
  g._getCurrentTheme = () => opts.theme ?? "dark";
  g._setTheme = (t: string) => { themeWrites.push(t); };
  g._sunIcon = () => "<svg id='sun'/>";
  g._moonIcon = () => "<svg id='moon'/>";
  g._pushMenuItem = () => (opts.push === undefined ? null : opts.push);
  g._csrfHeaders = () => ({ "x-csrf-token": "t" });
  g.ICONS = { logout: "<svg id='logout'/>", bell: "<svg id='bell'/>" };
  g.fetch = vi.fn((url: string) => { fetches.push(url); return Promise.resolve({}); });

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const openUserMenu = new Function(extractFn("openUserMenu") + "\nreturn openUserMenu;")() as (a: unknown) => void;
  openUserMenu({ id: "badge" });
  return { ...captured, themeWrites, fetches, labels: captured.items.map((i) => (i.separator ? "—" : i.label)) };
}

describe("openUserMenu", () => {
  it("offers theme and logout even when push isn't available", () => {
    // Push is conditional (browser support / alerts:read / a configured
    // channel). The other two are not — losing them would strand the user.
    expect(open().labels).toEqual(["Light Mode", "—", "Logout"]);
  });

  it("names the theme it will switch TO, not the one in effect", () => {
    expect(open({ theme: "dark" }).labels[0]).toBe("Light Mode");
    expect(open({ theme: "light" }).labels[0]).toBe("Dark Mode");
  });

  it("switches the theme to the opposite of the current one", () => {
    const dark = open({ theme: "dark" });
    dark.items[0].onSelect!();
    expect(dark.themeWrites).toEqual(["light"]);

    const light = open({ theme: "light" });
    light.items[0].onSelect!();
    expect(light.themeWrites).toEqual(["dark"]);
  });

  it("slots the push row between theme and the logout separator", () => {
    const r = open({ push: { label: "Enable push", icon: "<svg/>", onSelect: () => {} } });
    expect(r.labels).toEqual(["Light Mode", "Enable push", "—", "Logout"]);
  });

  it("marks logout destructive and gives every row an icon", () => {
    const r = open({ push: { label: "Enable push", icon: "<svg/>", onSelect: () => {} } });
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
