/**
 * tests/unit/ackLinkRouting.test.ts
 *
 * Who gets an acknowledge link, and where it points.
 *
 * The rule the whole feature rests on: only a configured Polaris USER can
 * acknowledge, because the token records who did it. An address-book contact
 * or a typed address is an address with nobody behind it, so it must receive
 * the alert WITHOUT a link — silently, not as a broken one.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  buildAddressOwnerMap,
  composedAckRecipient,
  applyAckToRows,
} from "../../src/services/notificationRecipientService.js";
import {
  ackUrlForEmail,
  ackUrlForPush,
  assetPageUrl,
  substituteAckToken,
  buildTemplateContext,
  TEMPLATE_VARIABLES,
} from "../../src/utils/notificationTemplate.js";
import { appendAckLine } from "../../src/services/notificationDeliveryService.js";

const user = (id: string, email: string | null) => ({ id, email, displayName: null });

describe("buildAddressOwnerMap", () => {
  it("owns a user's own address and leaves typed/contact addresses unowned", () => {
    const m = buildAddressOwnerMap(
      [user("u1", "dana@example.com")],
      ["vendor-noc@example.net"],
      ["oncall-list@example.org"],
    );
    expect(m.get("dana@example.com")?.id).toBe("u1");
    expect(m.get("vendor-noc@example.net")).toBeNull();
    expect(m.get("oncall-list@example.org")).toBeNull();
  });

  it("normalizes case and surrounding whitespace on every source", () => {
    const m = buildAddressOwnerMap([user("u1", "  Dana@Example.COM ")], ["  TYPED@x.com"], []);
    expect(m.has("dana@example.com")).toBe(true);
    expect(m.has("typed@x.com")).toBe(true);
  });

  it("lets the user win when the same address was also typed by hand", () => {
    const m = buildAddressOwnerMap([user("u1", "dana@example.com")], ["dana@example.com"], []);
    expect(m.get("dana@example.com")?.id).toBe("u1");
    expect(m.size).toBe(1);
  });

  it("breaks a shared-address tie on the lowest id, so repeat sends agree", () => {
    const a = buildAddressOwnerMap([user("u2", "shared@x.com"), user("u1", "shared@x.com")], [], []);
    const b = buildAddressOwnerMap([user("u1", "shared@x.com"), user("u2", "shared@x.com")], [], []);
    expect(a.get("shared@x.com")?.id).toBe("u1");
    expect(b.get("shared@x.com")?.id).toBe("u1");
  });

  it("preserves the pre-feature To-line order: typed, then users, then contacts", () => {
    const m = buildAddressOwnerMap([user("u1", "user@x.com")], ["typed@x.com"], ["contact@x.com"]);
    expect(Array.from(m.keys())).toEqual(["typed@x.com", "user@x.com", "contact@x.com"]);
  });

  it("ignores users with no email address at all", () => {
    const m = buildAddressOwnerMap([user("u1", null)], [], []);
    expect(m.size).toBe(0);
  });
});

describe("composedAckRecipient", () => {
  const owners = buildAddressOwnerMap(
    [user("u1", "dana@example.com")],
    ["vendor@example.net"],
    [],
  );

  it("gives the link to a solo user recipient", () => {
    expect(composedAckRecipient(["dana@example.com"], [], [], owners)?.id).toBe("u1");
  });

  it("withholds it once a second person shares the body", () => {
    expect(composedAckRecipient(["dana@example.com", "vendor@example.net"], [], [], owners)).toBeNull();
  });

  it("withholds it when anyone is cc'd or bcc'd — they read the same message", () => {
    expect(composedAckRecipient(["dana@example.com"], ["vendor@example.net"], [], owners)).toBeNull();
    expect(composedAckRecipient(["dana@example.com"], [], ["vendor@example.net"], owners)).toBeNull();
  });

  it("withholds it from a lone address nobody owns", () => {
    expect(composedAckRecipient(["vendor@example.net"], [], [], owners)).toBeNull();
  });
});

describe("URL builders", () => {
  const prev = process.env.POLARIS_PUBLIC_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.POLARIS_PUBLIC_URL;
    else process.env.POLARIS_PUBLIC_URL = prev;
  });

  it("builds absolute email + asset URLs, tolerating a trailing slash", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com/";
    expect(ackUrlForEmail("polaris_ack_abc")).toBe("https://polaris.example.com/ack/polaris_ack_abc");
    expect(assetPageUrl("a-1")).toBe("https://polaris.example.com/assets.html#view=asset:a-1");
  });

  it("has no email link without a public URL — a relative URL is useless in mail", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    expect(ackUrlForEmail("polaris_ack_abc")).toBeNull();
    expect(assetPageUrl("a-1")).toBeNull();
  });

  it("still gives push a relative URL, which the service worker resolves", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    expect(ackUrlForPush("polaris_ack_abc")).toBe("/ack/polaris_ack_abc");
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(ackUrlForPush("polaris_ack_abc")).toBe("https://polaris.example.com/ack/polaris_ack_abc");
  });

  it("escapes an asset id into the hash rather than trusting it", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(assetPageUrl("a b/c")).toBe("https://polaris.example.com/assets.html#view=asset:a%20b%2Fc");
  });
});

describe("{ack} is deferred, not contextual", () => {
  it("is catalogued for the template picker", () => {
    expect(TEMPLATE_VARIABLES.some((v) => v.token === "{ack}")).toBe(true);
  });

  it("has NO key in buildTemplateContext", () => {
    // If it ever gains one it renders to "" at compose time — before recipients
    // are known — and the per-recipient substitution finds nothing to fill.
    expect("ack" in buildTemplateContext({})).toBe(false);
  });

  it("survives the compose-time render as a literal token", () => {
    const ctx = buildTemplateContext({ asset: "sw-1" });
    const rendered = renderish("Device {asset} — {ack}", ctx);
    expect(rendered).toBe("Device sw-1 — {ack}");
  });

  it("substitutes per recipient, and renders empty for one without a link", () => {
    expect(substituteAckToken("Ack: {ack}", "https://x/ack/t")).toBe("Ack: https://x/ack/t");
    expect(substituteAckToken("Ack: {ack}", null)).toBe("Ack: ");
  });

  it("escapes the URL when filling an HTML body", () => {
    const out = substituteAckToken('<a href="{ack}">Ack</a>', "https://x/ack/a&b", { html: true });
    expect(out).toBe('<a href="https://x/ack/a&amp;b">Ack</a>');
  });
});

describe("applyAckToRows", () => {
  const composedRow = () => ({
    notificationId: "n1",
    transport: "email",
    target: "someone@example.test",
    status: "pending",
    meta: { composed: true, to: ["someone@example.test"], subject: "alert", text: "Device sw-1\nAcknowledge: {ack}" },
  }) as never;

  it("fills the link for a row that earned a token", () => {
    const rows = [composedRow()];
    applyAckToRows(rows, [{ userId: "u1", channel: "email" }], new Map([["u1|email", "polaris_ack_abc"]]));
    const meta = (rows[0] as { meta: Record<string, unknown> }).meta;
    expect(meta.ack).toEqual({ token: "polaris_ack_abc", userId: "u1" });
    expect(String(meta.text)).toContain("/ack/polaris_ack_abc");
  });

  it("strips the literal token when NOTHING was minted for the whole fan-out", () => {
    // The regression: an automation whose only recipients are typed addresses
    // or contacts mints zero tokens. Short-circuiting on "nothing to mint"
    // mailed them the raw "{ack}".
    const rows = [composedRow()];
    applyAckToRows(rows, [null], new Map());
    const meta = (rows[0] as { meta: Record<string, unknown> }).meta;
    expect(String(meta.text)).not.toContain("{ack}");
    // The label goes with it — "Acknowledge:" followed by nothing reads broken.
    expect(String(meta.text)).not.toContain("Acknowledge:");
    expect(meta.ack).toBeUndefined();
  });

  it("resolves per row: a user gets a link, the contact beside them gets none", () => {
    const rows = [composedRow(), composedRow()];
    applyAckToRows(rows, [{ userId: "u1", channel: "email" }, null], new Map([["u1|email", "polaris_ack_xyz"]]));
    expect(String((rows[0] as { meta: Record<string, unknown> }).meta.text)).toContain("/ack/polaris_ack_xyz");
    expect(String((rows[1] as { meta: Record<string, unknown> }).meta.text)).not.toContain("ack");
  });
});

describe("appendAckLine", () => {
  it("adds the acknowledge line under the body", () => {
    expect(appendAckLine("down", "https://x/ack/t")).toBe("down\n\nAcknowledge this alert: https://x/ack/t");
  });

  it("leaves the body untouched with no link", () => {
    expect(appendAckLine("down", null)).toBe("down");
  });
});

// Local re-implementation of the render call under test's import surface, so
// this file doesn't need the renderer's options plumbing.
function renderish(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{([a-zA-Z][\w.]*)\}/g, (m, n: string) => (n in ctx ? ctx[n]! : m));
}
