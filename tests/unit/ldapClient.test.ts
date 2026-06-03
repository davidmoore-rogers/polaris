/**
 * tests/unit/ldapClient.test.ts — LDAP filter-injection escaping + GUID decode
 */

import { describe, it, expect } from "vitest";
import { escapeLdapFilterValue, decodeObjectGuid } from "../../src/services/ldapClient.js";

describe("escapeLdapFilterValue (RFC 4515)", () => {
  it("escapes the five special characters", () => {
    expect(escapeLdapFilterValue("*")).toBe("\\2a");
    expect(escapeLdapFilterValue("(")).toBe("\\28");
    expect(escapeLdapFilterValue(")")).toBe("\\29");
    expect(escapeLdapFilterValue("\\")).toBe("\\5c");
    expect(escapeLdapFilterValue("\0")).toBe("\\00");
  });

  it("neutralizes an injection attempt", () => {
    // `*)(uid=*` would otherwise broaden the search to every entry.
    expect(escapeLdapFilterValue("*)(uid=*")).toBe("\\2a\\29\\28uid=\\2a");
  });

  it("escapes the backslash before other characters (no double-escape)", () => {
    // A literal backslash-star must become \5c\2a, not \5c5c2a or similar.
    expect(escapeLdapFilterValue("\\*")).toBe("\\5c\\2a");
  });

  it("leaves ordinary usernames untouched", () => {
    expect(escapeLdapFilterValue("jdoe")).toBe("jdoe");
    expect(escapeLdapFilterValue("first.last")).toBe("first.last");
  });
});

describe("decodeObjectGuid", () => {
  it("decodes a 16-byte buffer to lowercase hex", () => {
    const buf = Buffer.from([0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255]);
    expect(decodeObjectGuid(buf)).toBe("00112233445566778899aabbccddeeff");
  });

  it("returns empty string for a wrong-length buffer", () => {
    expect(decodeObjectGuid(Buffer.from([1, 2, 3]))).toBe("");
  });
});
