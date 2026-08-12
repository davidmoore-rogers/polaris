/**
 * tests/unit/ackToken.test.ts — the one-click acknowledge token format and
 * the redemption state machine.
 *
 * The token utils are pure; classifyAckToken is the DB-free core of
 * notificationAckService, so the whole valid/already/used/expired/cleared/
 * forbidden ladder is testable without a database.
 */

import { describe, it, expect } from "vitest";
import {
  ACK_TOKEN_PREFIX,
  ACK_TOKEN_TTL_DAYS,
  ackTokenExpiry,
  generateAckToken,
  hashAckToken,
  isWellFormedAckToken,
} from "../../src/utils/ackToken.js";
import { classifyAckToken } from "../../src/services/notificationAckService.js";

describe("ack token format", () => {
  it("mints a prefixed base64url token", () => {
    const t = generateAckToken();
    expect(t.startsWith(ACK_TOKEN_PREFIX)).toBe(true);
    expect(t.slice(ACK_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("never repeats across a large batch", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateAckToken());
    expect(seen.size).toBe(2000);
  });

  it("hashes deterministically to a base64url digest, and differently per token", () => {
    const a = generateAckToken();
    const b = generateAckToken();
    expect(hashAckToken(a)).toBe(hashAckToken(a));
    expect(hashAckToken(a)).not.toBe(hashAckToken(b));
    expect(hashAckToken(a)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The raw token must not be recoverable from (or contained in) the digest.
    expect(hashAckToken(a)).not.toContain(a.slice(ACK_TOKEN_PREFIX.length));
  });

  it("rejects junk before it can cost a database round trip", () => {
    expect(isWellFormedAckToken(generateAckToken())).toBe(true);
    expect(isWellFormedAckToken("")).toBe(false);
    expect(isWellFormedAckToken("polaris_ack_")).toBe(false);
    expect(isWellFormedAckToken("polaris_abcdefghijklmnopqrstuvwxyz123456")).toBe(false); // bearer prefix
    expect(isWellFormedAckToken(ACK_TOKEN_PREFIX + "short")).toBe(false);
    expect(isWellFormedAckToken(ACK_TOKEN_PREFIX + "!".repeat(32))).toBe(false);
    // A scanner that appends its own query junk to the path segment.
    expect(isWellFormedAckToken(generateAckToken() + "?utm=1")).toBe(false);
    expect(isWellFormedAckToken(undefined)).toBe(false);
    expect(isWellFormedAckToken(12345)).toBe(false);
  });

  it("expires the configured number of days out", () => {
    const now = new Date("2026-08-12T10:00:00Z");
    expect(ackTokenExpiry(now).toISOString()).toBe(
      new Date(now.getTime() + ACK_TOKEN_TTL_DAYS * 86400000).toISOString(),
    );
  });
});

describe("classifyAckToken", () => {
  const now = new Date("2026-08-12T12:00:00Z");
  const live = { expiresAt: new Date("2026-09-01T00:00:00Z"), usedAt: null };
  const open = { acknowledged: false, cleared: false };

  it("accepts a live token on an open alert from a permitted user", () => {
    expect(classifyAckToken(live, open, true, now)).toBe("valid");
  });

  it("reports unknown for a missing token or a vanished alert", () => {
    expect(classifyAckToken(null, open, true, now)).toBe("unknown");
    expect(classifyAckToken(live, null, true, now)).toBe("unknown");
  });

  it("reports 'already' ahead of every other failure — the click did land", () => {
    const acked = { acknowledged: true, cleared: false };
    expect(classifyAckToken(live, acked, true, now)).toBe("already");
    // Spent token, lost permission, expired, cleared: still 'already'.
    expect(classifyAckToken({ ...live, usedAt: now }, acked, false, now)).toBe("already");
    expect(classifyAckToken({ ...live, expiresAt: new Date("2026-01-01T00:00:00Z") }, acked, true, now)).toBe("already");
  });

  it("spends single-use: a second click on the same token is 'used'", () => {
    expect(classifyAckToken({ ...live, usedAt: new Date("2026-08-12T11:00:00Z") }, open, true, now)).toBe("used");
  });

  it("expires exactly at the boundary, not a millisecond later", () => {
    expect(classifyAckToken({ expiresAt: now, usedAt: null }, open, true, now)).toBe("expired");
    expect(classifyAckToken({ expiresAt: new Date(now.getTime() + 1), usedAt: null }, open, true, now)).toBe("valid");
  });

  it("says so when the alert was cleared before the click", () => {
    expect(classifyAckToken(live, { acknowledged: false, cleared: true }, true, now)).toBe("cleared");
  });

  it("refuses a recipient whose role lost alerts:write after the mail went out", () => {
    expect(classifyAckToken(live, open, false, now)).toBe("forbidden");
  });
});
