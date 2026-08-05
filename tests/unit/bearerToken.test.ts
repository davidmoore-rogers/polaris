/**
 * tests/unit/bearerToken.test.ts — shared bearer-token mint format
 */

import { describe, it, expect } from "vitest";
import { generateRawToken, TOKEN_PREFIX, TOKEN_INDEX_PREFIX_LEN, TOKEN_RANDOM_BYTES } from "../../src/utils/bearerToken.js";

describe("generateRawToken", () => {
  it("mints polaris_ + an alphanumeric tail of up to 32 chars", () => {
    // The historical format STRIPS +/= from the base64 (rather than
    // base64url-mapping them), so the tail length varies: 32 minus however
    // many of the 32 raw chars were +/=. Entropy stays ample.
    for (let i = 0; i < 20; i++) {
      const t = generateRawToken();
      expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
      const tail = t.slice(TOKEN_PREFIX.length);
      expect(tail.length).toBeGreaterThanOrEqual(20);
      expect(tail.length).toBeLessThanOrEqual(32);
      expect(/^[A-Za-z0-9]+$/.test(tail)).toBe(true);
    }
  });

  it("is unique per call", () => {
    expect(generateRawToken()).not.toBe(generateRawToken());
  });

  it("index prefix length covers polaris_ + 8 chars", () => {
    expect(TOKEN_INDEX_PREFIX_LEN).toBe(TOKEN_PREFIX.length + 8);
    expect(TOKEN_RANDOM_BYTES).toBe(24);
  });
});
