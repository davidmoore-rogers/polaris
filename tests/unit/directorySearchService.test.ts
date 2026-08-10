/**
 * tests/unit/directorySearchService.test.ts — the GAL fan-out.
 *
 * The properties that matter are all about NOT making a typeahead fragile:
 *   - only integrations that opted in are queried (the permission gate),
 *   - one backend failing degrades to the others' results instead of erroring,
 *   - a hybrid-joined person appearing in both AD and Entra is deduped,
 *   - short queries never reach the directory at all,
 *   - identical queries are served from cache rather than re-hitting the tenant.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const integrations: Array<{ id: string; name: string; type: string; config: Record<string, unknown> }> = [];

const prismaMock = vi.hoisted(() => ({
  integration: { findMany: vi.fn() },
}));
vi.mock("../../src/db.js", () => ({ prisma: prismaMock }));

const entraSearch = vi.hoisted(() => vi.fn());
const adSearch = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/entraIdService.js", () => ({ searchDirectoryEntra: entraSearch }));
vi.mock("../../src/services/activeDirectoryService.js", () => ({ searchDirectoryAd: adSearch }));

import {
  searchDirectory,
  directorySearchAvailable,
  bumpDirectoryCache,
} from "../../src/services/directorySearchService.js";

const hit = (email: string, over: Record<string, unknown> = {}) => ({
  id: "id-" + email, email, name: email.split("@")[0], description: null, kind: "person", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  bumpDirectoryCache();
  integrations.length = 0;
  prismaMock.integration.findMany.mockImplementation(async () => integrations);
  entraSearch.mockResolvedValue([]);
  adSearch.mockResolvedValue([]);
});

const addEntra = (opt: boolean) =>
  integrations.push({ id: "i-entra", name: "Entra", type: "entraid", config: { enableDirectorySearch: opt } });
const addAd = (opt: boolean) =>
  integrations.push({ id: "i-ad", name: "AD", type: "activedirectory", config: { enableDirectorySearch: opt } });

describe("opt-in gate", () => {
  it("queries nothing when no integration opted in", async () => {
    addEntra(false);
    addAd(false);
    expect(await searchDirectory("jane")).toEqual([]);
    expect(entraSearch).not.toHaveBeenCalled();
    expect(adSearch).not.toHaveBeenCalled();
  });

  it("queries only the integrations that did", async () => {
    addEntra(true);
    addAd(false);
    entraSearch.mockResolvedValue([hit("jane@example.com")]);
    const out = await searchDirectory("jane");
    expect(out.map((e) => e.email)).toEqual(["jane@example.com"]);
    expect(adSearch).not.toHaveBeenCalled();
  });

  it("directorySearchAvailable reflects the gate", async () => {
    addEntra(false);
    expect(await directorySearchAvailable()).toBe(false);
    integrations.length = 0;
    addEntra(true);
    expect(await directorySearchAvailable()).toBe(true);
  });
});

describe("query floor", () => {
  it("never reaches the directory for a query below the minimum", async () => {
    addEntra(true);
    expect(await searchDirectory("j")).toEqual([]);
    expect(await searchDirectory("")).toEqual([]);
    expect(await searchDirectory("   ")).toEqual([]);
    expect(entraSearch).not.toHaveBeenCalled();
  });
});

describe("failure isolation", () => {
  it("returns the healthy backend's results when the other throws", async () => {
    addEntra(true);
    addAd(true);
    entraSearch.mockRejectedValue(new Error("Graph API permission denied (403)"));
    adSearch.mockResolvedValue([hit("onprem@example.com")]);

    const out = await searchDirectory("on");
    expect(out.map((e) => e.email)).toEqual(["onprem@example.com"]);
  });

  it("returns [] rather than throwing when every backend fails", async () => {
    addEntra(true);
    adSearch.mockResolvedValue([]);
    entraSearch.mockRejectedValue(new Error("boom"));
    expect(await searchDirectory("jane")).toEqual([]);
  });
});

describe("merging", () => {
  it("tags each hit with the backend that produced it", async () => {
    addEntra(true);
    addAd(true);
    entraSearch.mockResolvedValue([hit("cloud@example.com")]);
    adSearch.mockResolvedValue([hit("onprem@example.com")]);
    const out = await searchDirectory("example");
    expect(out.find((e) => e.email === "cloud@example.com")!.source).toBe("entra");
    expect(out.find((e) => e.email === "onprem@example.com")!.source).toBe("ad");
  });

  it("dedupes a hybrid-joined person present in both directories", async () => {
    addEntra(true);
    addAd(true);
    entraSearch.mockResolvedValue([hit("jane@example.com")]);
    adSearch.mockResolvedValue([hit("JANE@example.com")]);
    const out = await searchDirectory("jane");
    expect(out).toHaveLength(1);
  });

  it("caps the merged result set", async () => {
    addEntra(true);
    entraSearch.mockResolvedValue(Array.from({ length: 40 }, (_, i) => hit(`u${i}@example.com`)));
    expect(await searchDirectory("user", 10)).toHaveLength(10);
  });

  it("carries the group kind through", async () => {
    addEntra(true);
    entraSearch.mockResolvedValue([hit("netops@example.com", { kind: "group", description: "Distribution list" })]);
    const out = await searchDirectory("net");
    expect(out[0].kind).toBe("group");
  });
});

describe("caching", () => {
  it("serves an identical query from cache instead of re-hitting the tenant", async () => {
    addEntra(true);
    entraSearch.mockResolvedValue([hit("jane@example.com")]);
    await searchDirectory("jane");
    await searchDirectory("jane");
    await searchDirectory("JANE"); // case-insensitive key
    expect(entraSearch).toHaveBeenCalledTimes(1);
  });

  it("treats a different query as a different key", async () => {
    addEntra(true);
    entraSearch.mockResolvedValue([]);
    await searchDirectory("jane");
    await searchDirectory("john");
    expect(entraSearch).toHaveBeenCalledTimes(2);
  });
});
