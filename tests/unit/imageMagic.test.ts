import { describe, it, expect } from "vitest";
import { detectImageMagic } from "../../src/utils/imageMagic.js";

const png = (extra = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra)]);
const jpeg = (extra = 0) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra)]);
function webp(): Buffer {
  const b = Buffer.alloc(16);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(8, 4);
  b.write("WEBP", 8, "ascii");
  return b;
}

describe("detectImageMagic", () => {
  it("detects PNG, JPEG and WebP", () => {
    expect(detectImageMagic(png(64))).toBe(".png");
    expect(detectImageMagic(jpeg(64))).toBe(".jpg");
    expect(detectImageMagic(webp())).toBe(".webp");
  });

  it("returns null for non-image bytes", () => {
    expect(detectImageMagic(Buffer.from("not an image at all"))).toBeNull();
    expect(detectImageMagic(Buffer.alloc(32))).toBeNull();
  });

  it("does not over-read buffers shorter than each magic", () => {
    // The length guards are what keep these from reading past the end.
    expect(detectImageMagic(Buffer.alloc(0))).toBeNull();
    expect(detectImageMagic(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
    expect(detectImageMagic(Buffer.from([0xff, 0xd8]))).toBeNull();
    // "RIFF" present but truncated before the WEBP fourcc.
    expect(detectImageMagic(Buffer.from("RIFF1234", "ascii"))).toBeNull();
  });

  it("does not mistake a non-WEBP RIFF container for an image", () => {
    const wav = Buffer.alloc(16);
    wav.write("RIFF", 0, "ascii");
    wav.write("WAVE", 8, "ascii");
    expect(detectImageMagic(wav)).toBeNull();
  });
});
