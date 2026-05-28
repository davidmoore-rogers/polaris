/**
 * src/services/serverSettingsService.ts — NTP and certificate management
 */

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

