/**
 * src/utils/imageMagic.ts — sniff an image's real format from its magic bytes.
 *
 * Extracted from the branding-logo upload route so callers that only need
 * format detection (appIconService) don't have to import a route module.
 *
 * Never trust a filename extension: the branding logo is stored under a fixed
 * name derived from THIS function's answer, and appIconService re-sniffs on
 * read because the `branding` Setting row is operator-writable.
 */

export type ImageExt = ".png" | ".jpg" | ".webp";

/** Returns the detected extension, or null when the bytes are not a supported image. */
export function detectImageMagic(buf: Buffer): ImageExt | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return ".jpg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return null;
}
