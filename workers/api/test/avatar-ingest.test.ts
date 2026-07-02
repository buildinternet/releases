import { test, expect } from "bun:test";
import {
  avatarRejectToError,
  ingestAvatarFromBuffer,
  ingestOrgAvatar,
  isHostedAvatarUrl,
  isPrivateOrLocalHost,
  type AvatarRejectStatus,
} from "../src/lib/avatar-ingest";

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

// #1830 item 2 — the reject-status → standardized-error-taxonomy fold. The
// off-map 415/422/413/400 statuses collapse to `validation` (HTTP 400) with the
// ingest reason preserved in `details.reason`; 502 maps to `upstream` (HTTP 502)
// with its message genericized (UpstreamError is expose:false).
test("avatarRejectToError folds validation-class statuses to 400, reason in details", () => {
  const reason = "not_square";
  for (const status of [400, 413, 415, 422] as AvatarRejectStatus[]) {
    const err = avatarRejectToError({ ok: false, status, error: reason, message: "why" });
    expect(err.type).toBe("validation");
    expect(err.status).toBe(400);
    expect(err.code).toBe("validation_failed");
    expect(err.toWire()).toEqual({
      error: {
        code: "validation_failed",
        type: "validation",
        message: "why",
        details: { reason },
      },
    });
  }
});

test("avatarRejectToError maps 502 to upstream (502), reason in details, message genericized", () => {
  const err = avatarRejectToError({
    ok: false,
    status: 502,
    error: "fetch_failed",
    message: "Could not fetch the source image",
  });
  expect(err.type).toBe("upstream");
  expect(err.status).toBe(502);
  // UpstreamError is expose:false → the wire message is the generic one, but the
  // machine-branchable reason still rides in details.
  expect(err.toWire()).toEqual({
    error: {
      code: "upstream_error",
      type: "upstream",
      message: "Upstream service error",
      details: { reason: "fetch_failed" },
    },
  });
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

// ── SSRF guard (#1406 follow-up) ──────────────────────────────────────────────

test("isPrivateOrLocalHost: flags private/loopback/link-local + internal names", () => {
  for (const h of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "localhost",
    "db.localhost",
    "service.internal",
    "metadata.google.internal",
    "printer", // single-label
  ]) {
    expect(isPrivateOrLocalHost(h), `${h} should be blocked`).toBe(true);
  }
  for (const h of [
    "cdn.example.com",
    "avatars.githubusercontent.com",
    "is1-ssl.mzstatic.com",
    "8.8.8.8",
    "172.32.0.1", // just outside 172.16/12
    "192.169.0.1",
  ]) {
    expect(isPrivateOrLocalHost(h), `${h} should be allowed`).toBe(false);
  }
});

test("blocks an SSRF target before fetching, returning 400", async () => {
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
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1/icon.png",
    "http://10.0.0.5/icon.png",
    "http://localhost:8787/icon.png",
    "http://[::1]/icon.png",
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- assert each URL sequentially
    const res = await ingestOrgAvatar({ ...opts, sourceUrl: url });
    expect(res.ok, `${url} should be blocked`).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  }
  expect(called).toBe(0); // never fetched any of them
});

test("follows a redirect to a public host", async () => {
  const R2 = fakeR2();
  let hop = 0;
  const res = await ingestOrgAvatar({
    sourceUrl: "https://github.com/acme.png",
    slug: "acme",
    bucket: bucketOf(R2),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => {
      hop++;
      return hop === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://avatars.githubusercontent.com/u/1?v=4" },
          })
        : imageResponse(pngBytes(256, 256));
    },
  });
  expect(res.ok).toBe(true);
  expect(hop).toBe(2);
  expect(R2.store.has("orgs/acme.png")).toBe(true);
});

test("blocks a redirect that points at an internal address", async () => {
  const R2 = fakeR2();
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/icon.png",
    slug: "acme",
    bucket: bucketOf(R2),
    mediaOrigin: "https://media.test",
    fetchImpl: async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(400);
  expect(R2.store.size).toBe(0);
});

test("does not echo the upstream status in the error message", async () => {
  const res = await ingestOrgAvatar({
    sourceUrl: "https://cdn.test/missing.png",
    slug: "acme",
    bucket: bucketOf(fakeR2()),
    mediaOrigin: "https://media.test",
    fetchImpl: async () => new Response("nope", { status: 403 }),
  });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(502);
    expect(res.message).not.toContain("403");
  }
});

test("ingestAvatarFromBuffer mirrors to a custom key stem", async () => {
  const R2 = fakeR2();
  const res = await ingestAvatarFromBuffer({
    buf: pngBytes(256, 256).buffer as ArrayBuffer,
    contentType: "image/png",
    keyStem: "users/user-1",
    bucket: bucketOf(R2),
    mediaOrigin: "https://media.test",
  });
  expect(res.ok && res.key).toBe("users/user-1.png");
  expect(res.ok && res.avatarUrl).toBe("https://media.test/users/user-1.png");
});

test("isHostedAvatarUrl matches mirrored avatars by prefix", () => {
  expect(
    isHostedAvatarUrl("https://media.test/users/u1.png", "https://media.test/", "users/"),
  ).toBe(true);
  expect(
    isHostedAvatarUrl("https://lh3.googleusercontent.com/x", "https://media.test", "users/"),
  ).toBe(false);
});
