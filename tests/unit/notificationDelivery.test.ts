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
import { scopeRegionTagsOf } from "../../src/services/notificationRecipientService.js";

describe("scopeRegionTagsOf", () => {
  it("extracts only region: tags from a scope", () => {
    expect(scopeRegionTagsOf({ tags: ["region:Atlanta", "prod", "firewall:fgt-1", "region:Nashville"] }))
      .toEqual(["region:Atlanta", "region:Nashville"]);
  });
  it("returns [] for no scope / no region tags", () => {
    expect(scopeRegionTagsOf(null)).toEqual([]);
    expect(scopeRegionTagsOf({ tags: ["prod"] })).toEqual([]);
    expect(scopeRegionTagsOf({})).toEqual([]);
  });
});

describe("deliveryTargetSchema", () => {
  it("accepts a target referencing a channel by id", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "ch-1" }).success).toBe(true);
  });
  it("accepts recipient routing (tags + explicit addresses)", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "ch-1", recipientTags: ["region:Atlanta"], addresses: ["a@example.com"] }).success).toBe(true);
  });
  it("requires a channelId", () => {
    expect(deliveryTargetSchema.safeParse({ recipientTags: ["x"] }).success).toBe(false);
    expect(deliveryTargetSchema.safeParse({ channelId: "" }).success).toBe(false);
  });
  it("rejects an invalid email address", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "ch-1", addresses: ["nope"] }).success).toBe(false);
  });
  it("accepts individual user-account recipients", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "ch-1", recipientUserIds: ["u1", "u2"] }).success).toBe(true);
  });
  it("accepts the scope-region recipient flag", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "ch-1", recipientScopeRegion: true }).success).toBe(true);
  });
  it("accepts a combination of recipient sources", () => {
    const r = deliveryTargetSchema.safeParse({ channelId: "ch-1", recipientUserIds: ["u1"], addresses: ["a@example.com"], recipientScopeRegion: true });
    expect(r.success).toBe(true);
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
