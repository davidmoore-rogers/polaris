/**
 * tests/unit/scopeInterfaceIndex.test.ts
 *
 * The SQL half of the condition tree's `interfaceName` field. What matters here
 * is not the queries themselves but that the prefetched verdict and the
 * in-memory relation read reach the SAME answer — they are two paths through one
 * predicate, and a disagreement would make an automation select a different
 * device set on the engine tick than the wizard previewed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const groupBy = vi.fn();
const findMany = vi.fn();

vi.mock("../../src/db.js", () => ({
  prisma: { assetInterface: { groupBy, findMany } },
}));

const { decorateInterfaceLeafHits } = await import("../../src/services/scopeInterfaceIndex.js");
const { evaluateScopeCondition, interfaceLeafKey } = await import("../../src/services/notificationTypes.js");

type Tree = Parameters<typeof evaluateScopeCondition>[0];
type Asset = Parameters<typeof evaluateScopeCondition>[1];

const and = (...children: unknown[]) => ({ op: "and", children }) as Tree;
const leaf = (operator: string, value: string) => ({ field: "interfaceName", operator, value });
const one = (operator: string, value: string) => and(leaf(operator, value));

beforeEach(() => {
  groupBy.mockReset();
  findMany.mockReset();
});

describe("decorateInterfaceLeafHits", () => {
  it("asks nothing when no leaf mentions an interface", async () => {
    const rows: Asset[] = [{ id: "a1" }];
    await decorateInterfaceLeafHits(rows, [and({ field: "hostname", operator: "contains", value: "sw" })]);
    expect(groupBy).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(rows[0]!.interfaceLeafHits).toBeUndefined();
  });

  it("asks nothing for an empty row set", async () => {
    await decorateInterfaceLeafHits([], [one("equals", "port9")]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("stamps a per-asset verdict and scopes the query to the rows it was given", async () => {
    groupBy.mockResolvedValue([{ assetId: "a1" }]);
    const rows: Asset[] = [{ id: "a1" }, { id: "a2" }];
    await decorateInterfaceLeafHits(rows, [one("equals", "port9")]);

    const key = interfaceLeafKey(leaf("equals", "port9"));
    expect(rows[0]!.interfaceLeafHits!.get(key)).toBe(true);
    expect(rows[1]!.interfaceLeafHits!.get(key)).toBe(false);

    const arg = groupBy.mock.calls[0]![0];
    expect(arg.by).toEqual(["assetId"]);
    expect(arg.where.assetId).toEqual({ in: ["a1", "a2"] });
    expect(arg.where.ifName).toEqual({ equals: "port9", mode: "insensitive" });
  });

  // The whole point of keying by the POSITIVE operator: a rule that asks "has
  // port9" and one that asks "has no port9" are answered by one query.
  it("shares one query between the halves of a negative pair", async () => {
    groupBy.mockResolvedValue([{ assetId: "a1" }]);
    const rows: Asset[] = [{ id: "a1" }];
    await decorateInterfaceLeafHits(rows, [
      one("equals", "port9"),
      one("notEquals", "port9"),
      one("contains", "port9"),
    ]);
    // equals+notEquals collapse to one key; contains is a second.
    expect(groupBy).toHaveBeenCalledTimes(2);
    expect(rows[0]!.interfaceLeafHits!.size).toBe(2);
  });

  it("merges rather than replacing, so a second pass keeps the first pass's answers", async () => {
    groupBy.mockResolvedValue([{ assetId: "a1" }]);
    const rows: Asset[] = [{ id: "a1" }];
    await decorateInterfaceLeafHits(rows, [one("equals", "port9")]);
    groupBy.mockResolvedValue([]);
    await decorateInterfaceLeafHits(rows, [one("equals", "fortilink")]);

    expect(rows[0]!.interfaceLeafHits!.get(interfaceLeafKey(leaf("equals", "port9")))).toBe(true);
    expect(rows[0]!.interfaceLeafHits!.get(interfaceLeafKey(leaf("equals", "fortilink")))).toBe(false);
  });

  it("narrows a wildcard by its literal prefix and tests the pattern here", async () => {
    findMany.mockResolvedValue([
      { assetId: "a1", ifName: "PLV-61F-1" },
      { assetId: "a2", ifName: "PLV-61F-22" },
    ]);
    const rows: Asset[] = [{ id: "a1" }, { id: "a2" }];
    await decorateInterfaceLeafHits(rows, [one("matches", "PLV-*-?")]);

    expect(groupBy).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0]![0].where.ifName).toEqual({ startsWith: "PLV-", mode: "insensitive" });
    const key = interfaceLeafKey(leaf("matches", "PLV-*-?"));
    // Anchored: the single "?" matches "1" but not "22".
    expect(rows[0]!.interfaceLeafHits!.get(key)).toBe(true);
    expect(rows[1]!.interfaceLeafHits!.get(key)).toBe(false);
  });

  it("reads the whole table for a pattern that opens with a metacharacter", async () => {
    findMany.mockResolvedValue([{ assetId: "a1", ifName: "wan1" }]);
    await decorateInterfaceLeafHits([{ id: "a1" } as Asset], [one("matches", "*an1")]);
    expect(findMany.mock.calls[0]![0].where.ifName).toBeUndefined();
  });
});

describe("prefetched verdict vs. joined relation", () => {
  const CASES: [string, string, string[], boolean][] = [
    // operator, value, the asset's real interface names, expected
    ["equals", "port9", ["port1", "port9"], true],
    ["equals", "port9", ["port1", "port10"], false],
    ["notEquals", "port9", ["port1", "port9"], false],
    ["notEquals", "port9", ["port1", "port10"], true],
    ["contains", "link", ["fortilink"], true],
    ["notContains", "link", ["fortilink", "port1"], false],
    ["startsWith", "wan", ["wan1"], true],
    ["endsWith", "1", ["wan1"], true],
    // Nothing known at all: a positive claim fails, an absence claim holds.
    ["equals", "port9", [], false],
    ["notEquals", "port9", [], true],
  ];

  for (const [operator, value, names, expected] of CASES) {
    it(`${operator} ${value} against [${names.join(", ")}] is ${expected} both ways`, async () => {
      const tree = one(operator, value);

      // Path A — the single-asset paths: the relation rides the row.
      const joined: Asset = { id: "a1", interfaces: names.map((ifName) => ({ ifName })) };
      expect(evaluateScopeCondition(tree, joined)).toBe(expected);

      // Path B — the fleet-scale paths: SQL answered the leaf's POSITIVE form,
      // which is what the mock stands in for here.
      const positiveHit = names.some((n) => {
        const hay = n.toLowerCase();
        const needle = value.toLowerCase();
        switch (operator) {
          case "equals": case "notEquals": return hay === needle;
          case "contains": case "notContains": return hay.includes(needle);
          case "startsWith": return hay.startsWith(needle);
          case "endsWith": return hay.endsWith(needle);
          default: return false;
        }
      });
      groupBy.mockResolvedValue(positiveHit ? [{ assetId: "a1" }] : []);
      const decorated: Asset = { id: "a1" };
      await decorateInterfaceLeafHits([decorated], [tree]);
      expect(evaluateScopeCondition(tree, decorated)).toBe(expected);
    });
  }

  // The reason matchScopeRule tests has() and not get(): a leaf nobody
  // prefetched is UNKNOWN. Answering "no" for it would make a peer rule's
  // interface filter silently select nothing.
  it("falls back to the relation for a leaf the decoration never resolved", async () => {
    groupBy.mockResolvedValue([]);
    const asset: Asset = { id: "a1", interfaces: [{ ifName: "port9" }] };
    await decorateInterfaceLeafHits([asset], [one("equals", "fortilink")]);
    expect(evaluateScopeCondition(one("equals", "port9"), asset)).toBe(true);
    expect(evaluateScopeCondition(one("equals", "fortilink"), asset)).toBe(false);
  });
});
