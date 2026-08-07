import { describe, it, expect, afterEach } from "vitest";
import { pushDeepLinkUrl, normalizePushSurface, PUSH_DEEP_LINK_PATHS } from "../../src/utils/notificationTemplate.js";

const ORIGINAL = process.env.POLARIS_PUBLIC_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.POLARIS_PUBLIC_URL;
  else process.env.POLARIS_PUBLIC_URL = ORIGINAL;
});

describe("normalizePushSurface", () => {
  it("only ever yields a known surface", () => {
    expect(normalizePushSurface("mobile")).toBe("mobile");
    expect(normalizePushSurface("desktop")).toBe("desktop");
    // Anything unrecognized (pre-upgrade rows, absent meta, junk) is desktop —
    // that's where the only enrollment UI used to live.
    for (const junk of [undefined, null, "", "MOBILE", "phone", 7, {}]) {
      expect(normalizePushSurface(junk)).toBe("desktop");
    }
  });
});

describe("pushDeepLinkUrl", () => {
  it("sends a mobile subscription to the mobile alerts screen", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(pushDeepLinkUrl("mobile")).toBe("https://polaris.example.com/mobile.html#more/alerts");
  });

  it("sends a desktop subscription to the Automations page", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(pushDeepLinkUrl("desktop")).toBe("https://polaris.example.com/automations.html");
  });

  it("strips a trailing slash on the public URL", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com/";
    expect(pushDeepLinkUrl("mobile")).toBe("https://polaris.example.com/mobile.html#more/alerts");
  });

  it("falls back to a RELATIVE path when POLARIS_PUBLIC_URL is unset", () => {
    // Never null, unlike notificationsPageUrl. This is what stops an unset
    // public URL from routing every push to the service worker's hardcoded
    // desktop fallback regardless of surface.
    delete process.env.POLARIS_PUBLIC_URL;
    expect(pushDeepLinkUrl("mobile")).toBe("/mobile.html#more/alerts");
    expect(pushDeepLinkUrl("desktop")).toBe("/automations.html");
  });

  it("never returns null or empty for any input", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    for (const junk of [undefined, null, "", "nonsense"]) {
      expect(pushDeepLinkUrl(junk)).toBe(PUSH_DEEP_LINK_PATHS.desktop);
    }
  });
});
