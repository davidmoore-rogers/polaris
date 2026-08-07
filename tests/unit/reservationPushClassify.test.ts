/**
 * tests/unit/reservationPushClassify.test.ts
 *
 * Table-driven coverage of classifyPushError — the single source of truth
 * for whether a FortiGate / FortiManager push failure is permanent
 * (operator action required; create-time rolls back) or transient
 * (retry-eligible; create-time queues the row). Each test below maps to a
 * concrete error shape the push paths in reservationPushService can emit.
 */

import { describe, it, expect } from "vitest";
import { classifyPushError } from "../../src/services/reservationPushService.js";
import { AppError } from "../../src/utils/errors.js";

describe("classifyPushError", () => {
  describe("permanent", () => {
    it("400 invalid MAC", () => {
      expect(classifyPushError(new AppError(400, "Invalid MAC address: zz:zz"))).toBe("permanent");
    });

    it("400 invalid CIDR", () => {
      expect(classifyPushError(new AppError(400, "Invalid subnet CIDR: 999.0.0.0/24"))).toBe("permanent");
    });

    it("404 entry not found during update", () => {
      expect(classifyPushError(new AppError(404, "FortiGate has no reservation matching 10.0.0.5"))).toBe("permanent");
    });

    it("404 endpoint not found", () => {
      expect(classifyPushError(new AppError(404, "Endpoint not found: /api/v2/cmdb/...."))).toBe("permanent");
    });

    it("409 collision: existing IP on device", () => {
      expect(
        classifyPushError(new AppError(409, "FortiGate already has a reservation for 10.0.0.5 on this scope")),
      ).toBe("permanent");
    });

    it("409 collision: existing MAC on device", () => {
      expect(
        classifyPushError(new AppError(409, "FortiGate already has a reservation for MAC aa:bb:cc:dd:ee:ff")),
      ).toBe("permanent");
    });

    it("409 no scope matching CIDR", () => {
      expect(
        classifyPushError(new AppError(409, "FortiGate has no DHCP scope matching subnet 10.99.0.0/24")),
      ).toBe("permanent");
    });

    it("502 verify mismatch", () => {
      expect(
        classifyPushError(
          new AppError(
            502,
            "FortiGate verify mismatch — read back 10.0.0.6 / aa:bb:cc:dd:ee:00, wrote 10.0.0.5 / aa:bb:cc:dd:ee:ff",
          ),
        ),
      ).toBe("permanent");
    });

    it("502 not visible on read-back (write didn't land)", () => {
      expect(
        classifyPushError(
          new AppError(
            502,
            "FortiGate accepted the create but the entry was not visible on read-back for 10.0.0.5",
          ),
        ),
      ).toBe("permanent");
    });

    it("502 auth failure (bad API token)", () => {
      expect(
        classifyPushError(new AppError(502, "Authentication failed — check your API token")),
      ).toBe("permanent");
    });

    it("502 HTTP 403 from either transport (access profile / trusthost)", () => {
      // Needs an operator on the device — retrying until the queue gives up
      // only buries the reason.
      expect(
        classifyPushError(new AppError(502, "FortiGate permission denied (HTTP 403) on /api/v2/cmdb/system.dhcp/server — the API token authenticated, but the api-user's access profile does not permit this endpoint, or the Polaris host is outside its trusthost")),
      ).toBe("permanent");
      expect(
        classifyPushError(new AppError(502, "FortiManager permission denied (HTTP 403) — check the API user's admin profile")),
      ).toBe("permanent");
    });
  });

  describe("transient", () => {
    it("502 generic 5xx from FortiGate", () => {
      expect(classifyPushError(new AppError(502, "FortiGate returned HTTP 503"))).toBe("transient");
    });

    it("502 could not resolve management IP via FMG", () => {
      expect(
        classifyPushError(new AppError(502, 'Could not resolve management IP for "branch-fg-01" via FortiManager')),
      ).toBe("transient");
    });

    it("502 generic FortiOS error envelope", () => {
      // Generic 'FortiGate error (X): Y' wording is ambiguous — could be a
      // permanent CMDB rejection or a transient internal hiccup. Defaulting
      // to transient means we'll retry; if it's actually permanent the
      // failure will repeat on retry and the operator sees the error.
      expect(classifyPushError(new AppError(502, "FortiGate error (some_code): some message"))).toBe("transient");
    });

    it("non-AppError network errors (ECONNREFUSED, timeout, etc.)", () => {
      const refused = new Error("connect ECONNREFUSED 10.0.0.1:443") as Error & { code?: string };
      refused.code = "ECONNREFUSED";
      expect(classifyPushError(refused)).toBe("transient");

      const timed = new Error("The operation was aborted.") as Error & { name?: string };
      timed.name = "AbortError";
      expect(classifyPushError(timed)).toBe("transient");

      const dns = new Error("getaddrinfo ENOTFOUND fmg.example.com") as Error & { code?: string };
      dns.code = "ENOTFOUND";
      expect(classifyPushError(dns)).toBe("transient");
    });

    it("unknown error shapes", () => {
      expect(classifyPushError(new Error("something went wrong"))).toBe("transient");
      expect(classifyPushError("string error")).toBe("transient");
      expect(classifyPushError(null)).toBe("transient");
      expect(classifyPushError(undefined)).toBe("transient");
      expect(classifyPushError({ random: "object" })).toBe("transient");
    });

    it("AppError with unmapped status (e.g. 500, 503)", () => {
      // Anything we didn't explicitly enumerate as permanent defaults to
      // transient.
      expect(classifyPushError(new AppError(500, "Internal Server Error"))).toBe("transient");
      expect(classifyPushError(new AppError(503, "Service Unavailable"))).toBe("transient");
    });
  });
});
