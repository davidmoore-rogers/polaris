/**
 * tests/unit/apiGlobalExposure.test.ts — public/js/api.js must publish its
 * client as `window.api`.
 *
 * This exists because the region catalogue was dead in production for every
 * operator. `api` is declared `const api = { … }` at the top level of a classic
 * script, and a top-level const/let lives in the global LEXICAL environment —
 * it is NOT a property of `window`. So the bare identifier `api` resolved
 * everywhere while `window.api` was permanently `undefined`, and the two shared
 * modules that legitimately feature-detect the client before using it both
 * guarded on `window.api`:
 *
 *  - region-pills.js returned an empty catalogue on every page, so the Users
 *    page region picker said "No map regions defined yet" and filed every
 *    stored assignment under "Unknown region tags (no longer in the map)" —
 *    which reads exactly like the region scopes having been wiped;
 *  - app.js's `wireTotpState` never fetched status, so the account menu's
 *    self-service two-factor row never rendered.
 *
 * Neither failed loudly, because both were written to degrade quietly when the
 * client is absent — the degradation WAS the bug. And the module tests for both
 * passed, because each stubs `window.api` in its own sandbox, assuming the very
 * thing that was false. So the check has to be on api.js itself, and on the two
 * modules composed with the REAL client rather than a stub of it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const JS_DIR = resolve(__dirname, "../../public/js");
const read = (f: string) => readFileSync(resolve(JS_DIR, f), "utf8");

interface Sandbox {
  window: Record<string, any>;
  document: Record<string, any>;
  fetch: (url: string, opts?: any) => Promise<any>;
  [k: string]: any;
}

/** A browser-ish global object: api.js only defines functions and assigns to
 *  `window.*` at load time, so this is all it needs. */
function makeSandbox(jsonFor: (url: string) => unknown): Sandbox {
  const sandbox: any = {
    document: { cookie: "polaris_csrf=t0ken" },
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url: string) => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify(jsonFor(url)),
    }),
  };
  sandbox.window = sandbox;
  sandbox.window.location = { protocol: "https:", href: "" };
  sandbox.window.escapeHtml = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  vm.createContext(sandbox);
  return sandbox as Sandbox;
}

describe("the language behavior that makes the export load-bearing", () => {
  // Guards this test's own premise: if a future runtime DID hang top-level
  // consts off the global object, the assertions below would be vacuous.
  it("a top-level const is not a property of the global object", () => {
    const sandbox: any = {};
    vm.createContext(sandbox);
    vm.runInContext("const scoped = { hit: true }; var hoisted = { hit: true };", sandbox);
    expect(sandbox.scoped).toBeUndefined();
    expect(sandbox.hoisted).toEqual({ hit: true });
  });
});

describe("api.js global exposure", () => {
  it("publishes the client on window", () => {
    const sandbox = makeSandbox(() => []);
    vm.runInContext(read("api.js"), sandbox);
    expect(typeof sandbox.window.api).toBe("object");
  });

  it("exposes the two members whose window.api guards short-circuited", () => {
    const sandbox = makeSandbox(() => []);
    vm.runInContext(read("api.js"), sandbox);
    // region-pills.js: `typeof window.api.mapRegions.list !== "function"`
    expect(typeof sandbox.window.api.mapRegions.list).toBe("function");
    // app.js wireTotpState: `!window.api || !api.totp`
    expect(sandbox.window.api.totp).toBeTruthy();
  });
});

describe("region-pills.js composed with the real client", () => {
  const CATALOG = [
    { name: "Southeast", color: "#4fc3f7" },
    { name: "Midwest", color: "#ef5350" },
  ];

  /** api.js then region-pills.js in ONE context — the browser's load order. */
  function loadBoth() {
    const sandbox = makeSandbox((url) => (url.endsWith("/map/regions") ? CATALOG : []));
    vm.runInContext(read("api.js"), sandbox);
    vm.runInContext(read("region-pills.js"), sandbox);
    return sandbox;
  }

  it("reads the catalogue through window.api rather than falling back to empty", async () => {
    const sandbox = loadBoth();
    const pills = sandbox.window.PolarisRegionPills;
    await pills.load();
    expect(pills.isLoaded()).toBe(true);
    expect(pills.names()).toEqual(["Midwest", "Southeast"]);
    // The whole point: a loaded catalogue is what colors a pill and what stops
    // the picker calling every assignment an orphan.
    expect(pills.colorFor("Southeast")).toBe("#4fc3f7");
  });

  it("still reports not-loaded when the catalogue read fails", async () => {
    const sandbox = loadBoth();
    sandbox.window.api.mapRegions.list = async () => {
      throw new Error("403");
    };
    const pills = sandbox.window.PolarisRegionPills;
    await pills.load();
    expect(pills.isLoaded()).toBe(false);
    expect(pills.names()).toEqual([]);
    // Unreadable is not "no regions": the neutral fallback still renders a pill.
    expect(pills.colorFor("Southeast")).toBe("#9e9e9e");
  });
});
