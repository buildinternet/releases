import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { runMediaBackfill, runGifTranscodeBackfill } from "../src/lib/media-backfill";
import type { MediaTransformBinding } from "../src/lib/media-ingest";

/**
 * `runMediaBackfill` re-mirrors third-party release images to R2 for rows stored
 * before ingest-time mirroring was on. The ingest upsert never updates `media`
 * on conflict, so this is the only path that backfills existing rows.
 */

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function seedSource(db: ReturnType<typeof mkDb>, id: string, orgId = "org_x") {
  db.insert(organizations)
    .values({ id: orgId, name: orgId, slug: orgId })
    .onConflictDoNothing()
    .run();
  db.insert(sources)
    .values({ id, slug: id, name: id, orgId, type: "scrape", url: `https://x.test/${id}` } as any)
    .run();
}

let relSeq = 0;
function seedRelease(
  db: ReturnType<typeof mkDb>,
  opts: { sourceId: string; media: unknown; publishedAt?: string; suppressed?: boolean },
) {
  const id = `rel_${++relSeq}`;
  db.insert(releases)
    .values({
      id,
      sourceId: opts.sourceId,
      title: id,
      content: "body",
      media: JSON.stringify(opts.media),
      publishedAt: opts.publishedAt ?? "2026-05-01T00:00:00.000Z",
      suppressed: opts.suppressed ?? false,
    } as any)
    .run();
  return id;
}

const IMG = (url: string) => ({ type: "image", url });

// A stub R2 bucket that records puts; a fetch that returns a valid 2KB PNG.
function deps() {
  const puts: string[] = [];
  const bucket = {
    put: async (key: string) => {
      puts.push(key);
      return undefined;
    },
  } as unknown as R2Bucket;
  const fetchImpl = (async () =>
    new Response(new Uint8Array(2048), {
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
  return { puts, bucket, fetchImpl, now: () => "2026-05-31T00:00:00.000Z" };
}

function mediaOf(db: ReturnType<typeof mkDb>, id: string): string {
  const [row] = db
    .select({ media: releases.media })
    .from(releases)
    .where(eq(releases.id, id))
    .all();
  return row!.media ?? "";
}

describe("runMediaBackfill", () => {
  it("dry run reports candidates + pending count without writing", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const r1 = seedRelease(db, { sourceId: "src_a", media: [IMG("https://cdn.test/a.png")] });
    seedRelease(db, { sourceId: "src_a", media: [IMG("https://cdn.test/b.png")] });
    const { bucket, fetchImpl, now } = deps();

    const report = await runMediaBackfill(db as any, bucket, {
      limit: 50,
      dryRun: true,
      fetchImpl,
      now,
    });

    expect(report.scanned).toBe(2);
    expect(report.releasesUpdated).toBe(0);
    expect(report.remaining).toBe(2);
    expect(mediaOf(db, r1)).not.toContain("r2Key");
  });

  it("mirrors images, stamps r2Key, and is idempotent on re-run", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const r1 = seedRelease(db, { sourceId: "src_a", media: [IMG("https://cdn.test/a.png")] });
    seedRelease(db, { sourceId: "src_a", media: [IMG("https://cdn.test/b.png")] });
    const { puts, bucket, fetchImpl, now } = deps();

    const report = await runMediaBackfill(db as any, bucket, {
      limit: 50,
      dryRun: false,
      fetchImpl,
      now,
    });

    expect(report.releasesUpdated).toBe(2);
    expect(report.imagesMirrored).toBe(2);
    expect(report.remaining).toBe(0);
    expect(puts).toHaveLength(2);
    expect(mediaOf(db, r1)).toContain("r2Key");
    expect(mediaOf(db, r1)).toContain("releases/");

    // Re-run: the mirrored rows now carry r2Key, so nothing is a candidate.
    const second = await runMediaBackfill(db as any, bucket, {
      limit: 50,
      dryRun: false,
      fetchImpl,
      now,
    });
    expect(second.scanned).toBe(0);
    expect(second.releasesUpdated).toBe(0);
  });

  it("scopes to a single source when sourceId is given", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    seedSource(db, "src_b", "org_y");
    const a = seedRelease(db, { sourceId: "src_a", media: [IMG("https://cdn.test/a.png")] });
    const b = seedRelease(db, { sourceId: "src_b", media: [IMG("https://cdn.test/b.png")] });
    const { bucket, fetchImpl, now } = deps();

    const report = await runMediaBackfill(db as any, bucket, {
      sourceId: "src_a",
      limit: 50,
      dryRun: false,
      fetchImpl,
      now,
    });

    expect(report.scanned).toBe(1);
    expect(report.releasesUpdated).toBe(1);
    expect(mediaOf(db, a)).toContain("r2Key");
    expect(mediaOf(db, b)).not.toContain("r2Key");
    // `remaining` is scoped to the same sourceId, so src_a is now drained.
    // src_b is untouched but belongs to a different scope.
    expect(report.remaining).toBe(0);
  });

  it("never re-mirrors a row that already has an r2Key", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    seedRelease(db, {
      sourceId: "src_a",
      media: [{ type: "image", url: "https://cdn.test/a.png", r2Key: "releases/deadbeef.png" }],
    });
    const { bucket, fetchImpl, now } = deps();

    const report = await runMediaBackfill(db as any, bucket, {
      limit: 50,
      dryRun: false,
      fetchImpl,
      now,
    });
    expect(report.scanned).toBe(0);
  });

  it("leaves a junk-only row untouched (filterJunkMedia drops it)", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const j = seedRelease(db, {
      sourceId: "src_a",
      media: [IMG("https://cdn.test/favicon.ico")],
    });
    const { puts, bucket, fetchImpl, now } = deps();

    const report = await runMediaBackfill(db as any, bucket, {
      limit: 50,
      dryRun: false,
      fetchImpl,
      now,
    });
    expect(report.releasesUpdated).toBe(0);
    expect(puts).toHaveLength(0);
    expect(mediaOf(db, j)).not.toContain("r2Key");
  });
});

const GIF = (url: string) => ({ type: "image", url }); // stored mistyped as image, like beehiiv

/** Deps for the GIF backfill: a fetch that returns a `body`-bearing image/gif and
 *  a fake Media Transformations binding that emits dummy MP4 bytes. */
function gifDeps() {
  const puts: string[] = [];
  const bucket = {
    put: async (key: string) => {
      puts.push(key);
      return undefined;
    },
  } as unknown as R2Bucket;
  const fetchImpl = (async () =>
    new Response(new Uint8Array(2048).fill(9), {
      headers: { "content-type": "image/gif" },
    })) as unknown as typeof fetch;
  let inputs = 0;
  const mediaTransform = {
    input(stream: ReadableStream<Uint8Array>) {
      inputs++;
      void stream.getReader().read();
      const chain = {
        transform: () => chain,
        output: () => ({
          media: async () => new Response(new Uint8Array(512).fill(1)).body!,
          contentType: async () => "video/mp4",
        }),
      };
      return chain;
    },
  } as unknown as MediaTransformBinding;
  return {
    puts,
    bucket,
    fetchImpl,
    mediaTransform,
    getInputs: () => inputs,
    now: () => "2026-05-31T00:00:00.000Z",
  };
}

describe("runGifTranscodeBackfill", () => {
  it("dry run reports candidates + pending count without transcoding", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const r1 = seedRelease(db, { sourceId: "src_a", media: [GIF("https://x.test/a.gif")] });
    seedRelease(db, { sourceId: "src_a", media: [GIF("https://x.test/b.gif")] });
    const { bucket, mediaTransform, fetchImpl, getInputs, now } = gifDeps();

    const report = await runGifTranscodeBackfill(db as any, bucket, mediaTransform, {
      limit: 50,
      dryRun: true,
      fetchImpl,
      now,
    });

    expect(report.scanned).toBe(2);
    expect(report.releasesUpdated).toBe(0);
    expect(report.gifsTranscoded).toBe(0);
    expect(report.remaining).toBe(2);
    expect(getInputs()).toBe(0);
    expect(mediaOf(db, r1)).not.toContain("mp4");
  });

  it("transcodes GIFs to MP4, stamps an .mp4 r2Key, and converges on re-run", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const r1 = seedRelease(db, { sourceId: "src_a", media: [GIF("https://x.test/a.gif")] });
    const { puts, bucket, mediaTransform, fetchImpl, now } = gifDeps();

    const report = await runGifTranscodeBackfill(db as any, bucket, mediaTransform, {
      limit: 50,
      dryRun: false,
      fetchImpl,
      now,
    });

    expect(report.releasesUpdated).toBe(1);
    expect(report.gifsTranscoded).toBe(1);
    expect(report.remaining).toBe(0); // row now carries an .mp4 → out of the filter
    expect(puts[0]).toMatch(/^releases\/[0-9a-f]{64}\.mp4$/);
    const media = mediaOf(db, r1);
    expect(media).toContain(".mp4");
    expect(media).toContain("https://x.test/a.gif"); // original url preserved
    expect(media).toContain('"type":"gif"');

    // Re-run: the row now has an .mp4, so it's no longer a candidate.
    const second = await runGifTranscodeBackfill(db as any, bucket, mediaTransform, {
      limit: 50,
      dryRun: false,
      fetchImpl,
      now,
    });
    expect(second.scanned).toBe(0);
  });

  it("preserves non-GIF items in the same row (only the GIF is re-keyed)", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const r1 = seedRelease(db, {
      sourceId: "src_a",
      media: [
        { type: "image", url: "https://x.test/shot.png", r2Key: "releases/deadbeef.png" },
        GIF("https://x.test/a.gif"),
      ],
    });
    const { bucket, mediaTransform, fetchImpl, now } = gifDeps();

    const report = await runGifTranscodeBackfill(db as any, bucket, mediaTransform, {
      limit: 50,
      dryRun: false,
      fetchImpl,
      now,
    });

    expect(report.gifsTranscoded).toBe(1);
    const media = mediaOf(db, r1);
    expect(media).toContain("releases/deadbeef.png"); // png r2Key untouched
    expect(media).toContain(".mp4");
  });

  it("fail-open: a transcode error leaves the row unchanged", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const r1 = seedRelease(db, { sourceId: "src_a", media: [GIF("https://x.test/a.gif")] });
    const { puts, bucket, fetchImpl, now } = gifDeps();
    const failing = {
      input() {
        const chain = {
          transform: () => chain,
          output: () => ({
            media: async () => {
              throw new Error("transcode failed");
            },
            contentType: async () => "video/mp4",
          }),
        };
        return chain;
      },
    } as unknown as MediaTransformBinding;

    const report = await runGifTranscodeBackfill(db as any, bucket, failing, {
      limit: 50,
      dryRun: false,
      fetchImpl,
      now,
    });

    expect(report.releasesUpdated).toBe(0);
    expect(puts).toHaveLength(0);
    expect(mediaOf(db, r1)).not.toContain("mp4");
  });
});
