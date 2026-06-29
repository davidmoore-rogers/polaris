/**
 * tests/unit/notificationDelivery.test.ts
 *
 * Pure-function coverage for the notification delivery layer: the
 * delivery-target Zod schema (superRefine rules per channel) and the webhook
 * body formatters (slack / teams / generic). The DB-bound recipient resolution
 * + drain path is exercised by the integration suite + the podman walkthrough.
 */

import { describe, it, expect } from "vitest";
import { deliveryTargetSchema } from "../../src/services/notificationTypes.js";
import { formatBody, type WebhookPayload } from "../../src/services/notificationChannels/webhookChannel.js";

describe("deliveryTargetSchema", () => {
  it("accepts an email target with explicit addresses", () => {
    const r = deliveryTargetSchema.safeParse({ channel: "email", addresses: ["a@example.com"] });
    expect(r.success).toBe(true);
  });
  it("accepts an email target routed by tags", () => {
    const r = deliveryTargetSchema.safeParse({ channel: "email", recipientTags: ["region:Atlanta"] });
    expect(r.success).toBe(true);
  });
  it("rejects an email target with neither addresses nor tags", () => {
    const r = deliveryTargetSchema.safeParse({ channel: "email" });
    expect(r.success).toBe(false);
  });
  it("requires a webhookUrl for a webhook target", () => {
    expect(deliveryTargetSchema.safeParse({ channel: "webhook" }).success).toBe(false);
    expect(deliveryTargetSchema.safeParse({ channel: "webhook", webhookUrl: "https://hooks.example.com/x" }).success).toBe(true);
  });
  it("rejects a non-URL webhookUrl", () => {
    expect(deliveryTargetSchema.safeParse({ channel: "webhook", webhookUrl: "not-a-url" }).success).toBe(false);
  });
  it("requires recipientTags for a web_push target", () => {
    expect(deliveryTargetSchema.safeParse({ channel: "web_push" }).success).toBe(false);
    expect(deliveryTargetSchema.safeParse({ channel: "web_push", recipientTags: ["region:Atlanta"] }).success).toBe(true);
  });
  it("rejects an invalid email address", () => {
    expect(deliveryTargetSchema.safeParse({ channel: "email", addresses: ["nope"] }).success).toBe(false);
  });
});

describe("formatBody", () => {
  const payload: WebhookPayload = {
    title: "[ERROR] sw-core-1",
    message: "CPU 95% > 90%",
    severity: "error",
    assetHostname: "sw-core-1",
    url: "https://polaris.example.com/notifications.html",
    triggeredAt: "2026-06-29T12:00:00.000Z",
  };

  it("slack → { text } with a link", () => {
    const body = formatBody("slack", payload) as { text: string };
    expect(body.text).toContain("[ERROR] sw-core-1");
    expect(body.text).toContain("CPU 95% > 90%");
    expect(body.text).toContain("<https://polaris.example.com/notifications.html|View>");
  });

  it("teams → MessageCard with severity color + action", () => {
    const body = formatBody("teams", payload) as Record<string, any>;
    expect(body["@type"]).toBe("MessageCard");
    expect(body.themeColor).toBe("dc2626"); // error
    expect(body.potentialAction[0].targets[0].uri).toBe(payload.url);
  });

  it("generic → full notification JSON", () => {
    const body = formatBody("generic", payload) as Record<string, any>;
    expect(body.source).toBe("polaris");
    expect(body.severity).toBe("error");
    expect(body.asset).toBe("sw-core-1");
    expect(body.message).toBe("CPU 95% > 90%");
  });

  it("teams omits the action when there is no url", () => {
    const body = formatBody("teams", { ...payload, url: null }) as Record<string, any>;
    expect(body.potentialAction).toBeUndefined();
  });
});
