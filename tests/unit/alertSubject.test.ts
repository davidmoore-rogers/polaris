/**
 * tests/unit/alertSubject.test.ts
 *
 * What an alert is ABOUT, as a label. The case worth pinning is the one that
 * shipped broken: a system-scoped audit Event (capacity, backups, updates)
 * names no resource, because the resource is this install — so the alert email
 * led with a blank headline and a subject line reading "[WARNING]  — Capacity
 * severity escalated", with nothing anywhere saying it was about the Polaris
 * server rather than about somebody's switch.
 */

import { describe, it, expect } from "vitest";
import { eventSubjectLabel, POLARIS_SELF_LABEL } from "../../src/utils/alertSubject.js";

describe("eventSubjectLabel", () => {
  it("names the Polaris server for a system-scoped event that names nothing", () => {
    expect(eventSubjectLabel("system", null)).toBe(POLARIS_SELF_LABEL);
    expect(eventSubjectLabel("system", "")).toBe(POLARIS_SELF_LABEL);
    expect(eventSubjectLabel("system", "   ")).toBe(POLARIS_SELF_LABEL);
  });

  it("is unmistakable in an inbox — a monitored host named Polaris is a different thing", () => {
    expect(POLARIS_SELF_LABEL).toBe("Polaris server");
  });

  it("prefers the resource's own name whenever the event carried one", () => {
    expect(eventSubjectLabel("integration", "FMG-Nashville")).toBe("FMG-Nashville");
    expect(eventSubjectLabel("asset", "sw-1")).toBe("sw-1");
    // Even on a system event: if it named something, that name is the subject.
    expect(eventSubjectLabel("system", "nightly-backup")).toBe("nightly-backup");
  });

  it("invents nothing for an unnamed resource of some other type", () => {
    // "" prunes the header line and the facts row rather than mailing a guess.
    expect(eventSubjectLabel("integration", null)).toBe("");
    expect(eventSubjectLabel(null, null)).toBe("");
    expect(eventSubjectLabel(undefined, undefined)).toBe("");
  });
});
