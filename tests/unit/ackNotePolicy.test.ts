/**
 * tests/unit/ackNotePolicy.test.ts — the per-automation "acknowledging this
 * needs a note" policy (NotificationRule.requireAckNote).
 *
 * The flag is only worth anything if it is enforced where the WRITE happens:
 * four surfaces acknowledge (the Alerts tab, the mobile list, the emailed
 * one-click link, the web-push action button) and three of them can do it
 * without ever rendering a form. So the modal's required field is a courtesy
 * and acknowledgeNotifications' refusal is the control — which is what these
 * two pure helpers behind it pin down.
 */

import { describe, it, expect } from "vitest";
import { ackNoteProblem, withAckPolicy } from "../../src/services/notificationService.js";

describe("ackNoteProblem", () => {
  it("passes when nothing in the batch demands a note", () => {
    expect(ackNoteProblem(0, 5, "")).toBeNull();
  });

  it("passes when a note was supplied", () => {
    expect(ackNoteProblem(3, 5, "switch stack rebooted, replaced the SFP")).toBeNull();
  });

  it("treats a whitespace-only note as no note at all", () => {
    // The note is stored trimmed, so "   " would persist as NULL — accepting it
    // would satisfy the policy with nothing written.
    expect(ackNoteProblem(1, 1, "   \n\t ")).not.toBeNull();
  });

  it("names the single-alert case in the singular", () => {
    const msg = ackNoteProblem(1, 1, "");
    expect(msg).toMatch(/requires a note/);
    expect(msg).not.toMatch(/\d+ of these/);
  });

  it("reports how many of a batch demand one, not the batch size", () => {
    // The operator selected twelve rows; two of them come from an automation
    // that wants a note. Saying "12 alerts require a note" would be a lie they
    // can't act on.
    expect(ackNoteProblem(2, 12, "")).toMatch(/^2 of these alerts/);
  });

  it("refuses the whole batch rather than part of it", () => {
    // One shared note applies to every id in the request, so there is no
    // partial-success shape to report — and quietly acknowledging the
    // note-free half would leave the alerts that mattered open under a
    // success toast.
    expect(ackNoteProblem(1, 12, "")).not.toBeNull();
  });
});

describe("withAckPolicy", () => {
  it("flattens the joined rule into a plain boolean and drops the join", () => {
    const row = withAckPolicy({ id: "n1", message: "down", rule: { requireAckNote: true } });
    expect(row.requireAckNote).toBe(true);
    expect("rule" in row).toBe(false);
    expect(row.id).toBe("n1");
  });

  it("reads false for a rule-less alert", () => {
    // A test fire (ruleId is always null) or an alert whose automation was
    // deleted (SetNull). There is no policy left to enforce, and refusing to
    // let anyone close those out would be worse than a missing note.
    expect(withAckPolicy({ id: "n2", rule: null }).requireAckNote).toBe(false);
    expect(withAckPolicy({ id: "n3" }).requireAckNote).toBe(false);
  });

  it("reads false for a rule that doesn't require one", () => {
    expect(withAckPolicy({ id: "n4", rule: { requireAckNote: false } }).requireAckNote).toBe(false);
  });
});
