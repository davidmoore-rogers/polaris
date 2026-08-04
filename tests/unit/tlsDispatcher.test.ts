/**
 * tests/unit/tlsDispatcher.test.ts — per-connection TLS relaxation dispatcher
 */

import { describe, it, expect } from "vitest";
import { Agent } from "undici";
import { insecureTlsDispatcher } from "../../src/utils/tlsDispatcher.js";

describe("insecureTlsDispatcher", () => {
  it("returns an undici Agent (usable as a fetch dispatcher)", () => {
    const d = insecureTlsDispatcher();
    expect(d).toBeInstanceOf(Agent);
    expect(typeof (d as Agent).dispatch).toBe("function");
  });

  it("is a singleton — repeated calls share one pooled agent", () => {
    expect(insecureTlsDispatcher()).toBe(insecureTlsDispatcher());
  });

  it("never mutates NODE_TLS_REJECT_UNAUTHORIZED (the global flip it replaces)", () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    insecureTlsDispatcher();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
  });
});
