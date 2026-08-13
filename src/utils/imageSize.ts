/**
 * src/utils/imageSize.ts — pixel dimensions of a PNG or JPEG, from its header.
 *
 * The branding accent overlay (services/brandLogoService.ts) has to place the
 * Polaris symbol at a fraction of the operator's logo and pin it to a corner,
 * which is impossible without knowing the source's own width and height —
 * `preserveAspectRatio` can fit an image into a box, but it can't tell you what
 * box the image already is.
 *
 * Header parsing rather than a decoder dependency: both formats state their
 * dimensions in the first few dozen bytes, and Polaris already refuses anything
 * that isn't PNG/JPEG/WebP at upload (utils/imageMagic.ts). WebP is deliberately
 * unsupported here for the same reason appIconService skips it — resvg cannot
 * decode it in an embedded <image>, so a WebP logo has no accent path anyway and
 * `null` is the honest answer.
 *
 * Never throws: a truncated or malformed buffer returns null, and the caller
 * degrades to the un-accented logo.
 */

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG: the IHDR chunk is mandated to be first, so width/height are at fixed
 * offsets 16 and 20 (big-endian u32).
 */
export function pngSize(buf: Buffer): ImageSize | null {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * JPEG: walk the marker chain to the first Start-Of-Frame (SOF0..SOF15, minus
 * the four markers in that range that aren't frame headers) and read the height
 * then width from its payload. Standalone markers (RSTn, SOI, TEM) carry no
 * length word and must be stepped over rather than length-skipped.
 */
export function jpegSize(buf: Buffer): ImageSize | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return null; // desynchronized — refuse rather than guess
    const marker = buf[i + 1];
    // Fill bytes; padding between markers is legal.
    if (marker === 0xff) { i += 1; continue; }
    // Standalone: SOI/EOI/TEM/RSTn carry no segment.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan — no SOF found

    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 /* DHT */ && marker !== 0xc8 /* JPG */ && marker !== 0xcc /* DAC */;
    if (isSof) {
      if (i + 9 > buf.length) return null;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    i += 2 + length;
  }
  return null;
}

/** Dimensions of a PNG or JPEG buffer; null for anything else. */
export function imageSize(buf: Buffer): ImageSize | null {
  return pngSize(buf) ?? jpegSize(buf);
}
