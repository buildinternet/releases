import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { runVideoBackfill } from "../../workers/api/src/lib/media-backfill.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";

/**
 * Part 2 — inline-video retrofit (`runVideoBackfill`). For a release whose body
 * links a hosted video, detect → oEmbed poster → mirror → APPEND a
 * `type:"video"` item to the existing media[] (preserve hero), idempotently.
 * The injected `fetchImpl` serves both the oEmbed JSON and the poster bytes, so
 * no network is touched.
 */

let testDb: TestDatabase;

const WISTIA_BODY =
  "Watch the demo: [Video](https://fast.wistia.com/embed/iframe/wh6pjz981z) — enjoy.";
const POSTER_URL = "https://embed-ssl.wistia.com/deliveries/poster.png";
// Embed form is the public click target (medias/<id> redirects to login).
const WATCH_URL = "https://fast.wistia.com/embed/iframe/wh6pjz981z";

/** fetch mock: oEmbed endpoint → JSON; poster URL → 2KB png; everything else 404. */
function makeFetch(): { fn: typeof fetch; oembedCalls: number; posterCalls: number } {
  const state = { oembedCalls: 0, posterCalls: 0 };
  const fn = ((input: string | URL) => {
    const url = input.toString();
    if (url.includes("/oembed")) {
      state.oembedCalls++;
      return Promise.resolve(
        new Response(JSON.stringify({ type: "video", title: "Demo", thumbnail_url: POSTER_URL }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url === POSTER_URL) {
      state.posterCalls++;
      const bytes = new Uint8Array(2048).fill(9);
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
        }),
      );
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as unknown as typeof fetch;
  return {
    fn,
    get oembedCalls() {
      return state.oembedCalls;
    },
    get posterCalls() {
      return state.posterCalls;
    },
  };
}

function makeBucket() {
  const puts: string[] = [];
  return {
    puts,
    async put(key: string) {
      puts.push(key);
      return { key } as unknown;
    },
  } as unknown as R2Bucket & { puts: string[] };
}

async function seedRelease(content: string, media: unknown[]) {
  await testDb.db.insert(organizations).values({ id: "org_a", name: "A", slug: "a" });
  await testDb.db.insert(sources).values({
    id: "src_1",
    name: "S",
    slug: "s",
    orgId: "org_a",
    type: "scrape",
    url: "https://a.example",
  });
  await testDb.db.insert(releases).values({
    id: "rel_1",
    sourceId: "src_1",
    title: "v1",
    content,
    type: "feature",
    suppressed: false,
    media: JSON.stringify(media),
  });
}

function storedMedia(): Promise<
  Array<{ type: string; url: string; linkUrl?: string; r2Key?: string }>
> {
  return testDb.db
    .select({ media: releases.media })
    .from(releases)
    .where(eq(releases.id, "rel_1"))
    .then((rows) => JSON.parse(rows[0]!.media!));
}

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

describe("runVideoBackfill", () => {
  test("appends a video item, preserving the existing hero image", async () => {
    await seedRelease(WISTIA_BODY, [{ type: "image", url: "https://a.example/hero.png" }]);
    const fetcher = makeFetch();
    const bucket = makeBucket();

    const report = await runVideoBackfill(testDb.db as never, bucket, {
      releaseId: "rel_1",
      limit: 50,
      dryRun: false,
      fetchImpl: fetcher.fn,
    });

    expect(report.releasesUpdated).toBe(1);
    expect(report.videosAppended).toBe(1);
    expect(fetcher.oembedCalls).toBe(1);
    expect(fetcher.posterCalls).toBe(1);
    expect(bucket.puts.length).toBe(1);

    const media = await storedMedia();
    expect(media.length).toBe(2);
    // Hero preserved at index 0.
    expect(media[0]!.type).toBe("image");
    expect(media[0]!.url).toBe("https://a.example/hero.png");
    // Appended video carries the watch URL + a mirrored poster (r2Key).
    const video = media.find((m) => m.type === "video")!;
    expect(video.linkUrl).toBe(WATCH_URL);
    expect(video.r2Key).toMatch(/^releases\/[0-9a-f]{64}\.png$/);
  });

  test("is idempotent — re-running adds nothing when the video already exists", async () => {
    await seedRelease(WISTIA_BODY, [{ type: "image", url: "https://a.example/hero.png" }]);
    const bucket = makeBucket();

    const first = await runVideoBackfill(testDb.db as never, bucket, {
      releaseId: "rel_1",
      limit: 50,
      dryRun: false,
      fetchImpl: makeFetch().fn,
    });
    expect(first.releasesUpdated).toBe(1);

    const afterFirst = await storedMedia();
    expect(afterFirst.length).toBe(2);

    // Second run: the video (matched by linkUrl) is already present.
    const second = await runVideoBackfill(testDb.db as never, bucket, {
      releaseId: "rel_1",
      limit: 50,
      dryRun: false,
      fetchImpl: makeFetch().fn,
    });
    expect(second.releasesUpdated).toBe(0);
    expect(second.videosAppended).toBe(0);

    const afterSecond = await storedMedia();
    expect(afterSecond.length).toBe(2); // unchanged
  });

  test("dryRun reports candidates without writing", async () => {
    await seedRelease(WISTIA_BODY, []);
    const bucket = makeBucket();
    const report = await runVideoBackfill(testDb.db as never, bucket, {
      releaseId: "rel_1",
      limit: 50,
      dryRun: true,
      fetchImpl: makeFetch().fn,
    });
    expect(report.scanned).toBe(1);
    expect(report.releasesUpdated).toBe(0);
    expect(bucket.puts.length).toBe(0);
    expect(await storedMedia()).toEqual([]);
  });

  test("no candidates when the body has no known video host", async () => {
    await seedRelease("Just a normal release with a [link](https://example.com/post).", []);
    const report = await runVideoBackfill(testDb.db as never, makeBucket(), {
      releaseId: "rel_1",
      limit: 50,
      dryRun: false,
      fetchImpl: makeFetch().fn,
    });
    expect(report.scanned).toBe(0);
    expect(report.releasesUpdated).toBe(0);
  });
});
