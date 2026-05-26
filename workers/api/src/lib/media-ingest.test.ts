import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mediaAssets } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../../tests/db-helper.js";
import { createDb } from "../db.js";
import { processMediaForR2 } from "./media-ingest.js";

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
