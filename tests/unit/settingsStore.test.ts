/**
 * tests/unit/settingsStore.test.ts — createSettingStore TTL cache + row I/O.
 * Uses a throwaway Setting key against the test DB.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { createSettingStore } from "../../src/services/settingsStore.js";

const KEY = "test:settingsStore";

interface Shape { n: number; label: string }
const DEFAULTS: Shape = { n: 0, label: "default" };

function makeStore(ttlMs = 30000) {
  return createSettingStore<Shape>({
    key: KEY,
    ttlMs,
    parse: (raw) => (raw ? { ...DEFAULTS, ...(raw as Record<string, unknown>) } : { ...DEFAULTS }),
  });
}

beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: KEY } });
});

afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: KEY } });
});

describe("createSettingStore", () => {
  it("parses undefined into defaults when no row exists", async () => {
    const store = makeStore();
    expect(await store.get()).toEqual(DEFAULTS);
  });

  it("save upserts the row and primes the cache", async () => {
    const store = makeStore();
    await store.save({ n: 7, label: "seven" });
    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    expect(row?.value).toEqual({ n: 7, label: "seven" });
    expect(await store.get()).toEqual({ n: 7, label: "seven" });
    expect(store.peek()).toEqual({ n: 7, label: "seven" });
  });

  it("serves the cached value within the TTL even after the row changes", async () => {
    const store = makeStore();
    await store.save({ n: 1, label: "a" });
    await prisma.setting.update({ where: { key: KEY }, data: { value: { n: 2, label: "b" } } });
    expect(await store.get()).toEqual({ n: 1, label: "a" });
  });

  it("invalidate() makes the next get() re-read the row", async () => {
    const store = makeStore();
    await store.save({ n: 1, label: "a" });
    await prisma.setting.update({ where: { key: KEY }, data: { value: { n: 2, label: "b" } } });
    store.invalidate();
    expect(store.peek()).toBeNull();
    expect(await store.get()).toEqual({ n: 2, label: "b" });
  });

  it("an expired cache falls through to the DB", async () => {
    const store = makeStore(0); // everything expires immediately
    await store.save({ n: 1, label: "a" });
    await prisma.setting.update({ where: { key: KEY }, data: { value: { n: 3, label: "c" } } });
    expect(store.peek()).toBeNull();
    expect(await store.get()).toEqual({ n: 3, label: "c" });
  });

  it("peek() never hits the DB and reports null on a cold store", () => {
    const store = makeStore();
    expect(store.peek()).toBeNull();
  });
});
