/**
 * tests/unit/sidebarPushToggleDom.test.ts
 *
 * The sidebar's push toggle exists to fix a permission mismatch: the push
 * routes gate on alerts:read ("any viewer may opt into push"), but the only
 * control used to live on /automations.html, which is page-gated
 * automationManagement:read. A role with alerts and no automation management
 * therefore could not enroll at all.
 *
 * wirePushToggle is exercised directly against its markup rather than by
 * evaluating all of app.js (119 KB with polling loops that would fire here).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");

/** Pull just wirePushToggle out of app.js so we don't boot the whole page. */
function extractFn(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  let depth = 0;
  let i = APP_JS.indexOf("{", start);
  const open = i;
  for (; i < APP_JS.length; i++) {
    if (APP_JS[i] === "{") depth++;
    else if (APP_JS[i] === "}") { depth--; if (depth === 0) break; }
  }
  return APP_JS.slice(start, i + 1) + `\nreturn ${name};`;
}

const SRC = extractFn("wirePushToggle");

const MARKUP = `
  <div id="push-toggle-wrap" style="display:none">
    <button id="btn-push-toggle"><span id="btn-push-label">Push notifications</span></button>
  </div>`;

type Status = { enabledOnServer: boolean; permission: string; subscribed: boolean; supported: boolean };

async function run(opts: {
  status?: Partial<Status>;
  perm?: string;          // caller's alerts level
  supported?: boolean;
}) {
  document.body.innerHTML = MARKUP;
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
  const fn = new Function(SRC)();
  fn();
  await new Promise((r) => setTimeout(r, 0));
  return { calls, polarisPush };
}

const wrap = () => document.getElementById("push-toggle-wrap")!;
const btn = () => document.getElementById("btn-push-toggle") as HTMLButtonElement;
const label = () => document.getElementById("btn-push-label")!.textContent;
const shown = () => wrap().style.display !== "none";

beforeEach(() => { document.body.innerHTML = ""; });

describe("permission gate", () => {
  it("shows for a role with alerts:read and NO automationManagement", async () => {
    // The whole point: this role can't reach /automations.html, where the only
    // enrollment control used to live.
    await run({ perm: "read" });
    expect(shown()).toBe(true);
    expect(label()).toBe("Enable push");
  });

  it("stays hidden for alerts:none", async () => {
    await run({ perm: "none" });
    expect(shown()).toBe(false);
  });
});

describe("visibility", () => {
  it("stays hidden when the browser doesn't support push", async () => {
    await run({ supported: false });
    expect(shown()).toBe(false);
  });

  it("stays hidden when the server has no Web Push channel", async () => {
    await run({ status: { enabledOnServer: false } });
    expect(shown()).toBe(false);
  });

  it("shows a disabled control when permission is blocked", async () => {
    await run({ status: { permission: "denied" } });
    expect(shown()).toBe(true);
    expect(btn().disabled).toBe(true);
    expect(label()).toMatch(/blocked/i);
  });
});

describe("enrollment", () => {
  it("enables with surface=desktop", async () => {
    const { calls } = await run({});
    btn().click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("enable:desktop");
  });

  it("disables when already subscribed", async () => {
    const { calls } = await run({ status: { subscribed: true, permission: "granted" } });
    expect(label()).toBe("Disable push");
    btn().click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("disable");
  });

  it("does not await status() inside the click handler", async () => {
    // Awaiting burns the click's user activation; Safari then refuses the prompt.
    const { polarisPush } = await run({});
    const before = polarisPush.status.mock.calls.length;
    btn().click();
    expect(polarisPush.status.mock.calls.length).toBe(before);
  });

  it("ignores clicks while blocked", async () => {
    const { calls } = await run({ status: { permission: "denied" } });
    btn().click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.startsWith("enable"))).toHaveLength(0);
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
