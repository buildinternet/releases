/**
 * Minimal raster image dimension + format sniffer (#1406).
 *
 * Workers have no image library, so org-avatar validation ("a reasonable square
 * raster") reads width/height straight from the file header bytes. Supports the
 * raster formats we accept for avatars — PNG, JPEG, GIF, WebP (lossy VP8, lossless
 * VP8L, extended VP8X). Returns `null` for anything it can't parse (truncated,
 * SVG/AVIF, junk) — callers treat unsniffable as "can't validate" and reject.
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

export interface ImageDimensions {
  format: ImageFormat;
  width: number;
  height: number;
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u32be(b: Uint8Array, o: number): number {
  return (b[o]! * 0x1000000 + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!) >>> 0;
}
function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}
function ascii(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]!);
  return s;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function sniffImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  // 10 bytes is the smallest header that yields a dimension (GIF); each format
  // below guards its own deeper offsets.
  if (!bytes || bytes.length < 10) return null;

  // PNG — 8-byte signature, then IHDR: width @16 (BE32), height @20 (BE32).
  if (PNG_SIG.every((v, i) => bytes[i] === v)) {
    if (bytes.length < 24) return null;
    const width = u32be(bytes, 16);
    const height = u32be(bytes, 20);
    return width && height ? { format: "png", width, height } : null;
  }

  // GIF — "GIF87a"/"GIF89a", logical screen width @6 (LE16), height @8 (LE16).
  if (ascii(bytes, 0, 3) === "GIF") {
    const width = u16le(bytes, 6);
    const height = u16le(bytes, 8);
    return width && height ? { format: "gif", width, height } : null;
  }

  // JPEG — scan marker segments for a Start-Of-Frame (SOF) carrying the size.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return sniffJpeg(bytes);
  }

  // WebP — RIFF container with a "WEBP" form type, then a VP8/VP8L/VP8X chunk.
  // Each sub-format checks its own length; here we only need the fourcc @12-15.
  if (ascii(bytes, 0, 4) === "RIFF" && bytes.length >= 16 && ascii(bytes, 8, 4) === "WEBP") {
    return sniffWebp(bytes);
  }

  return null;
}

function sniffJpeg(bytes: Uint8Array): ImageDimensions | null {
  let off = 2;
  while (off + 1 < bytes.length) {
    if (bytes[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = bytes[off + 1]!;
    // Fill byte (0xFF padding) → advance one and re-read.
    if (marker === 0xff) {
      off++;
      continue;
    }
    // Standalone markers with no length payload: SOI/EOI, RSTn, TEM.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      off += 2;
      continue;
    }
    if (off + 3 >= bytes.length) break;
    const len = u16be(bytes, off + 2);
    // SOF markers (C0–CF) carry the frame size — except DHT(C4), JPG(C8), DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 8 >= bytes.length) break;
      const height = u16be(bytes, off + 5);
      const width = u16be(bytes, off + 7);
      return width && height ? { format: "jpeg", width, height } : null;
    }
    if (len < 2) break;
    off += 2 + len;
  }
  return null;
}

function sniffWebp(bytes: Uint8Array): ImageDimensions | null {
  const fourcc = ascii(bytes, 12, 4);

  // Lossy VP8: 14-bit width/height after the 0x9d012a start code (@26 / @28, LE).
  if (fourcc === "VP8 ") {
    if (bytes.length < 30) return null;
    const width = u16le(bytes, 26) & 0x3fff;
    const height = u16le(bytes, 28) & 0x3fff;
    return width && height ? { format: "webp", width, height } : null;
  }

  // Lossless VP8L: 1-byte 0x2f signature @20, then 14-bit (w-1)/(h-1) packed LE.
  if (fourcc === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const b1 = bytes[21]!,
      b2 = bytes[22]!,
      b3 = bytes[23]!,
      b4 = bytes[24]!;
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return { format: "webp", width, height };
  }

  // Extended VP8X: 24-bit (canvas-1) width @24, height @27 (LE).
  if (fourcc === "VP8X") {
    if (bytes.length < 30) return null;
    const width = 1 + u24le(bytes, 24);
    const height = 1 + u24le(bytes, 27);
    return { format: "webp", width, height };
  }

  return null;
}
