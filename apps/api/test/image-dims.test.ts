import { test, expect } from "bun:test";
import { sniffImageDimensions } from "../src/lib/image-dims";

const png = (w: number, h: number) =>
  Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // signature
    0x00,
    0x00,
    0x00,
    0x0d, // IHDR length
    0x49,
    0x48,
    0x44,
    0x52, // "IHDR"
    (w >>> 24) & 0xff,
    (w >>> 16) & 0xff,
    (w >>> 8) & 0xff,
    w & 0xff,
    (h >>> 24) & 0xff,
    (h >>> 16) & 0xff,
    (h >>> 8) & 0xff,
    h & 0xff,
    0x08,
    0x06,
    0x00,
    0x00,
    0x00,
  ]);

const gif = (w: number, h: number) =>
  Uint8Array.from([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61, // GIF89a
    w & 0xff,
    (w >>> 8) & 0xff, // width LE
    h & 0xff,
    (h >>> 8) & 0xff, // height LE
    0x00,
  ]);

// JPEG with an APP0 segment before the SOF0 — exercises segment scanning.
const jpeg = (w: number, h: number) =>
  Uint8Array.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10, // APP0, length 16
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00, // 14B payload
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08, // SOF0, length 17, precision 8
    (h >>> 8) & 0xff,
    h & 0xff, // height BE
    (w >>> 8) & 0xff,
    w & 0xff, // width BE
    0x03,
    0x01,
    0x22,
    0x00,
  ]);

const riff = (fourccChunk: number[]) => [
  0x52,
  0x49,
  0x46,
  0x46,
  0x00,
  0x00,
  0x00,
  0x00,
  0x57,
  0x45,
  0x42,
  0x50,
  ...fourccChunk,
];

const webpVp8 = (w: number, h: number) =>
  Uint8Array.from(
    riff([
      0x56,
      0x50,
      0x38,
      0x20, // "VP8 "
      0x10,
      0x00,
      0x00,
      0x00, // chunk size
      0x00,
      0x00,
      0x00, // frame tag
      0x9d,
      0x01,
      0x2a, // start code
      w & 0xff,
      (w >>> 8) & 0xff,
      h & 0xff,
      (h >>> 8) & 0xff,
    ]),
  );

const webpVp8l = (w: number, h: number) => {
  const packed = (w - 1) | ((h - 1) << 14); // 14-bit (w-1) | 14-bit (h-1)
  return Uint8Array.from(
    riff([
      0x56,
      0x50,
      0x38,
      0x4c, // "VP8L"
      0x10,
      0x00,
      0x00,
      0x00,
      0x2f, // signature
      packed & 0xff,
      (packed >>> 8) & 0xff,
      (packed >>> 16) & 0xff,
      (packed >>> 24) & 0xff,
    ]),
  );
};

const webpVp8x = (w: number, h: number) => {
  const cw = w - 1,
    ch = h - 1;
  return Uint8Array.from(
    riff([
      0x56,
      0x50,
      0x38,
      0x58, // "VP8X"
      0x0a,
      0x00,
      0x00,
      0x00, // chunk size 10
      0x00,
      0x00,
      0x00,
      0x00, // flags + reserved
      cw & 0xff,
      (cw >>> 8) & 0xff,
      (cw >>> 16) & 0xff,
      ch & 0xff,
      (ch >>> 8) & 0xff,
      (ch >>> 16) & 0xff,
    ]),
  );
};

test("PNG dimensions", () => {
  expect(sniffImageDimensions(png(256, 256))).toEqual({ format: "png", width: 256, height: 256 });
  expect(sniffImageDimensions(png(1024, 512))).toEqual({ format: "png", width: 1024, height: 512 });
});

test("GIF dimensions (little-endian)", () => {
  expect(sniffImageDimensions(gif(100, 200))).toEqual({ format: "gif", width: 100, height: 200 });
});

test("JPEG dimensions (scans past APP0 to SOF0)", () => {
  expect(sniffImageDimensions(jpeg(300, 150))).toEqual({ format: "jpeg", width: 300, height: 150 });
  expect(sniffImageDimensions(jpeg(512, 512))).toEqual({ format: "jpeg", width: 512, height: 512 });
});

test("WebP lossy (VP8)", () => {
  expect(sniffImageDimensions(webpVp8(50, 60))).toEqual({ format: "webp", width: 50, height: 60 });
});

test("WebP lossless (VP8L)", () => {
  expect(sniffImageDimensions(webpVp8l(70, 80))).toEqual({ format: "webp", width: 70, height: 80 });
});

test("WebP extended (VP8X)", () => {
  expect(sniffImageDimensions(webpVp8x(500, 400))).toEqual({
    format: "webp",
    width: 500,
    height: 400,
  });
});

test("unsniffable inputs → null", () => {
  expect(sniffImageDimensions(new Uint8Array(0))).toBeNull();
  expect(sniffImageDimensions(Uint8Array.from([0x3c, 0x73, 0x76, 0x67]))).toBeNull(); // "<svg"
  expect(sniffImageDimensions(new Uint8Array(40))).toBeNull(); // all-zero, no signature
  // Truncated PNG (signature only, no IHDR) → null, not a bogus 0×0.
  expect(sniffImageDimensions(Uint8Array.from(PNG_SIG_BYTES))).toBeNull();
});

const PNG_SIG_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
];
