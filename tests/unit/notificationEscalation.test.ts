/**
 * tests/unit/notificationEscalation.test.ts
 *
 * Pure-function coverage for the escalation sweep's due-tier math (tierIsDue)
 * and the composed-email builder's default/override behavior
 * (buildComposedEmail). The DB-bound sweep pass is exercised end-to-end in
 * the dev walkthrough.
 */

import { describe, it, expect } from "vitest";
import { tierIsDue } from "../../src/services/notificationEscalationService.js";
import { buildComposedEmail } from "../../src/services/notificationEngine.js";
import { buildTemplateContext } from "../../src/utils/notificationTemplate.js";
import type { EscalationTier } from "../../src/services/notificationTypes.js";

const T0 = new Date("2026-07-04T12:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const tier = (extra: Partial<EscalationTier> = {}): EscalationTier => ({
  afterMin: 15,
  channelId: "ch-1",
  to: { addresses: ["oncall@example.com"] },
  ...extra,
});
const sent = (lastMin: number, count: number) => ({ firstSentAt: at(lastMin).toISOString(), lastSentAt: at(lastMin).toISOString(), count });

describe("tierIsDue", () => {
  it("is not due before the delay elapses, due after", () => {
    expect(tierIsDue(tier(), T0, undefined, at(14))).toBe(false);
    expect(tierIsDue(tier(), T0, undefined, at(15))).toBe(true);
    expect(tierIsDue(tier(), T0, undefined, at(200))).toBe(true);
  });

  it("send-once tiers never re-fire after the first send", () => {
    expect(tierIsDue(tier(), T0, sent(15, 1), at(500))).toBe(false);
  });

  it("repeating tiers re-fire on the repeat interval", () => {
    const t = tier({ repeatEveryMin: 30 });
    expect(tierIsDue(t, T0, sent(15, 1), at(44))).toBe(false); // 29m since last
    expect(tierIsDue(t, T0, sent(15, 1), at(45))).toBe(true); // 30m since last
  });

  it("repeating tiers stop at maxRepeats (default 5)", () => {
    const t = tier({ repeatEveryMin: 30 });
    expect(tierIsDue(t, T0, sent(15, 5), at(999))).toBe(false); // default cap
    const capped = tier({ repeatEveryMin: 30, maxRepeats: 2 });
    expect(tierIsDue(capped, T0, sent(15, 1), at(60))).toBe(true);
    expect(tierIsDue(capped, T0, sent(15, 2), at(999))).toBe(false);
  });
});

describe("buildComposedEmail", () => {
  const ctx = buildTemplateContext({
    asset: "fw-atl-01",
    metric: "cpuPct",
    value: "97.5",
    threshold: "90",
    severity: "critical",
    message: "High CPU: fw-atl-01",
    // What the body actually leads with. Every current fire stamps it; the
    // message is deliberately NOT printed under it (the two said the same
    // thing), so assertions about the body's content probe this.
    triggerSummary: "CPU utilization is 97.5%",
    link: "https://polaris.example.com/notifications.html",
    ruleName: "High CPU",
  });

  it("defaults to the shared rich alert body — the same text the wizard prefills", () => {
    // Was "[SEV] asset" + message + a View: link to the automations page. The
    // default is now the full device email (alertEmailTemplate), so an
    // automation that customizes nothing still tells the reader which device,
    // where it hangs, and how to acknowledge.
    const c = buildComposedEmail({}, ctx);
    expect(c.subject).toBe("[CRITICAL] fw-atl-01 — High CPU");
    expect(c.text).toContain("CPU utilization is 97.5%"); // what fired leads
    expect(c.text).toContain("Acknowledge:");
    expect(c.html).toContain("Acknowledge alert");
    expect(c.html).toContain("fw-atl-01");
  });

  it("renders subject/text templates and HTML with escaped values", () => {
    const c = buildComposedEmail(
      {
        subjectTemplate: "{rule}: {asset} at {value}",
        bodyTextTemplate: "{message} (limit {threshold})",
        bodyHtmlTemplate: "<p>{asset} & more</p>",
      },
      { ...ctx, asset: "a<b" },
    );
    expect(c.subject).toBe("High CPU: a<b at 97.5");
    expect(c.text).toBe("High CPU: fw-atl-01 (limit 90)");
    expect(c.html).toBe("<p>a&lt;b & more</p>"); // value escaped, template markup untouched
  });

  it("passes cc/bcc through unresolved", () => {
    const c = buildComposedEmail({ cc: { addresses: ["cc@example.com"] }, bcc: { recipientUserIds: ["u1"] } }, ctx);
    expect(c.cc).toEqual({ addresses: ["cc@example.com"] });
    expect(c.bcc).toEqual({ recipientUserIds: ["u1"] });
  });

  it("drops the rows whose value is empty rather than mailing blank cells", () => {
    // Every {asset.*} token renders "" when the field is unset, so a device
    // Polaris knows little about must not produce a table of empty labels.
    const c = buildComposedEmail({}, ctx); // ctx carries no assetDetail at all
    expect(c.text).not.toMatch(/^(Switch|AP|IP):\s*$/m);
    expect(c.html).not.toContain("Connected AP");
    expect(c.html).toContain("CPU utilization is 97.5%");
  });

  it("never leaks a literal token from OUR default when the context predates it", () => {
    // An escalation re-renders from a stored Notification.templateCtx, which
    // may have been built before a token existed. Operator templates keep an
    // unknown token visible (a typo should be); ours renders blank.
    const stale = { asset: "fw-atl-01", severity: "critical", "severity.upper": "CRITICAL", message: "m" };
    const c = buildComposedEmail({}, stale);
    expect(c.subject).toBe("[CRITICAL] fw-atl-01"); // trailing " — {rule}" gone, not printed
    expect(c.text).not.toContain("{rule}");
    expect(c.html).not.toContain("{rule}");
    // The DEFERRED tokens must survive: they're filled per recipient at fan-out
    // ({ack}) and per delivery at send time ({chart.*}).
    expect(c.text).toContain("{ack}");
    expect(c.text).toContain("{chart.cpu}");
  });
});
