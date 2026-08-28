import { describe, it, expect } from "vitest";
import {
  parseDigestChallenge,
  buildDigestAuthorization,
  authSchemesOffered,
  newCnonce,
} from "../../src/utils/digestAuth.js";

/**
 * The response hashes below are the published test vectors from RFC 2617 §3.5
 * and RFC 7616 §3.9.1 — NOT values captured from this implementation. That is
 * the point of them: a digest client that computes a self-consistent but wrong
 * hash authenticates against nothing, and a test asserting its own output would
 * pass just as happily. If one of these fails, the implementation is wrong.
 */
describe("buildDigestAuthorization — RFC test vectors", () => {
  it("matches RFC 2617 §3.5 (MD5, qop=auth)", () => {
    const header = buildDigestAuthorization({
      challenge: {
        realm: "testrealm@host.com",
        nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
        qop: ["auth"],
        opaque: "5ccc069c403ebaf9f0171e9517f40e41",
        stale: false,
      },
      username: "Mufasa",
      password: "Circle Of Life",
      method: "GET",
      uri: "/dir/index.html",
      cnonce: "0a4f113b",
      nc: 1,
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain("nc=00000001");
    expect(header).toContain("qop=auth");
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it("matches RFC 7616 §3.9.1 (SHA-256)", () => {
    const header = buildDigestAuthorization({
      challenge: {
        realm: "http-auth@example.org",
        nonce: "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
        qop: ["auth", "auth-int"],
        opaque: "FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS",
        algorithm: "SHA-256",
        stale: false,
      },
      username: "Mufasa",
      password: "Circle of Life",
      method: "GET",
      uri: "/dir/index.html",
      cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
      nc: 1,
    });
    expect(header).toContain(
      'response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"',
    );
    expect(header).toContain("algorithm=SHA-256");
  });

  it("matches RFC 7616 §3.9.1 (MD5 variant of the same exchange)", () => {
    const header = buildDigestAuthorization({
      challenge: {
        realm: "http-auth@example.org",
        nonce: "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
        qop: ["auth", "auth-int"],
        opaque: "FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS",
        algorithm: "MD5",
        stale: false,
      },
      username: "Mufasa",
      password: "Circle of Life",
      method: "GET",
      uri: "/dir/index.html",
      cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
      nc: 1,
    });
    expect(header).toContain('response="8ca523f5e9506fed4657c9700eebdbec"');
  });
});

describe("buildDigestAuthorization — shape and refusals", () => {
  const base = {
    username: "u",
    password: "p",
    method: "GET",
    uri: "/x",
    cnonce: "abc123",
  };

  it("omits qop/nc/cnonce in RFC 2069 mode (server offered no qop)", () => {
    const header = buildDigestAuthorization({
      ...base,
      challenge: { realm: "r", nonce: "n", qop: [], stale: false },
    });
    expect(header).not.toContain("qop=");
    expect(header).not.toContain("nc=");
    expect(header).not.toContain("cnonce=");
    expect(header).toContain('response="');
  });

  it("omits algorithm when the server named none", () => {
    const header = buildDigestAuthorization({
      ...base,
      challenge: { realm: "r", nonce: "n", qop: ["auth"], stale: false },
    });
    expect(header).not.toContain("algorithm=");
  });

  it("omits opaque when the server sent none", () => {
    const header = buildDigestAuthorization({
      ...base,
      challenge: { realm: "r", nonce: "n", qop: ["auth"], stale: false },
    });
    expect(header).not.toContain("opaque=");
  });

  it("re-keys HA1 for a -sess algorithm, producing a different response", () => {
    const challenge = { realm: "r", nonce: "n", qop: ["auth"], stale: false };
    const plain = buildDigestAuthorization({ ...base, challenge: { ...challenge, algorithm: "MD5" } });
    const sess  = buildDigestAuthorization({ ...base, challenge: { ...challenge, algorithm: "MD5-sess" } });
    expect(plain).not.toEqual(sess);
    expect(sess).toContain("algorithm=MD5-sess");
  });

  it("formats nc as 8 lowercase hex digits", () => {
    const header = buildDigestAuthorization({
      ...base,
      challenge: { realm: "r", nonce: "n", qop: ["auth"], stale: false },
      nc: 255,
    });
    expect(header).toContain("nc=000000ff");
  });

  it("refuses auth-int rather than computing a wrong hash", () => {
    expect(() =>
      buildDigestAuthorization({
        ...base,
        challenge: { realm: "r", nonce: "n", qop: ["auth-int"], stale: false },
      }),
    ).toThrow(/auth-int/);
  });

  it("refuses an algorithm it cannot compute", () => {
    expect(() =>
      buildDigestAuthorization({
        ...base,
        challenge: { realm: "r", nonce: "n", qop: ["auth"], algorithm: "GOST", stale: false },
      }),
    ).toThrow(/Unsupported digest algorithm/);
  });

  it("escapes a quote inside a value rather than breaking the header", () => {
    const header = buildDigestAuthorization({
      ...base,
      username: 'ad"min',
      challenge: { realm: "r", nonce: "n", qop: ["auth"], stale: false },
    });
    expect(header).toContain('username="ad\\"min"');
  });

  it("escapes a backslash so a server-supplied value cannot swallow the delimiter", () => {
    // realm / nonce / opaque are echoed back from the SERVER's challenge, so a
    // value ending in a backslash is not necessarily ours. Escaping only the
    // quote left that backslash escaping our own closing delimiter, merging
    // realm into the following field and corrupting the rest of the header.
    const header = buildDigestAuthorization({
      ...base,
      challenge: { realm: "evil\\", nonce: "n", qop: ["auth"], stale: false },
    });
    expect(header).toContain('realm="evil\\\\"');
    expect(header).toContain('nonce="n"');
  });
});

describe("parseDigestChallenge", () => {
  it("parses a typical Axis-style challenge", () => {
    const c = parseDigestChallenge(
      'Digest realm="AXIS_ACCC8E123456", nonce="0004cf1eY123456", stale=FALSE, qop="auth"',
    );
    expect(c).not.toBeNull();
    expect(c!.realm).toBe("AXIS_ACCC8E123456");
    expect(c!.nonce).toBe("0004cf1eY123456");
    expect(c!.qop).toEqual(["auth"]);
    expect(c!.stale).toBe(false);
  });

  it("keeps qop intact when it carries an internal comma", () => {
    const c = parseDigestChallenge('Digest realm="r", qop="auth,auth-int", nonce="n"');
    expect(c!.qop).toEqual(["auth", "auth-int"]);
  });

  it("picks Digest out of a header that also offers Basic", () => {
    const c = parseDigestChallenge('Basic realm="ignore-me", Digest realm="real", nonce="n", qop="auth"');
    expect(c!.realm).toBe("real");
    expect(c!.nonce).toBe("n");
  });

  it("picks Digest when Basic is listed second", () => {
    const c = parseDigestChallenge('Digest realm="real", nonce="n", Basic realm="ignore-me"');
    expect(c!.realm).toBe("real");
    expect(c!.nonce).toBe("n");
  });

  it("reads an unquoted algorithm token", () => {
    const c = parseDigestChallenge('Digest realm="r", nonce="n", algorithm=SHA-256, qop="auth"');
    expect(c!.algorithm).toBe("SHA-256");
  });

  it("reads stale=true case-insensitively", () => {
    expect(parseDigestChallenge('Digest realm="r", nonce="n", stale=TRUE')!.stale).toBe(true);
    expect(parseDigestChallenge('Digest realm="r", nonce="n", stale=true')!.stale).toBe(true);
  });

  it("unescapes an escaped quote in a value", () => {
    const c = parseDigestChallenge('Digest realm="say \\"hi\\"", nonce="n"');
    expect(c!.realm).toBe('say "hi"');
  });

  it("returns null for a Basic-only challenge", () => {
    expect(parseDigestChallenge('Basic realm="r"')).toBeNull();
  });

  it("returns null when the challenge is missing the nonce", () => {
    expect(parseDigestChallenge('Digest realm="r", qop="auth"')).toBeNull();
  });

  it("returns null on empty / absent headers", () => {
    expect(parseDigestChallenge(null)).toBeNull();
    expect(parseDigestChallenge(undefined)).toBeNull();
    expect(parseDigestChallenge("")).toBeNull();
  });

  it("accepts an empty realm, which is legal and load-bearing for the hash", () => {
    const c = parseDigestChallenge('Digest realm="", nonce="n", qop="auth"');
    expect(c).not.toBeNull();
    expect(c!.realm).toBe("");
  });
});

describe("authSchemesOffered", () => {
  it("lists every scheme in order", () => {
    expect(authSchemesOffered('Basic realm="a", Digest realm="b", nonce="n"')).toEqual(["Basic", "Digest"]);
  });

  it("lists a bare scheme with no parameters", () => {
    expect(authSchemesOffered("Negotiate")).toEqual(["Negotiate"]);
  });

  it("does not mistake a parameter for a scheme", () => {
    expect(authSchemesOffered('Digest realm="a", nonce="n", qop="auth"')).toEqual(["Digest"]);
  });

  it("is empty for an absent header", () => {
    expect(authSchemesOffered(null)).toEqual([]);
  });
});

describe("newCnonce", () => {
  it("is 32 hex chars and does not repeat", () => {
    const a = newCnonce();
    const b = newCnonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toEqual(b);
  });
});
