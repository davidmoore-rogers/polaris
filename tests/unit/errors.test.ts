/**
 * tests/unit/errors.test.ts
 *
 * Coverage for the cooperative-cancel helpers in utils/errors.ts:
 * DiscoveryAbortError must be indistinguishable from a fetch AbortError to
 * existing `err.name === "AbortError"` catch blocks, and throwIfAborted must
 * be a no-op until the signal fires.
 */

import { describe, it, expect } from "vitest";
import { DiscoveryAbortError, throwIfAborted } from "../../src/utils/errors.js";

describe("DiscoveryAbortError", () => {
  it('carries name "AbortError" so runDiscovery counts it as aborted, not errored', () => {
    const err = new DiscoveryAbortError();
    expect(err.name).toBe("AbortError");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Discovery aborted");
  });

  it("keeps a custom message", () => {
    expect(new DiscoveryAbortError("stopped").message).toBe("stopped");
  });
});

describe("throwIfAborted", () => {
  it("is a no-op for undefined or un-aborted signals", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    const ac = new AbortController();
    expect(() => throwIfAborted(ac.signal)).not.toThrow();
  });

  it("throws DiscoveryAbortError once the signal fires", () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => throwIfAborted(ac.signal)).toThrow(DiscoveryAbortError);
  });

  it("includes the context in the message", () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => throwIfAborted(ac.signal, 'sync phase "3-reservations"')).toThrow(
      'Discovery aborted before sync phase "3-reservations"',
    );
  });
});
