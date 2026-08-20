/**
 * tests/unit/parseSearchTerms.test.ts — global-search query tokenization
 */

import { describe, it, expect } from "vitest";
import { parseSearchTerms } from "../../src/services/searchService.js";

describe("parseSearchTerms", () => {
  it("returns a single term for one word", () => {
    expect(parseSearchTerms("rgihardware")).toEqual(["rgihardware"]);
  });

  it("splits space-separated words into multiple terms", () => {
    expect(parseSearchTerms("rgihardware metro")).toEqual(["rgihardware", "metro"]);
  });

  it("collapses runs of whitespace and trims edges", () => {
    expect(parseSearchTerms("  rgihardware    metro  ")).toEqual(["rgihardware", "metro"]);
    expect(parseSearchTerms("a\tb\nc")).toEqual(["a", "b", "c"]);
  });

  it("keeps a double-quoted phrase as one term", () => {
    expect(parseSearchTerms('"acme plant"')).toEqual(["acme plant"]);
  });

  it("mixes quoted phrases and bare words", () => {
    expect(parseSearchTerms('"acme plant" metro')).toEqual(["acme plant", "metro"]);
    expect(parseSearchTerms('metro "acme plant" sw01')).toEqual([
      "metro",
      "acme plant",
      "sw01",
    ]);
  });

  it("tolerates an unterminated opening quote (rest becomes one phrase)", () => {
    expect(parseSearchTerms('metro "acme plant')).toEqual(["metro", "acme plant"]);
  });

  it("drops empty quoted phrases", () => {
    expect(parseSearchTerms('"" metro')).toEqual(["metro"]);
    expect(parseSearchTerms('metro ""')).toEqual(["metro"]);
  });

  it("returns an empty array for empty / whitespace-only / quotes-only input", () => {
    expect(parseSearchTerms("")).toEqual([]);
    expect(parseSearchTerms("   ")).toEqual([]);
    expect(parseSearchTerms('""')).toEqual([]);
    expect(parseSearchTerms('"')).toEqual([]);
  });

  it("preserves internal punctuation within a term", () => {
    expect(parseSearchTerms("10.1.1.0/24")).toEqual(["10.1.1.0/24"]);
    expect(parseSearchTerms("aa:bb:cc:dd:ee:ff")).toEqual(["aa:bb:cc:dd:ee:ff"]);
  });
});
