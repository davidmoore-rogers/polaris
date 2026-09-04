/**
 * tests/unit/tagPickerNonAdminRole.test.ts — the shared tag picker for a role
 * that holds NO serverSettingsSystem grant.
 *
 * The bug: `_ensureTagCache` read the tag registry through
 * `GET /server-settings/tags` + `/tags/settings`, both of which sit behind the
 * blanket `serverSettingsSystem: read` floor on that mount. Every non-admin
 * built-in role (`user`, `assetsadmin`, `networkadmin`, `readonly`) is seeded
 * `serverSettingsSystem: "none"`, so both calls 403'd, the cache's `.catch()`
 * swallowed it, and the asset edit form's tag picker rendered "No tags defined
 * yet. Use the form below to add one." at an install with a full registry —
 * with an "+ Add Tag" button whose only possible outcome was another 403.
 *
 * The picker now reads the auth-only catalogue route, and the add-row is gated
 * on the same `serverSettingsSystem: fullwrite` that `POST /tags` requires.
 *
 * app.js is a classic browser script, so it's eval'd into a happy-dom Window —
 * the tagPickerRegionTags.test.ts idiom.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const APP_SRC = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");

const TAGS = [
  { id: "t1", name: "Production", category: "Environment", color: "#f87171" },
  { id: "t2", name: "Nashville", category: "Site", color: "#4fc3f7" },
];

let win: InstanceType<typeof Window>;
let doc: Window["document"];

function exported<T>(name: string): T {
  const fn = (win as unknown as Record<string, unknown>)[name] ?? g[name];
  expect(typeof fn, `app.js no longer exposes ${name}`).toBe("function");
  return fn as T;
}

/**
 * Boot app.js with one role matrix and one catalogue outcome, then render the
 * picker into #host. `catalog: null` stands in for a read that failed.
 */
async function boot(opts: {
  perms: Record<string, string>;
  catalog: { enforce: boolean; tags: typeof TAGS } | null;
}): Promise<{ calls: string[] }> {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const calls: string[] = [];
  g.api = {
    serverSettings: {
      tagCatalog: async () => {
        calls.push("tagCatalog");
        if (!opts.catalog) throw new Error("403 Forbidden");
        return opts.catalog;
      },
      // The registry's own gated reads. A call to either is the bug: they 403
      // for the roles this test is about.
      listTags: async () => { calls.push("listTags"); throw new Error("403 Forbidden"); },
      getTagSettings: async () => { calls.push("getTagSettings"); throw new Error("403 Forbidden"); },
    },
  };

  doc.body.innerHTML = "<div id='host'></div>";
  try { (0, eval)(APP_SRC); } catch (_e) { /* app.js boot wiring touches page-specific DOM */ }

  (win as unknown as Record<string, unknown>).currentRolePermissions = opts.perms;
  g.currentRolePermissions = opts.perms;

  await exported<() => Promise<void>>("_ensureTagCache")();
  const host = doc.getElementById("host") as unknown as HTMLElement;
  host.innerHTML = exported<(s: string[]) => string>("tagFieldHTML")([]);
  return { calls };
}

const USER_ROLE = { assets: "read", subnets: "write", serverSettingsSystem: "none" };
const ADMIN_ROLE = { assets: "fullwrite", subnets: "fullwrite", serverSettingsSystem: "fullwrite" };

function chipValues(): string[] {
  return Array.from(doc.querySelectorAll('input[name="f-tags-cb"]')).map(
    (e) => (e as unknown as HTMLInputElement).value,
  );
}

describe("tag picker — a role with no serverSettingsSystem grant", () => {
  beforeEach(() => { /* each test boots its own window */ });

  it("reads the catalogue route, never the gated registry routes", async () => {
    const { calls } = await boot({ perms: USER_ROLE, catalog: { enforce: false, tags: TAGS } });
    expect(calls).toEqual(["tagCatalog"]);
    expect(calls, "the gated registry read is back — it 403s for this role").not.toContain("listTags");
    expect(calls).not.toContain("getTagSettings");
  });

  it("renders the existing tags as selectable chips", async () => {
    await boot({ perms: USER_ROLE, catalog: { enforce: false, tags: TAGS } });
    expect(chipValues().sort()).toEqual(["Nashville", "Production"]);
    expect(doc.body.innerHTML).not.toContain("No tags defined yet");
  });

  it("withholds the + Add Tag row — creating a registry row needs fullwrite", async () => {
    await boot({ perms: USER_ROLE, catalog: { enforce: false, tags: TAGS } });
    expect(doc.getElementById("f-tag-add-btn"), "a button whose only outcome is a 403").toBeNull();
  });

  it("still offers + Add Tag to a caller who holds the grant", async () => {
    await boot({ perms: ADMIN_ROLE, catalog: { enforce: false, tags: TAGS } });
    expect(doc.getElementById("f-tag-add-btn")).toBeTruthy();
  });

  it("enforce=true withholds the add row even from a fullwrite caller", async () => {
    await boot({ perms: ADMIN_ROLE, catalog: { enforce: true, tags: TAGS } });
    expect(doc.getElementById("f-tag-add-btn")).toBeNull();
    expect(chipValues().sort()).toEqual(["Nashville", "Production"]);
  });

  it("an empty registry points a non-admin at who can populate it", async () => {
    await boot({ perms: USER_ROLE, catalog: { enforce: false, tags: [] } });
    expect(doc.body.textContent).toContain("An administrator adds them");
    expect(doc.body.textContent, "there is no form below for this role").not.toContain("Use the form below");
  });

  it("a failed read says so instead of claiming the install has no tags", async () => {
    await boot({ perms: ADMIN_ROLE, catalog: null });
    expect(doc.body.textContent).toContain("Could not load the tag list");
    expect(doc.body.textContent).not.toContain("No tags defined yet");
    // Nothing to add TO — the add row is withheld even from a fullwrite caller.
    expect(doc.getElementById("f-tag-add-btn")).toBeNull();
  });
});
