/**
 * tests/unit/backupPassword.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  validateBackupPassword,
  BACKUP_MIN_PASSWORD_LEN,
} from "../../src/utils/backupPassword.js";

describe("validateBackupPassword — no passphrase (unencrypted backup)", () => {
  it("returns null for undefined / null / empty / whitespace-only", () => {
    expect(validateBackupPassword(undefined)).toBeNull();
    expect(validateBackupPassword(null)).toBeNull();
    expect(validateBackupPassword("")).toBeNull();
    expect(validateBackupPassword("    ")).toBeNull();
  });
});

describe("validateBackupPassword — rejects weak passphrases", () => {
  it("rejects too-short", () => {
    expect(() => validateBackupPassword("short")).toThrowError(/at least 12/);
    // exactly one below the floor
    expect(() => validateBackupPassword("a".repeat(BACKUP_MIN_PASSWORD_LEN - 1))).toThrow();
  });

  it("rejects low-variety (single repeated char) even when long enough", () => {
    expect(() => validateBackupPassword("aaaaaaaaaaaaaaaa")).toThrowError(/too weak/);
    expect(() => validateBackupPassword("111111111111")).toThrowError(/too weak/);
  });

  it("tags the thrown error with code WEAK_BACKUP_PASSWORD", () => {
    try {
      validateBackupPassword("short");
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.code).toBe("WEAK_BACKUP_PASSWORD");
    }
  });

  it("rejects non-string input", () => {
    expect(() => validateBackupPassword(12345678 as unknown)).toThrowError(/must be text/);
  });
});

describe("validateBackupPassword — accepts strong passphrases", () => {
  it("returns the passphrase unchanged when valid", () => {
    expect(validateBackupPassword("Correct horse battery staple")).toBe(
      "Correct horse battery staple",
    );
    expect(validateBackupPassword("P@ssw0rd-2026-xyz")).toBe("P@ssw0rd-2026-xyz");
  });

  it("does NOT trim valid passphrases (spaces are key material)", () => {
    const pw = "  spaced passphrase value  ";
    expect(validateBackupPassword(pw)).toBe(pw);
  });
});
