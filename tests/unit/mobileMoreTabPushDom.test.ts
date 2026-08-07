/**
 * tests/unit/mobileMoreTabPushDom.test.ts
 *
 * The More tab's Notifications row. Six states, and getting them wrong is
 * user-visible in bad ways: the iOS state in particular is what stops the tab
 * from offering an Enable button that can only ever throw (iOS grants Web Push
 * only to an installed home-screen app, but `"PushManager" in window` is true
 * in plain Safari from 16.4).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "more-tab.js"), "utf-8");

type Status = { supported: boolean; enabledOnServer: boolean; permission: string; subscribed: boolean };

interface Ctx {
  status: Status;
  supported: boolean;
  ios: boolean;
  standalone: boolean;
  canPrompt: boolean;
}

const g = globalThis as any;

async function render(ctx: Partial<Ctx>) {
  const c: Ctx = {
    status: { supported: true, enabledOnServer: true, permission: "default", subscribed: false },
    supported: true, ios: false, standalone: false, canPrompt: false,
    ...ctx,
  } as Ctx;

  document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';

  const calls: string[] = [];
  const snacks: string[] = [];
  const routed: string[] = [];

  g.escapeHtml = (s: any) => String(s ?? "");
  g.timeAgo = () => "just now";
  g._csrfHeaders = () => ({});
  g.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  g.api = { alerts: { list: vi.fn(async () => ({ notifications: [] })) } };
  g.PolarisRouter = { go: (r: string) => routed.push(r) };
  g.PolarisTabs = { showSnackbar: (m: string) => snacks.push(m) };
  g.PolarisTheme = { get: () => "dark", set: vi.fn() };
  g.PolarisInstall = {
    isIos: () => c.ios,
    isStandalone: () => c.standalone,
    canPrompt: () => c.canPrompt,
    prompt: vi.fn(async () => { calls.push("install.prompt"); return "accepted"; }),
    onChange: vi.fn(),
  };
  g.polarisPush = {
    isSupported: () => c.supported,
    status: vi.fn(async () => c.status),
    enable: vi.fn(async (o: any) => { calls.push("enable:" + (o && o.surface)); }),
    disable: vi.fn(async () => { calls.push("disable"); }),
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  const body = document.getElementById("app-body")!;
  await (g.PolarisMoreTab.spec.render(body, { route: { parts: [] }, user: { username: "u", role: "admin" } }) as any);
  // Let the status() promise chain settle.
  await new Promise((r) => setTimeout(r, 0));
  return { calls, snacks, routed, c };
}

const row = () => document.getElementById("push-toggle-row") as HTMLElement | null;
const label = () => document.getElementById("push-status-label")?.textContent ?? "";
const visible = (el: HTMLElement | null) => !!el && el.style.display !== "none";

beforeEach(() => { document.body.innerHTML = ""; });

describe("push row states", () => {
  it("stays hidden when the browser doesn't support push", async () => {
    await render({ supported: false });
    expect(visible(row())).toBe(false);
  });

  it("stays hidden when the server has no Web Push channel", async () => {
    // Mirrors automations.js: don't offer a button that can only error.
    await render({ status: { supported: true, enabledOnServer: false, permission: "default", subscribed: false } });
    expect(visible(row())).toBe(false);
  });

  it("on iOS outside standalone, points at the install steps instead of enabling", async () => {
    const { routed, calls } = await render({ ios: true, standalone: false });
    expect(visible(row())).toBe(true);
    expect(label()).toMatch(/Add to Home Screen/i);
    row()!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(routed).toContain("more/install");
    expect(calls).not.toContain("enable:mobile"); // would have thrown on iOS
  });

  it("on iOS INSIDE standalone, enables normally", async () => {
    const { calls } = await render({ ios: true, standalone: true });
    expect(label()).toMatch(/tap to turn on/i);
    row()!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("enable:mobile");
  });

  it("reports a sticky denial without re-prompting", async () => {
    const { calls, snacks } = await render({
      status: { supported: true, enabledOnServer: true, permission: "denied", subscribed: false },
    });
    expect(label()).toMatch(/Blocked/i);
    row()!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0);
    expect(snacks[0]).toMatch(/blocked/i);
  });

  it("enables with surface=mobile when off", async () => {
    const { calls } = await render({});
    expect(label()).toMatch(/tap to turn on/i);
    row()!.click();
    await new Promise((r) => setTimeout(r, 0));
    // surface is what routes the push deep link back to the mobile SPA.
    expect(calls).toEqual(["enable:mobile"]);
  });

  it("disables when already on", async () => {
    const { calls } = await render({
      status: { supported: true, enabledOnServer: true, permission: "granted", subscribed: true },
    });
    expect(label()).toMatch(/tap to turn off/i);
    row()!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["disable"]);
  });

  it("does not call status() inside the click handler", async () => {
    // Awaiting there burns the click's user activation and Safari refuses the
    // permission prompt.
    await render({});
    const before = g.polarisPush.status.mock.calls.length;
    row()!.click();
    expect(g.polarisPush.status.mock.calls.length).toBe(before);
  });
});

describe("install row", () => {
  it("is hidden once running standalone", async () => {
    await render({ standalone: true, canPrompt: true });
    expect(visible(document.getElementById("install-row"))).toBe(false);
  });

  it("triggers the native prompt on Android when available", async () => {
    const { calls } = await render({ canPrompt: true });
    const r = document.getElementById("install-row")!;
    expect(visible(r)).toBe(true);
    r.click();
    await new Promise((res) => setTimeout(res, 0));
    expect(calls).toContain("install.prompt");
  });

  it("routes to the manual steps on iOS", async () => {
    const { routed } = await render({ ios: true });
    document.getElementById("install-row")!.click();
    expect(routed).toContain("more/install");
  });

  it("is hidden on a browser that offers no prompt and isn't iOS", async () => {
    await render({ canPrompt: false, ios: false });
    expect(visible(document.getElementById("install-row"))).toBe(false);
  });
});

describe("standalone escape hatch", () => {
  it("opens Desktop view in a real browser tab when installed", async () => {
    // scope "/" means it would otherwise open inside the standalone window —
    // full desktop layout, no address bar, no way back.
    await render({ standalone: true });
    const link = document.querySelector('a[href="/index.html?desktop=1"]') as HTMLAnchorElement;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
  });

  it("navigates in place in a normal browser tab", async () => {
    await render({ standalone: false });
    const link = document.querySelector('a[href="/index.html?desktop=1"]') as HTMLAnchorElement;
    expect(link.getAttribute("target")).toBeNull();
  });
});

describe("alerts sub-page", () => {
  it("is registered, so a push deep link has somewhere to land", async () => {
    await render({});
    document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';
    const body = document.getElementById("app-body")!;
    await (g.PolarisMoreTab.spec.render(body, { route: { parts: ["alerts"] }, user: {} }) as any);
    expect(g.api.alerts.list).toHaveBeenCalled();
    expect(body.innerHTML).toMatch(/No active alerts/);
  });
});
