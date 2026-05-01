/**
 * src/services/deviceIconService.ts — operator-uploaded device icons
 *
 * Used by the Device Map's topology graph to render hardware-specific
 * imagery (FortiGate-91G chassis, FortiSwitch-148E faceplate, etc.)
 * instead of generic colored circles. Resolution at render time is
 * most-specific-wins:
 *
 *   1. scope="model" key="<manufacturer>/<model>"  — most specific
 *   2. scope="model" key="<model>"                  — manufacturer-agnostic
 *   3. scope="type"  key=<assetType>                — type-level fallback
 *   4. no row → null (frontend uses default node style)
 *
 * Storage is bytes-in-DB (image data column on the row) plus a dedicated
 * /api/v1/device-icons/:id/image route that serves the raw bytes with
 * Content-Type + Cache-Control headers. Browser caches via standard HTTP
 * cache so a topology re-render doesn't re-fetch the image.
 *
 * Validation at upload time:
 *   - mimeType in the allowed raster set (PNG / JPEG / WebP). SVG
 *     intentionally rejected for v1 — embedded scripts are a real
 *     attack surface and Cytoscape doesn't NEED SVG (it'll happily
 *     render a 256-px PNG at any zoom level).
 *   - size <= MAX_ICON_BYTES.
 *   - Magic-byte check on the first few bytes — defends against
 *     mismatched mimeType + payload.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

const MAX_ICON_BYTES = 256 * 1024; // 256 KB — plenty for a node icon.

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

// Magic-byte signatures for the allowed formats. Each entry: {mime, prefix}.
// The first N bytes of the upload are checked against these.
const MAGIC_BYTES: Array<{ mime: string; prefix: number[] }> = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  { mime: "image/png", prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // JPEG: FF D8 FF
  { mime: "image/jpeg", prefix: [0xff, 0xd8, 0xff] },
  // WebP: RIFF....WEBP
  { mime: "image/webp", prefix: [0x52, 0x49, 0x46, 0x46] },
];

export interface UploadedIcon {
  scope: "type" | "model";
  key: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  uploadedBy?: string;
}

export interface DeviceIconSummary {
  id: string;
  scope: string;
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedBy: string | null;
  uploadedAt: Date;
}

function detectMagicMime(data: Buffer): string | null {
  for (const { mime, prefix } of MAGIC_BYTES) {
    if (data.length < prefix.length) continue;
    let ok = true;
    for (let i = 0; i < prefix.length; i++) {
      if (data[i] !== prefix[i]) { ok = false; break; }
    }
    if (ok) return mime;
  }
  return null;
}

function normalizeKey(scope: string, key: string): string {
  const trimmed = key.trim();
  if (scope === "type") return trimmed.toLowerCase();
  // Model keys: trim each side of the slash so "  Fortinet  /  FortiGate-91G  "
  // canonicalizes to "Fortinet/FortiGate-91G". Plain "<model>" entries (no
  // slash) just get trimmed.
  if (trimmed.includes("/")) {
    const [manuf, ...rest] = trimmed.split("/");
    return `${manuf.trim()}/${rest.join("/").trim()}`;
  }
  return trimmed;
}

const VALID_TYPE_KEYS = new Set([
  "server", "switch", "router", "firewall", "workstation",
  "printer", "access_point", "other",
]);

export function validateUpload(input: UploadedIcon): void {
  if (input.scope !== "type" && input.scope !== "model") {
    throw new AppError(400, `Invalid scope "${input.scope}" — must be "type" or "model"`);
  }
  const key = normalizeKey(input.scope, input.key);
  if (!key) throw new AppError(400, "Key is required");
  if (input.scope === "type" && !VALID_TYPE_KEYS.has(key)) {
    throw new AppError(400, `Invalid type key "${key}" — must be one of: ${[...VALID_TYPE_KEYS].sort().join(", ")}`);
  }
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new AppError(400, `Unsupported image format "${input.mimeType}" — allowed: PNG, JPEG, WebP`);
  }
  if (!input.data || input.data.length === 0) {
    throw new AppError(400, "Empty file upload");
  }
  if (input.data.length > MAX_ICON_BYTES) {
    throw new AppError(400, `Icon too large (${input.data.length} bytes; max ${MAX_ICON_BYTES})`);
  }
  // Magic-byte check — declared mimeType must match what's in the bytes.
  // Defends against mis-extension uploads.
  const detected = detectMagicMime(input.data);
  if (!detected) throw new AppError(400, "File doesn't look like a valid PNG / JPEG / WebP image");
  if (detected !== input.mimeType) {
    throw new AppError(400, `File contents are ${detected} but upload declared ${input.mimeType}`);
  }
}

export async function uploadIcon(input: UploadedIcon): Promise<DeviceIconSummary> {
  validateUpload(input);
  const key = normalizeKey(input.scope, input.key);
  // Prisma 7 Bytes column wants Uint8Array<ArrayBuffer> strictly; the
  // Buffer type from multer is Buffer<ArrayBufferLike> (where ArrayBufferLike
  // includes SharedArrayBuffer). Copy into a fresh Uint8Array backed by a
  // dedicated ArrayBuffer so the type narrows correctly.
  const dataBytes = new Uint8Array(input.data.byteLength);
  dataBytes.set(input.data);
  const row = await prisma.deviceIcon.upsert({
    where: { scope_key: { scope: input.scope, key } },
    create: {
      scope: input.scope,
      key,
      filename: input.filename,
      mimeType: input.mimeType,
      data: dataBytes,
      size: input.data.length,
      uploadedBy: input.uploadedBy ?? null,
    },
    update: {
      filename: input.filename,
      mimeType: input.mimeType,
      data: dataBytes,
      size: input.data.length,
      uploadedBy: input.uploadedBy ?? null,
      uploadedAt: new Date(),
    },
  });
  return summarize(row);
}

export async function listIcons(): Promise<DeviceIconSummary[]> {
  const rows = await prisma.deviceIcon.findMany({
    select: { id: true, scope: true, key: true, filename: true, mimeType: true, size: true, uploadedBy: true, uploadedAt: true },
    orderBy: [{ scope: "asc" }, { key: "asc" }],
  });
  return rows;
}

export async function getIconImage(id: string): Promise<{ mimeType: string; data: Buffer } | null> {
  const row = await prisma.deviceIcon.findUnique({
    where: { id },
    select: { mimeType: true, data: true },
  });
  if (!row) return null;
  return { mimeType: row.mimeType, data: Buffer.from(row.data) };
}

export async function deleteIcon(id: string): Promise<boolean> {
  try {
    await prisma.deviceIcon.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

// Resolve which icon (if any) applies to an asset. Returns the icon id
// the topology endpoint can reference as `iconUrl: /api/v1/device-icons/<id>/image`.
// Most-specific-wins; null when no icon matches.
//
// Caller passes a snapshot of the asset's relevant fields so this can run
// over an in-memory list without per-asset DB roundtrips.
export interface IconResolutionInput {
  manufacturer: string | null;
  model: string | null;
  assetType: string | null;
}

export async function resolveIconForAsset(
  input: IconResolutionInput,
  iconCache?: Map<string, string | null>,
): Promise<string | null> {
  const candidates: Array<{ scope: string; key: string }> = [];
  if (input.manufacturer && input.model) {
    candidates.push({ scope: "model", key: `${input.manufacturer.trim()}/${input.model.trim()}` });
  }
  if (input.model) {
    candidates.push({ scope: "model", key: input.model.trim() });
  }
  if (input.assetType) {
    candidates.push({ scope: "type", key: input.assetType.trim().toLowerCase() });
  }
  for (const c of candidates) {
    const cacheKey = `${c.scope}|${c.key}`;
    if (iconCache && iconCache.has(cacheKey)) {
      const cached = iconCache.get(cacheKey);
      if (cached !== null) return cached ?? null;
      continue;
    }
    const row = await prisma.deviceIcon.findUnique({
      where: { scope_key: { scope: c.scope, key: c.key } },
      select: { id: true },
    });
    if (iconCache) iconCache.set(cacheKey, row?.id ?? null);
    if (row) return row.id;
  }
  return null;
}

// Bulk-resolution helper for renderers (e.g. topology endpoint) that need
// icons for many assets in one go. Pre-loads all icons once and returns
// a Map<scopeKey, iconId> for in-memory lookup.
export async function loadIconResolutionCache(): Promise<Map<string, string | null>> {
  const rows = await prisma.deviceIcon.findMany({
    select: { id: true, scope: true, key: true },
  });
  const cache = new Map<string, string | null>();
  for (const r of rows) {
    cache.set(`${r.scope}|${r.key}`, r.id);
  }
  return cache;
}

// Resolve an iconUrl for a single asset using a pre-loaded cache (sync).
// Returns the relative URL path or null.
export function resolveIconUrl(input: IconResolutionInput, cache: Map<string, string | null>): string | null {
  const candidates: Array<string> = [];
  if (input.manufacturer && input.model) {
    candidates.push(`model|${input.manufacturer.trim()}/${input.model.trim()}`);
  }
  if (input.model) {
    candidates.push(`model|${input.model.trim()}`);
  }
  if (input.assetType) {
    candidates.push(`type|${input.assetType.trim().toLowerCase()}`);
  }
  for (const c of candidates) {
    const id = cache.get(c);
    if (id) return `/api/v1/device-icons/${id}/image`;
  }
  return null;
}

function summarize(row: {
  id: string; scope: string; key: string; filename: string;
  mimeType: string; size: number; uploadedBy: string | null; uploadedAt: Date;
}): DeviceIconSummary {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt,
  };
}
