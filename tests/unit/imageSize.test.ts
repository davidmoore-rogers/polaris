/**
 * tests/unit/imageSize.test.ts — header-parsed PNG/JPEG dimensions.
 *
 * These numbers place the branding accent overlay, so a wrong answer puts the
 * Polaris symbol off the edge of an operator's logo (or swallows it whole).
 * The PNG cases run against real files shipped in public/.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { imageSize, jpegSize, pngSize } from "../../src/utils/imageSize.js";

const brand = (name: string) => readFileSync(join(process.cwd(), "public", "img", "brand", name));

/** Minimal JPEG: SOI, one skippable APP0, then a SOF0 stating h×w. */
function jpegBuffer(width: number, height: number, opts: { sofMarker?: number } = {}): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = opts.sofMarker ?? 0xc0;
  sof.writeUInt16BE(9, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe("pngSize", () => {
  it("reads the shipped brand art", () => {
    expect(pngSize(brand("polaris-symbol.png"))).toEqual({ width: 512, height: 512 });
    expect(pngSize(brand("polaris-horiz-dark.png"))).toEqual({ width: 900, height: 180 });
  });

  it("rejects a non-PNG and a truncated header", () => {
    expect(pngSize(Buffer.from("GIF89a not a png at all", "ascii"))).toBeNull();
    expect(pngSize(brand("polaris-symbol.png").subarray(0, 20))).toBeNull();
  });

  it("rejects a PNG signature whose first chunk isn't IHDR", () => {
    const buf = Buffer.from(brand("polaris-symbol.png"));
    buf.write("IDAT", 12, "ascii");
    expect(pngSize(buf)).toBeNull();
  });
});

describe("jpegSize", () => {
  it("reads dimensions past a skippable segment", () => {
    expect(jpegSize(jpegBuffer(1200, 400))).toEqual({ width: 1200, height: 400 });
  });

  it("reads a progressive frame (SOF2) the same way", () => {
    expect(jpegSize(jpegBuffer(64, 96, { sofMarker: 0xc2 }))).toEqual({ width: 64, height: 96 });
  });

  it("does not mistake a Huffman table (SOF-range, not a frame) for a frame", () => {
    // DHT sits at 0xc4, inside the 0xc0..0xcf range — length-skipped, not read.
    const dht = Buffer.from([0xff, 0xc4, 0x00, 0x05, 0x00, 0x00, 0x00]);
    const withDht = Buffer.concat([Buffer.from([0xff, 0xd8]), dht, jpegBuffer(20, 10).subarray(2)]);
    expect(jpegSize(withDht)).toEqual({ width: 20, height: 10 });
  });

  it("returns null when the scan starts before any frame header", () => {
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });

  it("returns null on a desynchronized marker chain rather than guessing", () => {
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78]))).toBeNull();
  });
});

describe("imageSize", () => {
  it("dispatches on the format", () => {
    expect(imageSize(brand("polaris-vert-dark.png"))?.width).toBe(600);
    expect(imageSize(jpegBuffer(8, 8))).toEqual({ width: 8, height: 8 });
  });

  it("returns null for WebP — resvg can't embed it, so there is no accent path", () => {
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    expect(imageSize(webp)).toBeNull();
  });

  it("never throws on garbage", () => {
    expect(() => imageSize(Buffer.alloc(0))).not.toThrow();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
  });
});
