/**
 * tests/unit/mobileAlertsAckDom.test.ts
 *
 * The mobile Alerts sub-page (#more/alerts) — the surface a web push actually
 * lands on. It was read-only, which meant the person holding the pager could
 * see the alert but not stop an escalation chain set to stopOn:"acknowledge".
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "more-tab.js"), "utf-8");

const g = globalThis as any;

const ALERTS = [
  { id: "n1", severity: "critical", message: "packet loss at 93.8%", assetId: "a1", assetHostname: "BULLITT-222E-4", triggeredAt: "2026-08-12T10:00:00Z", acknowledged: false },
  { id: "n2", severity: "warning", message: "cpu high", assetId: null, assetHostname: "sw-2", triggeredAt: "2026-08-12T09:00:00Z", acknowledged: true, acknowledgedBy: "dmoore" },
];

async function render(opts?: { perm?: string; ackFails?: boolean; alerts?: any[] }) {
  document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';
  const snacks: string[] = [];
  const acked: any[] = [];

  g.escapeHtml = (s: any) => String(s ?? "");
  g.timeAgo = () => "just now";
  g._csrfHeaders = () => ({});
  g.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  g.api = {
    alerts: {
      list: vi.fn(async () => ({ notifications: opts?.alerts ?? ALERTS })),
      acknowledge: vi.fn(async (ids: string[], note?: string) => {
        acked.push({ ids, note });
        if (opts?.ackFails) throw new Error("nope");
        // The list re-renders after a successful ack.
        (opts?.alerts ?? ALERTS)[0].acknowledged = true;
        return { acknowledged: 1 };
      }),
    },
  };
  g.PolarisRouter = { go: vi.fn() };
  g.PolarisTabs = { showSnackbar: (m: string) => snacks.push(m) };
  g.PolarisTheme = { get: () => "dark", set: vi.fn() };
  g.PolarisInstall = { isIos: () => false, isFirefox: () => false, isStandalone: () => false, canPrompt: () => false, prompt: vi.fn(), onChange: vi.fn() };
  g.polarisPush = { isSupported: () => false, status: vi.fn(async () => ({ supported: false, enabledOnServer: false, permission: "default", subscribed: false })), enable: vi.fn(), disable: vi.fn() };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  const body = document.getElementById("app-body")!;
  await (g.PolarisMoreTab.spec.render(body, {
    route: { parts: ["alerts"] },
    user: { username: "u", permissions: { alerts: opts?.perm ?? "write" } },
  }) as any);
  await new Promise((r) => setTimeout(r, 0));
  return { body, snacks, acked };
}

const ackButtons = () => Array.from(document.querySelectorAll("[data-ack]")) as HTMLElement[];

beforeEach(() => {
  document.body.innerHTML = "";
  ALERTS[0].acknowledged = false;
});

describe("mobile alerts acknowledge", () => {
  it("offers Ack only on unacknowledged rows", async () => {
    await render();
    expect(ackButtons().map((b) => b.dataset.ack)).toEqual(["n1"]);
  });

  it("names who acknowledged the ones already handled", async () => {
    await render();
    expect(document.body.textContent).toContain("acknowledged by dmoore");
  });

  it("hides the control from a viewer who can only read alerts", async () => {
    await render({ perm: "read" });
    expect(ackButtons()).toHaveLength(0);
    // …but the alert itself is still listed.
    expect(document.body.textContent).toContain("packet loss at 93.8%");
  });

  it("acknowledges and re-renders, without opening the device", async () => {
    const { acked, snacks } = await render();
    ackButtons()[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(acked).toEqual([{ ids: ["n1"], note: undefined }]);
    expect(snacks[0]).toMatch(/acknowledged/i);
    expect(g.PolarisRouter.go).not.toHaveBeenCalled();
    // Re-rendered: the row it acknowledged no longer offers the button.
    expect(ackButtons()).toHaveLength(0);
  });

  it("keeps the Ack button usable when the request fails", async () => {
    const { snacks } = await render({ ackFails: true });
    const btn = ackButtons()[0]!;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(snacks[0]).toBe("nope");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(btn.textContent).toBe("Ack");
  });

  it("keeps the Ack control OUT of the row button (nested buttons swallow the tap)", async () => {
    await render();
    const nested = document.querySelector(".list-item [data-ack]");
    expect(nested).toBeNull();
  });
});
