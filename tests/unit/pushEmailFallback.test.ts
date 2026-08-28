/**
 * tests/unit/pushEmailFallback.test.ts
 *
 * Falling back to email when a web push dies for good (business rule 39).
 *
 * The signal is the only one Polaris actually gets: a push service answering
 * 404/410 means that subscription is dead. It is emphatically NOT "the phone is
 * off" — a phone in a drawer returns 201 and the message expires at its TTL
 * with nothing reported back — so what is pinned here is the narrow claim, and
 * the three guards that stop it emailing people who were reached perfectly
 * well.
 *
 * The guards are what get this wrong in production, and all three fail
 * silently in the annoying direction (a duplicate alert) or the dangerous one
 * (no alert at all), so they are tested as pure decisions against the sibling
 * rows the drain actually reads.
 */
import { describe, it, expect } from "vitest";
import {
  readPushFallback,
  pushStillInPlay,
  alreadyEmailedOnChannel,
  type FallbackSibling,
} from "../../src/services/notificationDeliveryService.js";

// The REAL predicates, not copies. A mirrored guard drifts from the one that
// actually runs, and the first draft of this file proved it: the mirror left
// out readPushFallback's type check and let a malformed row straight through.
const fallbackOf = (meta: unknown) => readPushFallback(meta)?.userId ?? null;
const stillInPlay = pushStillInPlay;
const alreadyEmailed = alreadyEmailedOnChannel;

type Sibling = FallbackSibling;

const push = (status: string, userId: string): Sibling =>
  ({ transport: "web_push", status, target: "https://push.example/" + userId + status, channelId: "cpush", meta: { fallback: { userId, channelId: "cmail", address: "a@b.co" } } });

describe("guard 1 — per RECIPIENT, not per row", () => {
  it("holds off while another of their devices was reached", () => {
    // Three enrolled browsers, one dead: they already have the alert. Emailing
    // now is a duplicate, and duplicates are how people learn to ignore alerts.
    const siblings = [push("failed", "u1"), push("sent", "u1"), push("failed", "u2")];
    expect(stillInPlay(siblings, "u1")).toBe(true);
    expect(stillInPlay(siblings, "u2")).toBe(false);
  });

  it("holds off while a retry may still land it", () => {
    // `pending` means the drain will try again — a 5xx burns up to MAX_ATTEMPTS
    // before it is terminal, so falling back now races a delivery that works.
    expect(stillInPlay([push("failed", "u1"), push("pending", "u1")], "u1")).toBe(true);
  });

  it("falls back once every device of theirs has stopped being in play", () => {
    expect(stillInPlay([push("failed", "u1"), push("failed", "u1")], "u1")).toBe(false);
  });

  it("ignores OTHER people's live devices", () => {
    // The bug this pins: a broadcast where anyone still reachable suppresses
    // the fallback for everyone, so the one person with a dead endpoint is the
    // only one who hears nothing.
    expect(stillInPlay([push("sent", "u2"), push("failed", "u1")], "u1")).toBe(false);
  });
});

describe("guard 2 — never twice", () => {
  const mailRow = (target: string): Sibling =>
    ({ transport: "email", status: "sent", target, channelId: "cmail", meta: {} });

  it("skips someone the automation already emailed directly", () => {
    expect(alreadyEmailed([mailRow("a@b.co")], "cmail", "a@b.co")).toBe(true);
  });

  it("finds them inside a composed email's joined To line", () => {
    // A composed send is ONE row whose target is the whole To list, so an
    // equality test would miss it and mail them a second copy.
    expect(alreadyEmailed([mailRow("ops@x.co, a@b.co, noc@x.co")], "cmail", "a@b.co")).toBe(true);
  });

  it("does not confuse a different channel's email for this one", () => {
    expect(alreadyEmailed([{ ...mailRow("a@b.co"), channelId: "other" }], "cmail", "a@b.co")).toBe(false);
  });

  it("lets the fallback through when nobody has emailed them", () => {
    expect(alreadyEmailed([mailRow("someone@else.co"), push("failed", "u1")], "cmail", "a@b.co")).toBe(false);
  });
});

describe("guard 3 — the stamp is what makes any of it possible", () => {
  it("reads a well-formed fallback", () => {
    expect(fallbackOf({ fallback: { userId: "u1", channelId: "c", address: "a@b.co" } })).toBe("u1");
  });

  it("treats a push row with no fallback as un-routable rather than throwing", () => {
    // A push-only action stamps nothing (there is no email channel to fall back
    // to), and so does an account with no address. Both must be inert here, not
    // a crash on the delivery hot path.
    for (const m of [null, undefined, {}, { fallback: null }, { fallback: { userId: 3 } }]) {
      expect(fallbackOf(m)).toBeNull();
    }
  });
});
