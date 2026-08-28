/**
 * tests/unit/automationTestDelivery.test.ts
 *
 * selectTestActions — the safety core of the wizard's Test-delivery buttons.
 *
 * Two of these assertions are the difference between a convenience feature and
 * an incident: a test button that runs a registry script is RCE-by-button, and
 * a test has to be structurally incapable of reaching anyone but the caller
 * rather than a flag someone downstream is trusted to honour. There is no
 * recipient mode any more — every test goes to the operator who pressed the
 * button, so these cases all assert the rewrite.
 */

import { describe, it, expect } from "vitest";
import { selectTestActions } from "../../src/services/automationTestService.js";

const CALLER = "user-me";

const draft = (actions: unknown[], extra: Record<string, unknown> = {}) =>
  ({ actions, severityBands: null, bandNotify: null, resetActions: null, escalation: null, ...extra }) as never;

describe("selectTestActions", () => {
  it("addresses the action at the walked index", () => {
    const d = draft([
      { type: "event" },
      { type: "notify", channelId: "ch-b", recipientAllUsers: true },
    ]);
    const { actions } = selectTestActions(d, { index: 1 }, CALLER);
    // Index 1 is the notify, not the event at index 0 — and it comes back with
    // the caller substituted for the draft's own recipients.
    expect(actions).toEqual([{ type: "notify", channelId: "ch-b", recipientUserIds: [CALLER] }]);
  });

  it("NEVER runs a script from a test button", () => {
    const d = draft([{ type: "script", scriptId: "s1", runOn: "server" }]);
    const { actions, skipped } = selectTestActions(d, { index: 0 }, CALLER);
    expect(actions).toEqual([]);
    expect(skipped[0]!.type).toBe("script");
  });

  it("NEVER fires an api_call from a test button", () => {
    // A live PagerDuty / ServiceNow call would open a real ticket.
    const d = draft([{ type: "api_call", method: "POST", url: "https://pager.example.com", timeoutSec: 15 }]);
    const { actions, skipped } = selectTestActions(d, { index: 0 }, CALLER);
    expect(actions).toEqual([]);
    expect(skipped[0]!.type).toBe("api_call");
  });

  it("drops EVERY route to anyone but the caller", () => {
    const d = draft([{
      type: "notify",
      channelId: "ch-a",
      recipientUserIds: ["someone-else"],
      addresses: ["vendor@example.net"],
      recipientRoles: ["role-noc"],
      recipientAllUsers: true,
      recipientAllRegions: true,
      recipientRegions: ["Atlanta"],
      recipientDeviceRegion: true,
      recipientScopeRegion: true,
      recipientAssetContacts: true,
      recipientTags: ["region:Atlanta"],
    }]);
    const { actions } = selectTestActions(d, { index: 0 }, CALLER);
    expect(actions).toEqual([{ type: "notify", channelId: "ch-a", recipientUserIds: [CALLER] }]);
  });

  it("keeps the operator's message but strips cc/bcc", () => {
    // Seeing the real subject/body is the point of the test; cc/bcc are
    // recipients wearing another name and would reach real people.
    const d = draft([{
      type: "notify",
      channelId: "ch-a",
      emailComposition: {
        subjectTemplate: "[{severity.upper}] {asset}",
        bodyTextTemplate: "{message}",
        cc: { addresses: ["boss@example.com"] },
        bcc: { recipientUserIds: ["someone"] },
      },
    }]);
    const { actions } = selectTestActions(d, { index: 0 }, CALLER);
    const a = actions[0] as Record<string, any>;
    expect(a.emailComposition.subjectTemplate).toBe("[{severity.upper}] {asset}");
    expect(a.emailComposition.cc).toBeNull();
    expect(a.emailComposition.bcc).toBeNull();
    expect(a.recipientUserIds).toEqual([CALLER]);
  });

  it("has no mode that can reach the automation's real recipients", () => {
    // The old `mode: "recipients"` pass-through is GONE, not defaulted off: the
    // only shape this can return for a notify action is the caller's own id.
    const action = { type: "notify", channelId: "ch-a", recipientRoles: ["role-noc"], recipientAllUsers: true };
    const { actions } = selectTestActions(draft([action]), { index: 0 }, CALLER);
    expect(actions).toEqual([{ type: "notify", channelId: "ch-a", recipientUserIds: [CALLER] }]);
  });

  it("reaches actions that live off the top level (bands, chains, reset)", () => {
    // The index addresses allRuleActionRefs' walk, so a channel used only by a
    // severity band or the reset list is still testable.
    const d = draft(
      [{ type: "notify", channelId: "ch-base" }],
      {
        severityBands: [{ threshold: 95, severity: "critical", actions: [{ type: "notify", channelId: "ch-band" }] }],
        resetActions: [{ type: "notify", channelId: "ch-reset" }],
      },
    );
    const band = selectTestActions(d, { index: 1 }, CALLER);
    expect((band.actions[0] as Record<string, string>).channelId).toBe("ch-band");
    const reset = selectTestActions(d, { index: 2 }, CALLER);
    expect((reset.actions[0] as Record<string, string>).channelId).toBe("ch-reset");
  });

  it("rejects an index the draft no longer has", () => {
    expect(() => selectTestActions(draft([]), { index: 7 }, CALLER)).toThrow(/no longer part/);
  });
});
