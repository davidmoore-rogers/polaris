/**
 * tests/unit/configSecretFields.test.ts
 *
 * The secret-field walk the Prisma extension uses. Two things are load-bearing:
 *
 *   - It must reach secrets NESTED inside per-class config blocks. Integration
 *     config nests them (e.g. fortigateMonitor.password), and a shallow walk
 *     would leave those in plaintext while looking like it worked.
 *   - It must NOT touch anything else. monitorOverrideService reads
 *     `integrations.config #>> '{fortigateMonitor,addAsMonitored}'` in raw SQL,
 *     which bypasses the extension entirely — so if the walk mangled non-secret
 *     fields, that query would silently start reading ciphertext.
 */

import { describe, it, expect } from "vitest";
import {
  SECRET_CONFIG_KEYS,
  SECRET_BEARING_MODELS,
  secretJsonFieldFor,
  transformSecretFields,
} from "../../src/utils/configSecretFields.js";

const wrap = (s: string) => `SEALED(${s})`;

describe("transformSecretFields", () => {
  it("transforms secret-keyed strings and leaves everything else alone", () => {
    const out = transformSecretFields(
      { host: "fmg.example.com", username: "polaris", password: "hunter2", port: 443, enabled: true },
      wrap,
    ) as Record<string, unknown>;
    expect(out.password).toBe("SEALED(hunter2)");
    expect(out.host).toBe("fmg.example.com");
    expect(out.username).toBe("polaris");
    expect(out.port).toBe(443);
    expect(out.enabled).toBe(true);
  });

  it("reaches secrets nested inside per-class config blocks", () => {
    const out = transformSecretFields(
      {
        deviceFilter: ["a", "b"],
        fortigateMonitor: { addAsMonitored: true, password: "nested-secret" },
        vmMonitor: { streams: { interfaces: true }, apiToken: "deep-token" },
      },
      wrap,
    ) as any;
    expect(out.fortigateMonitor.password).toBe("SEALED(nested-secret)");
    expect(out.vmMonitor.apiToken).toBe("SEALED(deep-token)");
    // The flag raw SQL reads must survive untouched.
    expect(out.fortigateMonitor.addAsMonitored).toBe(true);
    expect(out.vmMonitor.streams.interfaces).toBe(true);
    expect(out.deviceFilter).toEqual(["a", "b"]);
  });

  it("walks into arrays of objects", () => {
    const out = transformSecretFields(
      { targets: [{ channelId: "c1", token: "t1" }, { channelId: "c2", token: "t2" }] },
      wrap,
    ) as any;
    expect(out.targets[0].token).toBe("SEALED(t1)");
    expect(out.targets[1].token).toBe("SEALED(t2)");
    expect(out.targets[0].channelId).toBe("c1");
  });

  it("never mutates the input (Prisma args + results are shared with callers)", () => {
    const input = { password: "original", nested: { apiToken: "orig2" } };
    const out = transformSecretFields(input, wrap) as any;
    expect(input.password).toBe("original");
    expect(input.nested.apiToken).toBe("orig2");
    expect(out.password).toBe("SEALED(original)");
  });

  it("passes through primitives, null and non-string secret values", () => {
    expect(transformSecretFields(null, wrap)).toBeNull();
    expect(transformSecretFields(42, wrap)).toBe(42);
    expect(transformSecretFields("bare string", wrap)).toBe("bare string");
    // A boolean under a secret key is not a secret to seal.
    const out = transformSecretFields({ password: false }, wrap) as any;
    expect(out.password).toBe(false);
  });

  it("stops at the depth cap rather than recursing without bound", () => {
    // Build a chain deeper than MAX_WALK_DEPTH with a secret at the bottom.
    let deep: any = { password: "too-deep" };
    for (let i = 0; i < 12; i++) deep = { nest: deep };
    expect(() => transformSecretFields(deep, wrap)).not.toThrow();
  });

  it("round-trips through a seal/open pair", () => {
    const seal = (s: string) => `#${s}`;
    const open = (s: string) => (s.startsWith("#") ? s.slice(1) : s);
    const original = { host: "h", password: "p", block: { apiToken: "t" } };
    const sealed = transformSecretFields(original, seal);
    expect(transformSecretFields(sealed, open)).toEqual(original);
  });
});

describe("registry", () => {
  it("covers every field name the three masking lists treat as secret", () => {
    // Kept in step by hand; this test is the tripwire. Under-sealing stores a
    // real secret in plaintext, which is the bug being fixed.
    for (const key of [
      // credentialService SECRET_FIELDS_BY_TYPE
      "community", "authKey", "privKey", "password", "privateKey", "apiToken",
      // integrations stripSecret
      "fortigateApiToken", "clientSecret", "bindPassword",
      // CHANNEL_TYPE_META secret: true
      "accessToken", "webhookUrl",
    ]) {
      expect(SECRET_CONFIG_KEYS.has(key), key).toBe(true);
    }
  });

  it("names the right JSON column per model", () => {
    expect(secretJsonFieldFor("Setting")).toBe("value");
    expect(secretJsonFieldFor("Credential")).toBe("config");
    expect(secretJsonFieldFor("Integration")).toBe("config");
    expect(secretJsonFieldFor("NotificationChannel")).toBe("config");
    expect(secretJsonFieldFor("Asset")).toBeNull();
  });

  it("lists exactly the models the db.ts extension registers hooks for", () => {
    // A model here without a hook in db.ts would be sealed by the backfill and
    // then never opened on read — the credential would just stop working.
    expect([...SECRET_BEARING_MODELS].sort()).toEqual([
      "Credential", "Integration", "NotificationChannel", "Setting",
    ]);
  });
});
