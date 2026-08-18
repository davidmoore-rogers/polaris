/**
 * tests/unit/sidebarPushToggleDom.test.ts
 *
 * The push enrollment control exists to fix a permission mismatch: the push
 * routes gate on alerts:read ("any viewer may opt into push"), but the only
 * control used to live on /automations.html, which is page-gated
 * automationManagement:read. A role with alerts and no automation management
 * therefore could not enroll at all. The control now lives in the page-header
 * account menu, which — like the sidebar it moved out of — renders everywhere.
 *
 * wirePushToggle + _pushMenuItem + _togglePush are exercised directly rather
 * than by evaluating all of app.js (119 KB with polling loops that would fire
 * here). They share module-level state, so all three are pulled out together.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");

/** Pull one function out of app.js so we don't boot the whole page. */
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

// The three functions close over the same module-level _pushState/_pushBusy,
// so they have to be evaluated in one scope. ICONS is stubbed — _pushMenuItem
// only reads ICONS.bell for the row's glyph.
const SRC = [
  "var _pushState = null, _pushBusy = false;",
  "var ICONS = { bell: '<svg/>' };",
  extractFn("wirePushToggle"),
  extractFn("_pushMenuItem"),
  extractFn("_togglePush"),
  "return { wirePushToggle: wirePushToggle, pushMenuItem: _pushMenuItem };",
].join("\n");

type Status = { enabledOnServer: boolean; permission: string; subscribed: boolean; supported: boolean };
type MenuItem = { label: string; icon?: string; disabled?: boolean; title?: string; onSelect?: () => void } | null;

async function run(opts: {
  status?: Partial<Status>;
  perm?: string;          // caller's alerts level
  supported?: boolean;
}) {
  const calls: string[] = [];
  const status: Status = { supported: true, enabledOnServer: true, permission: "default", subscribed: false, ...opts.status } as Status;

  const polarisPush = {
    isSupported: () => opts.supported !== false,
    status: vi.fn(async () => status),
    enable: vi.fn(async (o: any) => { calls.push("enable:" + (o && o.surface)); }),
    disable: vi.fn(async () => { calls.push("disable"); }),
    registerSW: vi.fn(async () => { calls.push("registerSW"); return {}; }),
    reconcileSubscription: vi.fn(async (s: string) => { calls.push("reconcile:" + s); return true; }),
  };

  const RANK: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };

  // app.js reads these as GLOBALS (and guards on `window.polarisPush`), so
  // they must live on globalThis — passing them as parameters would satisfy
  // the bare references while leaving the window.* guard undefined.
  const g = globalThis as any;
  g.polarisPush = polarisPush;
  g.permAtLeast = (_key: string, level: string) => RANK[opts.perm ?? "read"] >= RANK[level];
  g.showToast = () => {};

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const mod = new Function(SRC)() as { wirePushToggle: () => void; pushMenuItem: () => MenuItem };
  mod.wirePushToggle();
  await new Promise((r) => setTimeout(r, 0));
  return { calls, polarisPush, item: () => mod.pushMenuItem() };
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("permission gate", () => {
  it("offers the row for a role with alerts:read and NO automationManagement", async () => {
    // The whole point: this role can't reach /automations.html, where the only
    // enrollment control used to live.
    const { item } = await run({ perm: "read" });
    expect(item()?.label).toBe("Enable push");
  });

  it("omits the row for alerts:none", async () => {
    const { item } = await run({ perm: "none" });
    expect(item()).toBeNull();
  });
});

describe("visibility", () => {
  it("omits the row when the browser doesn't support push", async () => {
    const { item } = await run({ supported: false });
    expect(item()).toBeNull();
  });

  it("omits the row when the server has no Web Push channel", async () => {
    const { item } = await run({ status: { enabledOnServer: false } });
    expect(item()).toBeNull();
  });

  it("shows a disabled row when permission is blocked", async () => {
    const { item } = await run({ status: { permission: "denied" } });
    expect(item()?.disabled).toBe(true);
    expect(item()?.label).toMatch(/blocked/i);
  });
});

describe("enrollment", () => {
  it("enables with surface=desktop", async () => {
    const { calls, item } = await run({});
    item()!.onSelect!();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("enable:desktop");
  });

  it("disables when already subscribed", async () => {
    const { calls, item } = await run({ status: { subscribed: true, permission: "granted" } });
    expect(item()?.label).toBe("Disable push");
    item()!.onSelect!();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("disable");
  });

  it("does not await status() inside the select handler", async () => {
    // Awaiting burns the click's user activation; Safari then refuses the prompt.
    const { polarisPush, item } = await run({});
    const before = polarisPush.status.mock.calls.length;
    item()!.onSelect!();
    expect(polarisPush.status.mock.calls.length).toBe(before);
  });

  it("gives a blocked row no action to run", async () => {
    const { item } = await run({ status: { permission: "denied" } });
    expect(item()?.onSelect).toBeUndefined();
  });
});

describe("service worker registration", () => {
  it("registers and reconciles on every page, not just on toggle", async () => {
    // This is what makes push work for someone who never opens Automations.
    const { calls } = await run({});
    expect(calls).toContain("registerSW");
    expect(calls).toContain("reconcile:desktop");
  });
});
