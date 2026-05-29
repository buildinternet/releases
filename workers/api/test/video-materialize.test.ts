/**
 * Tests for `materializeVideoSource`.
 *
 * Uses a real in-memory SQLite DB (same pattern as ingest-raw-releases.test.ts):
 *   Database + drizzle + applyMigrations + ensureBatchShim
 *
 * The marketing classifier is fail-open: when ANTHROPIC_API_KEY is absent,
 * classifyMarketingForReleases returns an empty Map and items are inserted
 * visibly — so no real API calls are made.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { materializeVideoSource } from "../src/lib/video-materialize.js";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../../packages/adapters/test/fixtures/youtube-playlist.xml"),
  "utf8",
);

function mkDb() {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb);
}

describe("materializeVideoSource", () => {
  test("creates a video source under the given org and backfills releases", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_test", name: "Anthropic", slug: "anthropic", discovery: "curated" });

    const fakeFetch = (async () =>
      new Response(FIXTURE, { status: 200, headers: { etag: '"v1"' } })) as unknown as typeof fetch;

    const result = await materializeVideoSource(
      db as never,
      // no key → marketing filter fails-open (logs warn + returns empty Map)
      { ANTHROPIC_API_KEY: undefined, RELEASE_HUB: undefined, DB: undefined } as never,
      {
        url: "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
        orgSlug: "anthropic",
        fetchImpl: fakeFetch,
      },
    );

    expect(result.status).toBe("indexed");
    if (result.status !== "indexed") throw new Error("expected indexed");

    expect(result.releaseCount).toBe(2);
    expect(result.source.type).toBe("video");
    const meta = JSON.parse(result.source.metadata ?? "{}");
    expect(meta.video.provider).toBe("youtube");
    expect(meta.feedUrl).toContain("playlist_id=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va");
    expect(meta.marketingFilter).toBe(true);

    // Verify releases were actually inserted.
    const rows = await db.select().from(releases).where(eq(releases.sourceId, result.source.id));
    expect(rows).toHaveLength(2);
  });

  test("idempotent on feedUrl — second call returns existing", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_test", name: "Anthropic", slug: "anthropic", discovery: "curated" });

    const fakeFetch = (async () =>
      new Response(FIXTURE, { status: 200 })) as unknown as typeof fetch;

    const params = {
      url: "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
      orgSlug: "anthropic",
      fetchImpl: fakeFetch,
    };
    const env = { ANTHROPIC_API_KEY: undefined, RELEASE_HUB: undefined, DB: undefined } as never;

    await materializeVideoSource(db as never, env, params);
    const second = await materializeVideoSource(db as never, env, params);
    expect(second.status).toBe("existing");

    // Only one source row.
    const rows = await db.select().from(sources);
    expect(rows).toHaveLength(1);
  });

  test("bad_request when URL is not a recognized video URL", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_test", name: "Anthropic", slug: "anthropic", discovery: "curated" });

    const result = await materializeVideoSource(db as never, {} as never, {
      url: "https://example.com/not-a-video",
      orgSlug: "anthropic",
    });
    expect(result.status).toBe("bad_request");
  });

  test("org_not_found when orgSlug does not match any org", async () => {
    const db = mkDb();

    const fakeFetch = (async () =>
      new Response(FIXTURE, { status: 200 })) as unknown as typeof fetch;

    const result = await materializeVideoSource(db as never, {} as never, {
      url: "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
      orgSlug: "nonexistent",
      fetchImpl: fakeFetch,
    });
    expect(result.status).toBe("org_not_found");
  });

  test("feed_unavailable when fetchAndParseVideoFeed returns a non-2xx response", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_test", name: "Anthropic", slug: "anthropic", discovery: "curated" });

    // The playlist URL resolves its feedUrl purely (no network), but the feed
    // fetch itself returns a 403 — simulating a private playlist.
    const fakeFetch = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;

    const result = await materializeVideoSource(db as never, {} as never, {
      url: "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
      orgSlug: "anthropic",
      fetchImpl: fakeFetch,
    });
    expect(result.status).toBe("feed_unavailable");
  });
});
