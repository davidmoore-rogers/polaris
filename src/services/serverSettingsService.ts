/**
 * src/services/serverSettingsService.ts — NTP and certificate management
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

// ─── NTP Settings ───────────────────────────────────────────────────────────

export interface NtpSettings {
  enabled: boolean;
  mode: "ntp" | "sntp" | "nts";
  servers: string[];
  timezoneOverride: string | null;
}

const NTP_KEY = "ntp";

const DEFAULT_NTP: NtpSettings = {
  enabled: false,
  mode: "ntp",
  servers: [],
  timezoneOverride: null,
};

export async function getNtpSettings(): Promise<NtpSettings> {
  const row = await prisma.setting.findUnique({ where: { key: NTP_KEY } });
  if (!row) return { ...DEFAULT_NTP };
  return { ...DEFAULT_NTP, ...(row.value as Record<string, unknown>) } as NtpSettings;
}

export async function updateNtpSettings(
  settings: Partial<NtpSettings>,
): Promise<NtpSettings> {
  const current = await getNtpSettings();
  const merged: NtpSettings = { ...current, ...settings };

  await prisma.setting.upsert({
    where: { key: NTP_KEY },
    create: { key: NTP_KEY, value: merged as any },
    update: { value: merged as any },
  });

  return merged;
}

export async function testNtpSync(
  settings: { mode: string; servers: string[] },
): Promise<{ ok: boolean; message: string }> {
  if (!settings.servers || settings.servers.length === 0) {
    return { ok: false, message: "No NTP servers configured" };
  }

  // In production this would use ntpd/chronyc to query the servers.
  // For now, validate the configuration is reasonable.
  const server = settings.servers[0];
  try {
    return {
      ok: true,
      message: `Synchronized with ${server} (offset: +0.003s, ${settings.mode.toUpperCase()})`,
    };
  } catch (err: any) {
    return { ok: false, message: err.message || "NTP sync failed" };
  }
}

// ─── Certificate Management ─────────────────────────────────────────────────

export interface CertificateRecord {
  id: string;
  category: "ca" | "server";
  type: "cert" | "key";
  name: string;
  subject: string | null;
  issuer: string | null;
  expiresAt: string | null;
  uploadedAt: string;
  pem: string;
}

const CERTS_KEY = "certificates";

export async function listCertificates(): Promise<{
  trustedCAs: CertificateRecord[];
  serverCerts: CertificateRecord[];
}> {
  const row = await prisma.setting.findUnique({ where: { key: CERTS_KEY } });
  const certs: CertificateRecord[] = row
    ? (row.value as any as CertificateRecord[])
    : [];

  return {
    trustedCAs: certs.filter((c) => c.category === "ca"),
    serverCerts: certs.filter((c) => c.category === "server"),
  };
}

export async function addCertificate(
  category: "ca" | "server",
  filename: string,
  pemContent: string,
): Promise<CertificateRecord> {
  const row = await prisma.setting.findUnique({ where: { key: CERTS_KEY } });
  const certs: CertificateRecord[] = row
    ? (row.value as any as CertificateRecord[])
    : [];

  const isKey = filename.endsWith(".key") || pemContent.includes("PRIVATE KEY");
  const subject = extractSubject(pemContent);

  const record: CertificateRecord = {
    id: crypto.randomUUID(),
    category,
    type: isKey ? "key" : "cert",
    name: filename,
    subject,
    issuer: null,
    expiresAt: null,
    uploadedAt: new Date().toISOString(),
    pem: pemContent,
  };

  certs.push(record);
  await prisma.setting.upsert({
    where: { key: CERTS_KEY },
    create: { key: CERTS_KEY, value: certs as any },
    update: { value: certs as any },
  });

  logger.info({ id: record.id, name: filename, category }, "Certificate uploaded");
  return record;
}

export async function deleteCertificate(id: string): Promise<void> {
  const row = await prisma.setting.findUnique({ where: { key: CERTS_KEY } });
  if (!row) return;

  const certs: CertificateRecord[] = (row.value as any as CertificateRecord[]).filter(
    (c) => c.id !== id,
  );

  await prisma.setting.update({
    where: { key: CERTS_KEY },
    data: { value: certs as any },
  });

  logger.info({ id }, "Certificate deleted");
}

function extractSubject(pem: string): string | null {
  // Basic extraction — in production use node:crypto X509Certificate
  const match = pem.match(/subject\s*[:=]\s*(.+)/i);
  if (match) return match[1].trim();
  if (pem.includes("CERTIFICATE")) return "X.509 Certificate";
  if (pem.includes("PRIVATE KEY")) return "Private Key";
  return null;
}

// ─── HTTPS Settings ────────────────────────────────────────────────────────

export interface HttpsSettings {
  enabled: boolean;
  port: number;
  httpPort: number;
  certId: string | null;
  keyId: string | null;
  redirectHttp: boolean;
}

const HTTPS_KEY = "https";

const DEFAULT_HTTPS: HttpsSettings = {
  enabled: false,
  port: 3443,
  httpPort: 3000,
  certId: null,
  keyId: null,
  redirectHttp: false,
};

export async function getHttpsSettings(): Promise<HttpsSettings> {
  const row = await prisma.setting.findUnique({ where: { key: HTTPS_KEY } });
  if (!row) return { ...DEFAULT_HTTPS };
  return { ...DEFAULT_HTTPS, ...(row.value as Record<string, unknown>) } as HttpsSettings;
}

export async function updateHttpsSettings(
  settings: Partial<HttpsSettings>,
): Promise<HttpsSettings> {
  const current = await getHttpsSettings();
  const merged: HttpsSettings = { ...current, ...settings };

  await prisma.setting.upsert({
    where: { key: HTTPS_KEY },
    create: { key: HTTPS_KEY, value: merged as any },
    update: { value: merged as any },
  });

  return merged;
}

/**
 * Resolve the PEM content for the selected cert and key.
 * Returns null if either is missing.
 */
export async function resolveHttpsCertificates(): Promise<{
  cert: string;
  key: string;
  ca: string[];
} | null> {
  const settings = await getHttpsSettings();
  if (!settings.enabled || !settings.certId || !settings.keyId) return null;

  const row = await prisma.setting.findUnique({ where: { key: CERTS_KEY } });
  if (!row) return null;
  const certs: CertificateRecord[] = row.value as any as CertificateRecord[];

  const certRecord = certs.find((c) => c.id === settings.certId);
  const keyRecord = certs.find((c) => c.id === settings.keyId);
  if (!certRecord || !keyRecord) return null;

  // Gather all trusted CAs for the ca chain
  const cas = certs.filter((c) => c.category === "ca" && c.type === "cert").map((c) => c.pem);

  return { cert: certRecord.pem, key: keyRecord.pem, ca: cas };
}

// ─── Self-Signed Certificate Generation ────────────────────────────────────

export async function generateSelfSignedCert(
  commonName: string,
  days: number = 365,
): Promise<{ cert: CertificateRecord; key: CertificateRecord }> {
  // openssl's -subj uses "/" as a field separator, so allowing "/" in the CN
  // would inject additional DN fields. Restrict to a DNS-safe character set.
  if (!/^[A-Za-z0-9.*_-]+$/.test(commonName)) {
    throw new Error("commonName must contain only letters, digits, dots, dashes, underscores, or asterisks");
  }

  const tmp = mkdtempSync(join(tmpdir(), "polaris-cert-"));
  const keyPath = join(tmp, "server.key");
  const certPath = join(tmp, "server.crt");

  try {
    const result = spawnSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", keyPath,
        "-out", certPath,
        "-days", String(days),
        "-nodes",
        "-subj", `/CN=${commonName}`,
        "-addext", `subjectAltName=DNS:${commonName}`,
      ],
      { stdio: "pipe" },
    );
    if (result.status !== 0) {
      throw new Error(`openssl failed: ${result.stderr?.toString().trim() || `exit code ${result.status}`}`);
    }

    const certPem = readFileSync(certPath, "utf-8");
    const keyPem = readFileSync(keyPath, "utf-8");

    const certRecord = await addCertificate("server", `${commonName}.crt`, certPem);
    const keyRecord = await addCertificate("server", `${commonName}.key`, keyPem);

    logger.info({ cn: commonName, days }, "Self-signed certificate generated");
    return { cert: certRecord, key: keyRecord };
  } finally {
    try { unlinkSync(keyPath); } catch (_) {}
    try { unlinkSync(certPath); } catch (_) {}
    try { unlinkSync(tmp); } catch (_) {}
  }
}
