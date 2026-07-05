import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mediaAssets, organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../../tests/db-helper.js";
import { createDb } from "../db.js";
import {
  MEDIA_MAX_BYTES,
  processMediaForR2,
  selectExistingReleaseUrls,
  type MediaTransformBinding,
} from "./media-ingest.js";

/** Minimal in-memory R2 stand-in recording put() calls. */
function makeFakeBucket() {
  const puts: Array<{ key: string; contentType?: string; size: number }> = [];
  const store = new Map<string, Uint8Array>();
  const bucket = {
    put: async (
      key: string,
      value: ArrayBuffer | Uint8Array,
      opts?: { httpMetadata?: { contentType?: string } },
    ) => {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, bytes);
      puts.push({ key, contentType: opts?.httpMetadata?.contentType, size: bytes.byteLength });
      return {} as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, puts, store };
}

/** A fetch impl that returns a fixed image body for any URL. */
function imageFetch(bytes: number, contentType = "image/png"): typeof fetch {
  return (async () =>
    new Response(new Uint8Array(bytes).fill(7), {
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
}

describe("processMediaForR2", () => {
  test("uploads a valid image: sets r2Key, puts to a content-hash key, registers the asset", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();

    const result = await processMediaForR2(
      [{ type: "image", url: "https://cdn.example.com/hero.png" }],
      { db, bucket, sourceId: null, fetchImpl: imageFetch(2048) },
    );

    // r2Key stamped on the item, shaped releases/<64-hex>.png
    expect(result[0]!.r2Key).toMatch(/^releases\/[0-9a-f]{64}\.png$/);

    // bucket.put called once with that exact key + content type
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(result[0]!.r2Key!);
    expect(puts[0]!.contentType).toBe("image/png");
    expect(puts[0]!.size).toBe(2048);

    // media_assets row written, content_hash matches the key
    const rows = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.r2Key, result[0]!.r2Key!));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceUrl).toBe("https://cdn.example.com/hero.png");
    expect(rows[0]!.contentType).toBe("image/png");
    expect(rows[0]!.byteSize).toBe(2048);
    expect(rows[0]!.sourceId).toBeNull();
    expect(result[0]!.r2Key).toBe(`releases/${rows[0]!.contentHash}.png`);
  });

  test("reuse: a URL already mirrored is reused by r2Key without re-fetching or re-putting", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const url = "https://cdn.example.com/shared-across-releases.png";

    // First release mirrors it (one fetch, one put).
    const first = makeFakeBucket();
    let firstFetches = 0;
    const countingFetch = ((): typeof fetch =>
      (async () => {
        firstFetches += 1;
        return new Response(new Uint8Array(2048).fill(7), {
          headers: { "content-type": "image/png" },
        });
      }) as unknown as typeof fetch)();
    const r1 = await processMediaForR2([{ type: "image", url }], {
      db,
      bucket: first.bucket,
      sourceId: null,
      fetchImpl: countingFetch,
    });
    expect(r1[0]!.r2Key).toMatch(/^releases\/[0-9a-f]{64}\.png$/);
    expect(firstFetches).toBe(1);
    expect(first.puts).toHaveLength(1);

    // A later release referencing the same URL reuses the stored key: the fetch
    // impl throws to prove it is never called, and no put happens.
    const second = makeFakeBucket();
    const throwingFetch = (async () => {
      throw new Error("fetch should not be called on reuse");
    }) as unknown as typeof fetch;
    const r2 = await processMediaForR2([{ type: "image", url }], {
      db,
      bucket: second.bucket,
      sourceId: null,
      fetchImpl: throwingFetch,
    });
    expect(r2[0]!.r2Key).toBe(r1[0]!.r2Key);
    expect(second.puts).toHaveLength(0);
  });

  test("fail-open: non-image content type leaves the item untouched, no put", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();

    const result = await processMediaForR2([{ type: "image", url: "https://x/page.html" }], {
      db,
      bucket,
      fetchImpl: imageFetch(2048, "text/html"),
    });

    expect(result[0]!.r2Key).toBeUndefined();
    expect(result[0]!.url).toBe("https://x/page.html");
    expect(puts).toHaveLength(0);
  });

  test("fail-open: below the byte floor is skipped (tracking pixel / spacer)", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();

    const result = await processMediaForR2([{ type: "image", url: "https://x/pixel.gif" }], {
      db,
      bucket,
      fetchImpl: imageFetch(10, "image/gif"),
    });

    expect(result[0]!.r2Key).toBeUndefined();
    expect(puts).toHaveLength(0);
  });

  test("fail-open: a fetch error leaves the item untouched", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await processMediaForR2([{ type: "image", url: "https://x/a.png" }], {
      db,
      bucket,
      fetchImpl: throwingFetch,
    });

    expect(result[0]!.r2Key).toBeUndefined();
    expect(puts).toHaveLength(0);
  });

  test("fail-open: a hung fetch aborts on the per-item timeout", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const result = await processMediaForR2([{ type: "image", url: "https://x/slow.png" }], {
      db,
      bucket,
      perItemTimeoutMs: 10,
      fetchImpl: hangingFetch,
    });

    expect(result[0]!.r2Key).toBeUndefined();
    expect(puts).toHaveLength(0);
  });

  test("dedups identical bytes: same r2Key, one registry row", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket } = makeFakeBucket();

    const result = await processMediaForR2(
      [
        { type: "image", url: "https://x/a.png" },
        { type: "image", url: "https://y/b.png" },
      ],
      { db, bucket, fetchImpl: imageFetch(2048) },
    );

    expect(result[0]!.r2Key).toBe(result[1]!.r2Key);
    const rows = await db.select().from(mediaAssets);
    expect(rows).toHaveLength(1);
  });

  test("fail-open: above the byte ceiling is skipped without buffering past the cap", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();

    const result = await processMediaForR2([{ type: "image", url: "https://x/huge.png" }], {
      db,
      bucket,
      fetchImpl: imageFetch(MEDIA_MAX_BYTES + 1),
    });

    expect(result[0]!.r2Key).toBeUndefined();
    expect(puts).toHaveLength(0);
  });

  test("caps uploads at maxItems; extras pass through untouched", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();
    // Distinct bytes per URL (above the floor) so dedup doesn't mask the cap.
    let n = 2000;
    const sizedFetch = (async () =>
      new Response(new Uint8Array(n++).fill(7), {
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;

    const result = await processMediaForR2(
      [
        { type: "image", url: "https://x/1.png" },
        { type: "image", url: "https://x/2.png" },
        { type: "image", url: "https://x/3.png" },
      ],
      { db, bucket, maxItems: 2, fetchImpl: sizedFetch },
    );

    expect(puts).toHaveLength(2);
    expect(result[2]!.r2Key).toBeUndefined();
  });
});

describe("selectExistingReleaseUrls", () => {
  test("returns only URLs that already exist under the given source", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);

    await db
      .insert(organizations)
      .values({ id: "org_1", slug: "acme", name: "Acme", category: "developer-tools" });
    await db.insert(sources).values([
      {
        id: "src_1",
        orgId: "org_1",
        slug: "acme-blog",
        name: "Acme Blog",
        type: "scrape",
        url: "https://acme.test/blog",
        metadata: "{}",
      },
      {
        id: "src_2",
        orgId: "org_1",
        slug: "acme-other",
        name: "Acme Other",
        type: "scrape",
        url: "https://acme.test/other",
        metadata: "{}",
      },
    ]);
    await db.insert(releases).values([
      { id: "rel_1", sourceId: "src_1", title: "A", content: "", url: "https://acme.test/a" },
      { id: "rel_2", sourceId: "src_2", title: "B", content: "", url: "https://acme.test/b" },
    ]);

    const existing = await selectExistingReleaseUrls(db, "src_1", [
      "https://acme.test/a", // exists under src_1
      "https://acme.test/b", // exists, but under src_2 → excluded (source-scoped)
      "https://acme.test/new", // does not exist
      null,
      undefined,
      "",
    ]);

    expect([...existing]).toEqual(["https://acme.test/a"]);
  });

  test("returns an empty set when given only null/empty URLs (no query)", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const existing = await selectExistingReleaseUrls(db, "src_missing", [null, undefined, ""]);
    expect(existing.size).toBe(0);
  });
});

/** A fetch impl returning a `body`-bearing response of `bytes` at `contentType`. */
function streamFetch(bytes: number, contentType: string): typeof fetch {
  return (async () =>
    new Response(new Uint8Array(bytes).fill(9), {
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
}

/**
 * Fake Media Transformations binding: drains the input stream (so the caller's
 * `res.body` is consumed) and emits `mp4Bytes` of dummy `video/mp4`. `getInputs`
 * counts how many times `.input()` was invoked. `failMode` exercises fail-open.
 */
function makeFakeMediaTransform(mp4Bytes: number, failMode?: "throw-on-output" | "throw-on-media") {
  let inputs = 0;
  const binding = {
    input(stream: ReadableStream<Uint8Array>) {
      inputs++;
      // Drain the input so the upstream response body is consumed like prod.
      void stream.getReader().read();
      const result = {
        media: async () => {
          if (failMode === "throw-on-media") throw new Error("transcode failed");
          return new Response(new Uint8Array(mp4Bytes).fill(1)).body!;
        },
        contentType: async () => "video/mp4",
      };
      const chain = {
        transform: () => chain,
        output: (_opts: { mode: "video" | "frame" }) => {
          if (failMode === "throw-on-output") throw new Error("output failed");
          return result;
        },
      };
      return chain;
    },
  };
  return { binding: binding as unknown as MediaTransformBinding, getInputs: () => inputs };
}

describe("processMediaForR2 GIF→MP4 transcode (#1368)", () => {
  test("stores a small MP4 (not the raw GIF) and registers it as video/mp4", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();
    const { binding, getInputs } = makeFakeMediaTransform(4096);

    // A GIF larger than MEDIA_MAX_BYTES proves the transcode sidesteps the cap:
    // the raw bytes are never buffered/size-checked.
    const result = await processMediaForR2([{ type: "gif", url: "https://x/demo.gif" }], {
      db,
      bucket,
      mediaTransform: binding,
      transcodeGif: true,
      fetchImpl: streamFetch(MEDIA_MAX_BYTES + 1, "image/gif"),
    });

    expect(getInputs()).toBe(1);
    expect(result[0]!.r2Key).toMatch(/^releases\/[0-9a-f]{64}\.mp4$/);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(result[0]!.r2Key!);
    expect(puts[0]!.contentType).toBe("video/mp4");
    expect(puts[0]!.size).toBe(4096);

    const rows = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.r2Key, result[0]!.r2Key!));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contentType).toBe("video/mp4");
    expect(rows[0]!.sourceUrl).toBe("https://x/demo.gif");
  });

  test("flag off (transcodeGif unset): a GIF takes the verbatim mirror path", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();
    const { binding, getInputs } = makeFakeMediaTransform(4096);

    const result = await processMediaForR2([{ type: "gif", url: "https://x/small.gif" }], {
      db,
      bucket,
      mediaTransform: binding, // present, but transcodeGif not set
      fetchImpl: streamFetch(2048, "image/gif"),
    });

    expect(getInputs()).toBe(0); // binding never invoked
    expect(result[0]!.r2Key).toMatch(/^releases\/[0-9a-f]{64}\.gif$/);
    expect(puts[0]!.contentType).toBe("image/gif");
  });

  test("no binding bound: a GIF takes the verbatim mirror path", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();

    const result = await processMediaForR2([{ type: "gif", url: "https://x/small.gif" }], {
      db,
      bucket,
      transcodeGif: true, // on, but no mediaTransform binding
      fetchImpl: streamFetch(2048, "image/gif"),
    });

    expect(result[0]!.r2Key).toMatch(/^releases\/[0-9a-f]{64}\.gif$/);
    expect(puts[0]!.contentType).toBe("image/gif");
  });

  test("non-GIF content is unaffected by transcodeGif (normal image mirror)", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();
    const { binding, getInputs } = makeFakeMediaTransform(4096);

    const result = await processMediaForR2([{ type: "image", url: "https://x/shot.png" }], {
      db,
      bucket,
      mediaTransform: binding,
      transcodeGif: true,
      fetchImpl: streamFetch(2048, "image/png"),
    });

    expect(getInputs()).toBe(0);
    expect(result[0]!.r2Key).toMatch(/^releases\/[0-9a-f]{64}\.png$/);
    expect(puts[0]!.contentType).toBe("image/png");
  });

  test("fail-open: a transcode error leaves the GIF untouched (no put, no r2Key)", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    const { bucket, puts } = makeFakeBucket();
    const { binding } = makeFakeMediaTransform(4096, "throw-on-media");

    const result = await processMediaForR2([{ type: "gif", url: "https://x/demo.gif" }], {
      db,
      bucket,
      mediaTransform: binding,
      transcodeGif: true,
      fetchImpl: streamFetch(2048, "image/gif"),
    });

    expect(result[0]!.r2Key).toBeUndefined();
    expect(result[0]!.url).toBe("https://x/demo.gif");
    expect(puts).toHaveLength(0);
  });
});
