/**
 * tests/unit/backupEnvelope.test.ts
 *
 * The on-disk format of an encrypted backup. This is a COMPATIBILITY contract,
 * not an implementation detail: an operator's existing `.enc.gz` files must keep
 * restoring after the backup path was rewritten from the in-memory
 * readFileSync/gzipSync version to a streamed one. If these offsets drift, every
 * previously-taken encrypted backup becomes unrestorable, and nothing else in
 * the suite would notice.
 *
 *   "POLARIS\0" | salt(32) | iv(16) | authTag(16) | AES-256-GCM(gzip(sql))
 *
 * Runs without a database or the PostgreSQL client tools — the true round trip
 * through pg_dump/psql lives in tests/integration/backupRestore.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { writeFileSync, unlinkSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BACKUP_MAGIC,
  ENCRYPTED_HEADER_LEN,
  isEncryptedBackupFile,
} from "../../src/services/backupService.js";

const SQL = "-- polaris dump\nCREATE TABLE t (id text);\nINSERT INTO t VALUES ('x');\n";
const PASSPHRASE = "correct-horse-battery-staple";

const scratch = mkdtempSync(join(tmpdir(), "polaris-backup-envelope-"));
const written: string[] = [];

function tmpFile(name: string, bytes: Buffer): string {
  const p = join(scratch, name);
  writeFileSync(p, bytes);
  written.push(p);
  return p;
}

afterEach(() => {
  while (written.length) {
    const p = written.pop()!;
    if (existsSync(p)) { try { unlinkSync(p); } catch { /* best effort */ } }
  }
});

/** Assemble an encrypted backup exactly the way createBackup does. */
function buildEncrypted(sql: string, passphrase: string): Buffer {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(gzipSync(Buffer.from(sql, "utf8"))), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, salt, iv, cipher.getAuthTag(), ct]);
}

describe("encrypted backup envelope", () => {
  it("pins the header layout at 8 + 32 + 16 + 16 = 72 bytes", () => {
    expect(BACKUP_MAGIC.toString("latin1")).toBe("POLARIS\0");
    expect(BACKUP_MAGIC.length).toBe(8);
    expect(ENCRYPTED_HEADER_LEN).toBe(72);
  });

  it("round-trips: the ciphertext after the header decrypts and gunzips to the dump", () => {
    const file = buildEncrypted(SQL, PASSPHRASE);

    const salt = file.subarray(8, 40);
    const iv = file.subarray(40, 56);
    const tag = file.subarray(56, 72);
    const ct = file.subarray(72);

    const decipher = createDecipheriv("aes-256-gcm", scryptSync(PASSPHRASE, salt, 32), iv);
    decipher.setAuthTag(tag);
    const gz = Buffer.concat([decipher.update(ct), decipher.final()]);
    expect(gunzipSync(gz).toString("utf8")).toBe(SQL);
  });

  it("does not contain the plaintext SQL", () => {
    const file = buildEncrypted(SQL, PASSPHRASE);
    expect(file.toString("latin1")).not.toContain("CREATE TABLE");
  });

  it("fails the auth tag on a wrong passphrase instead of returning garbage", () => {
    const file = buildEncrypted(SQL, PASSPHRASE);
    const salt = file.subarray(8, 40);
    const iv = file.subarray(40, 56);
    const tag = file.subarray(56, 72);
    const decipher = createDecipheriv("aes-256-gcm", scryptSync("wrong-passphrase", salt, 32), iv);
    decipher.setAuthTag(tag);
    expect(() => {
      decipher.update(file.subarray(72));
      decipher.final();
    }).toThrow();
  });

  it("detects a tampered ciphertext through the GCM tag", () => {
    const file = buildEncrypted(SQL, PASSPHRASE);
    file[80] = file[80]! ^ 0xff; // flip a byte inside the ciphertext
    const salt = file.subarray(8, 40);
    const iv = file.subarray(40, 56);
    const tag = file.subarray(56, 72);
    const decipher = createDecipheriv("aes-256-gcm", scryptSync(PASSPHRASE, salt, 32), iv);
    decipher.setAuthTag(tag);
    expect(() => {
      decipher.update(file.subarray(72));
      decipher.final();
    }).toThrow();
  });
});

describe("isEncryptedBackupFile", () => {
  it("recognizes an encrypted backup by its magic header", () => {
    const p = tmpFile("enc.gz", buildEncrypted(SQL, PASSPHRASE));
    expect(isEncryptedBackupFile(p)).toBe(true);
  });

  it("reports a plain gzip backup as not encrypted", () => {
    const p = tmpFile("plain.gz", gzipSync(Buffer.from(SQL, "utf8")));
    expect(isEncryptedBackupFile(p)).toBe(false);
  });

  it("does not treat a short file that happens to start with the magic as encrypted", () => {
    // A truncated upload must not be read as "encrypted, header present" — the
    // subarray slicing that follows would produce nonsense.
    const p = tmpFile("truncated", Buffer.concat([BACKUP_MAGIC, Buffer.alloc(10)]));
    expect(isEncryptedBackupFile(p)).toBe(false);
  });

  it("reports an empty file as not encrypted rather than throwing", () => {
    const p = tmpFile("empty", Buffer.alloc(0));
    expect(isEncryptedBackupFile(p)).toBe(false);
  });
});
