import { test, expect } from "bun:test";
import { ingestOrgAvatar } from "../src/lib/avatar-ingest";

// Minimal PNG: the IHDR header is all the sniffer reads; pad to `bytes` total so
// the byte-size gate sees a realistic size.
function pngBytes(w: number, h: number, bytes = 2048): Uint8Array {
  const header = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
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
  ];
  const buf = new Uint8Array(Math.max(bytes, header.length));
  buf.set(header, 0);
  return buf;
}

// Minimal JPEG (SOF0 carries the size); padded.
function jpegBytes(w: number, h: number, bytes = 2048): Uint8Array {
  const header = [
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (h >>> 8) & 0xff,
    h & 0xff,
    (w >>> 8) & 0xff,
    w & 0xff,
    0x03,
  ];
  const buf = new Uint8Array(Math.max(bytes, header.length));
  buf.set(header, 0);
  return buf;
}

function fakeR2() {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    store,
    put: async (
      k: string,
      v: ArrayBuffer | Uint8Array,
      opts?: { httpMetadata?: { contentType?: string } },
    ) => {
      const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
      store.set(k, { bytes, contentType: opts?.httpMetadata?.contentType });
    },
  };
}

const imageResponse = (bytes: Uint8Array, contentType = "image/png") =>
  new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": contentType },
  });

const bucketOf = (r2: ReturnType<typeof fakeR2>) => r2 as unknown as R2Bucket;

test("success: mirrors a square png to orgs/{slug}.png and returns its public URL", async () => {
  const R2 = fakeR2();
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/icon.png",
    slug: "acme",
    bucket: bucketOf(R2),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => imageResponse(pngBytes(256, 256)),
  });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.key).toBe("orgs/acme.png");
    expect(res.avatarUrl).toBe("https://media.test/orgs/acme.png");
    expect(res.width).toBe(256);
    expect(res.height).toBe(256);
  }
  expect(R2.store.get("orgs/acme.png")?.contentType).toBe("image/png");
});

test("content-type drives the extension (jpeg → orgs/{slug}.jpg)", async () => {
  const R2 = fakeR2();
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/icon.jpg",
    slug: "acme",
    bucket: bucketOf(R2),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => imageResponse(jpegBytes(300, 300), "image/jpeg"),
  });
  expect(res.ok && res.key).toBe("orgs/acme.jpg");
  expect(R2.store.has("orgs/acme.jpg")).toBe(true);
});

test("strips a trailing slash from mediaOrigin", async () => {
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/icon.png",
    slug: "acme",
    bucket: bucketOf(fakeR2()),
    mediaOrigin: "https://media.test/",
    fetchImpl: async () => imageResponse(pngBytes(256, 256)),
  });
  expect(res.ok && res.avatarUrl).toBe("https://media.test/orgs/acme.png");
});

test("rejects a non-square (wordmark-shaped) image", async () => {
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/wide.png",
    slug: "acme",
    bucket: bucketOf(fakeR2()),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => imageResponse(pngBytes(400, 150)), // both ≥128, ratio 0.375
  });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(422);
    expect(res.error).toBe("not_square");
  }
});

test("rejects an image below the minimum dimension", async () => {
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/tiny.png",
    slug: "acme",
    bucket: bucketOf(fakeR2()),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => imageResponse(pngBytes(64, 64)),
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toBe("too_small_dimensions");
});

test("rejects a too-small byte body", async () => {
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/tiny.png",
    slug: "acme",
    bucket: bucketOf(fakeR2()),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => imageResponse(pngBytes(256, 256, 100)),
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toBe("too_small");
});

test("rejects an unsupported content type", async () => {
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/logo.svg",
    slug: "acme",
    bucket: bucketOf(fakeR2()),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => imageResponse(pngBytes(256, 256), "image/svg+xml"),
  });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(415);
    expect(res.error).toBe("unsupported_type");
  }
});

test("rejects a content type whose bytes don't actually decode", async () => {
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/lies.png",
    slug: "acme",
    bucket: bucketOf(fakeR2()),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => imageResponse(new Uint8Array(2048), "image/png"), // all-zero, no PNG sig
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toBe("unreadable");
});

test("maps a non-OK fetch to 502", async () => {
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/missing.png",
    slug: "acme",
    bucket: bucketOf(fakeR2()),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => new Response("nope", { status: 404 }),
  });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(502);
    expect(res.error).toBe("fetch_failed");
  }
});

test("maps a thrown fetch (timeout/network) to 502", async () => {
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/boom.png",
    slug: "acme",
    bucket: bucketOf(fakeR2()),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => {
      throw new Error("network");
    },
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(502);
});

test("rejects an invalid / non-http source URL before fetching", async () => {
  let called = 0;
  const opts = {
    slug: "acme",
    bucket: bucketOf(fakeR2()),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => {
      called++;
      return imageResponse(pngBytes(256, 256));
    },
  };
  expect((await ingestOrgAvatar({ ...opts, sourceUrl: "not-a-url" })).ok).toBe(false);
  expect((await ingestOrgAvatar({ ...opts, sourceUrl: "ftp://h/x.png" })).ok).toBe(false);
  expect(called).toBe(0);
});

test("idempotent: a re-run overwrites the same key", async () => {
  const R2 = fakeR2();
  const opts = {
    sourceUrl: "https://cdn.test/icon.png",
    slug: "acme",
    bucket: bucketOf(R2),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => imageResponse(pngBytes(256, 256)),
  };
  await ingestOrgAvatar(opts);
  await ingestOrgAvatar({ ...opts, fetchImpl: async () => imageResponse(pngBytes(512, 512)) });
  expect(R2.store.size).toBe(1);
  expect(R2.store.has("orgs/acme.png")).toBe(true);
});
