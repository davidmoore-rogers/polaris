/**
 * tests/unit/serviceWorker.test.ts
 *
 * public/sw.js runs in a worker global with no DOM, so it's evaluated into a
 * fake `self` here and the registered handlers are invoked directly. None of
 * this is reachable from a server test, and a regression here breaks
 * notifications on BOTH surfaces at once (one registration per origin).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "sw.js"), "utf-8");

const ORIGIN = "https://polaris.example.com";

function makeSelf(opts?: { clients?: any[]; cookie?: string | null; fetchFails?: "status" | "throw" }) {
  const handlers: Record<string, (e: any) => void> = {};
  const shown: Array<{ title: string; options: any }> = [];
  const navigated: Array<{ from: string; to: string }> = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const fetches: Array<{ url: string; init: any }> = [];

  const clientList = (opts?.clients ?? []).map((url: string) => ({
    url,
    focus: vi.fn(async () => { focused.push(url); }),
    navigate: vi.fn(async (to: string) => { navigated.push({ from: url, to }); }),
  }));

  const self: any = {
    location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
    addEventListener: (name: string, fn: any) => { handlers[name] = fn; },
    skipWaiting: vi.fn(),
    registration: {
      showNotification: vi.fn(async (title: string, options: any) => { shown.push({ title, options }); }),
      pushManager: { subscribe: vi.fn(async () => null) },
    },
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => clientList),
      openWindow: vi.fn(async (u: string) => { opened.push(u); }),
    },
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    cookieStore: opts?.cookie === null ? undefined : { get: vi.fn(async () => ({ value: opts?.cookie ?? "csrf-token-value" })) },
    fetch: vi.fn(async (url: string, init: any) => {
      fetches.push({ url, init });
      // The acknowledge path must survive both failure shapes: a refusal the
      // server answered (expired/spent/forbidden token) and no answer at all.
      if (opts?.fetchFails === "throw") throw new Error("offline");
      if (opts?.fetchFails === "status") return { ok: false, status: 410, json: async () => ({ ok: false, state: "used" }) };
      return { ok: true, json: async () => ({ enabled: true, publicKey: "dGVzdC12YXBpZC1rZXk" }) };
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("self", "fetch", "URL", "Uint8Array", "Object", "JSON", SRC)(
    self, self.fetch, URL, Uint8Array, Object, JSON,
  );

  return { self, handlers, shown, navigated, opened, focused, fetches, clientList };
}

/** Drive an event handler and await whatever it passed to waitUntil. */
async function fire(handlers: Record<string, any>, name: string, event: any) {
  const waits: Promise<any>[] = [];
  await handlers[name]({ ...event, waitUntil: (p: any) => waits.push(Promise.resolve(p)) });
  await Promise.all(waits);
}

describe("push handler", () => {
  it("shows a branded notification and never references the missing favicon", async () => {
    const h = makeSelf();
    await fire(h.handlers, "push", {
      data: { json: () => ({ title: "[CRITICAL] gw-01", body: "CPU 98%", url: ORIGIN + "/mobile.html#more/alerts", severity: "critical", notificationId: "n1" }) },
    });
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].title).toBe("[CRITICAL] gw-01");
    expect(h.shown[0].options.icon).toBe("/icons/app-192.png");
    // /favicon.ico does not exist in this repo — referencing it is what made
    // every notification render with the browser's default glyph.
    expect(JSON.stringify(h.shown[0].options)).not.toContain("favicon");
    // badge omitted on purpose: Android masks it to a white blob.
    expect(h.shown[0].options.badge).toBeUndefined();
    expect(h.shown[0].options.requireInteraction).toBe(true);
    expect(h.shown[0].options.tag).toBe("n1");
  });

  it("keeps only serious/critical on screen — the old check read a severity the server never sends", async () => {
    // SEVERITIES is a closed enum (notice/informational/warning/serious/
    // critical). sw.js compared against "error", so requireInteraction was
    // dead code and NO alert was ever sticky.
    const loud = makeSelf();
    await fire(loud.handlers, "push", { data: { json: () => ({ title: "t", severity: "serious" }) } });
    expect(loud.shown[0].options.requireInteraction).toBe(true);

    const quiet = makeSelf();
    await fire(quiet.handlers, "push", { data: { json: () => ({ title: "t", severity: "warning" }) } });
    expect(quiet.shown[0].options.requireInteraction).toBe(false);

    const legacy = makeSelf();
    await fire(legacy.handlers, "push", { data: { json: () => ({ title: "t", severity: "error" }) } });
    expect(legacy.shown[0].options.requireInteraction).toBe(false);
  });

  it("survives a non-JSON payload", async () => {
    const h = makeSelf();
    await fire(h.handlers, "push", {
      data: { json: () => { throw new Error("not json"); }, text: () => "plain text" },
    });
    expect(h.shown[0].title).toBe("Polaris");
    expect(h.shown[0].options.body).toBe("plain text");
  });

  it("falls back to the desktop page when the payload carries no url", async () => {
    const h = makeSelf();
    await fire(h.handlers, "push", { data: { json: () => ({ title: "t", body: "b" }) } });
    expect(h.shown[0].options.data.url).toBe("/automations.html");
  });
});

describe("notificationclick", () => {
  it("navigates an open client to the server-chosen deep link", async () => {
    // The server already picked the surface (PushSubscription.surface); the
    // worker must not second-guess it.
    const h = makeSelf({ clients: [ORIGIN + "/mobile.html#assets"] });
    await fire(h.handlers, "notificationclick", {
      notification: { close: vi.fn(), data: { url: ORIGIN + "/mobile.html#more/alerts" } },
    });
    expect(h.navigated).toEqual([{ from: ORIGIN + "/mobile.html#assets", to: ORIGIN + "/mobile.html#more/alerts" }]);
    expect(h.focused).toHaveLength(1);
  });

  it("focuses WITHOUT navigating when the client is already there", async () => {
    // The old code navigated unconditionally, reloading a correct page and
    // throwing away scroll position + in-flight state.
    const target = ORIGIN + "/automations.html";
    const h = makeSelf({ clients: [target] });
    await fire(h.handlers, "notificationclick", {
      notification: { close: vi.fn(), data: { url: target } },
    });
    expect(h.navigated).toHaveLength(0);
    expect(h.focused).toEqual([target]);
  });

  it("resolves a RELATIVE url (POLARIS_PUBLIC_URL unset) against the origin", async () => {
    const h = makeSelf({ clients: [ORIGIN + "/index.html"] });
    await fire(h.handlers, "notificationclick", {
      notification: { close: vi.fn(), data: { url: "/mobile.html#more/alerts" } },
    });
    expect(h.navigated[0].to).toBe(ORIGIN + "/mobile.html#more/alerts");
  });

  it("opens a new window when nothing is open", async () => {
    const h = makeSelf({ clients: [] });
    await fire(h.handlers, "notificationclick", {
      notification: { close: vi.fn(), data: { url: "/mobile.html#more/alerts" } },
    });
    expect(h.opened).toEqual(["/mobile.html#more/alerts"]);
  });
});

describe("acknowledge action", () => {
  const ACK = ORIGIN + "/ack/polaris_ack_tok";
  const ackNotification = (over?: any) => ({
    close: vi.fn(),
    data: { url: ORIGIN + "/automations.html", ackUrl: ACK, notificationId: "n1", ...over },
  });

  it("offers the button only when the recipient got a link", async () => {
    const withLink = makeSelf();
    await fire(withLink.handlers, "push", { data: { json: () => ({ title: "t", ackUrl: ACK, notificationId: "n1" }) } });
    expect(withLink.shown[0].options.actions).toEqual([{ action: "ack", title: "Acknowledge" }]);
    expect(withLink.shown[0].options.data.ackUrl).toBe(ACK);

    // A contact / typed address / unentitled user gets no token, so no button.
    const without = makeSelf();
    await fire(without.handlers, "push", { data: { json: () => ({ title: "t", notificationId: "n1" }) } });
    expect(without.shown[0].options.actions).toBeUndefined();
    expect(without.shown[0].options.data.ackUrl).toBeNull();
  });

  it("POSTs the token with no cookie and no CSRF header, then confirms in place", async () => {
    const h = makeSelf({ clients: [ORIGIN + "/index.html"] });
    await fire(h.handlers, "notificationclick", { action: "ack", notification: ackNotification() });

    const post = h.fetches.find((f) => f.init && f.init.method === "POST");
    expect(post!.url).toBe(ACK);
    // The token IS the credential — sending the session cookie would drag the
    // request under CSRF for no benefit.
    expect(post!.init.credentials).toBe("omit");
    expect(post!.init.headers["X-CSRF-Token"]).toBeUndefined();
    expect(post!.init.headers.Accept).toBe("application/json");

    // Replaces the alert in the tray (same tag) instead of opening the app.
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].title).toBe("Acknowledged");
    expect(h.shown[0].options.tag).toBe("n1");
    expect(h.shown[0].options.silent).toBe(true);
    expect(h.navigated).toHaveLength(0);
    expect(h.opened).toHaveLength(0);
  });

  it("hands a refused or unreachable acknowledge to the app instead of swallowing it", async () => {
    for (const mode of ["status", "throw"] as const) {
      const h = makeSelf({ clients: [], fetchFails: mode });
      await fire(h.handlers, "notificationclick", { action: "ack", notification: ackNotification() });
      expect(h.shown, `mode ${mode}`).toHaveLength(0);
      expect(h.opened, `mode ${mode}`).toEqual([ORIGIN + "/automations.html"]);
    }
  });

  it("never forwards the POST to another origin", async () => {
    const h = makeSelf({ clients: [] });
    await fire(h.handlers, "notificationclick", {
      action: "ack",
      notification: ackNotification({ ackUrl: "https://evil.example.net/ack/x" }),
    });
    expect(h.fetches).toHaveLength(0);
    expect(h.opened).toEqual([ORIGIN + "/automations.html"]);
  });

  it("still just opens the app on a plain body tap, link or no link", async () => {
    const h = makeSelf({ clients: [] });
    await fire(h.handlers, "notificationclick", { notification: ackNotification() });
    expect(h.fetches).toHaveLength(0);
    expect(h.opened).toEqual([ORIGIN + "/automations.html"]);
  });
});

describe("pushsubscriptionchange", () => {
  const newSub = (endpoint: string) => ({
    endpoint,
    toJSON: () => ({ keys: { p256dh: "p", auth: "a" } }),
  });

  it("re-registers the new endpoint and names the one it replaced", async () => {
    const h = makeSelf();
    await fire(h.handlers, "pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push/old", options: { applicationServerKey: new Uint8Array([1, 2, 3]) } },
      newSubscription: newSub("https://push/new"),
    });
    const post = h.fetches.find((f) => f.init && f.init.method === "POST");
    expect(post).toBeTruthy();
    const body = JSON.parse(post!.init.body);
    expect(body.endpoint).toBe("https://push/new");
    // oldEndpoint is how the server carries `surface` forward — a rotation
    // mints a new endpoint, so there's no row to inherit from.
    expect(body.oldEndpoint).toBe("https://push/old");
    expect(post!.init.headers["X-CSRF-Token"]).toBe("csrf-token-value");
    expect(post!.init.credentials).toBe("include");
  });

  it("fetches the VAPID key when the old subscription doesn't expose one", async () => {
    const h = makeSelf();
    await fire(h.handlers, "pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push/old", options: {} },
      newSubscription: newSub("https://push/new"),
    });
    expect(h.fetches.some((f) => f.url.includes("/push-subscriptions/key"))).toBe(true);
    expect(h.fetches.some((f) => f.init && f.init.method === "POST")).toBe(true);
  });

  it("gives up quietly when no key is obtainable", async () => {
    const h = makeSelf();
    h.self.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: false, publicKey: "" }) });
    await fire(h.handlers, "pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push/old", options: {} },
      newSubscription: newSub("https://push/new"),
    });
    expect(h.fetches.some((f) => f.init && f.init.method === "POST")).toBe(false);
  });

  it("does not throw when the whole flow fails", async () => {
    const h = makeSelf();
    h.self.fetch.mockRejectedValue(new Error("offline"));
    await expect(fire(h.handlers, "pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push/old", options: {} },
    })).resolves.toBeUndefined();
  });
});

describe("offline posture", () => {
  it("registers NO fetch handler", () => {
    // Polaris is online-only. A fetch handler here would turn this into a
    // caching layer that can serve stale app code.
    const h = makeSelf();
    expect(h.handlers.fetch).toBeUndefined();
    expect(Object.keys(h.handlers).sort()).toEqual(
      ["activate", "install", "notificationclick", "push", "pushsubscriptionchange"],
    );
  });

  it("contains no Cache Storage usage", () => {
    expect(SRC).not.toMatch(/caches\.(open|match)/);
  });
});
