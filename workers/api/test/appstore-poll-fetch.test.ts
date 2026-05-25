import { describe, it, expect, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { fetchOne, pollOne } from "../src/cron/poll-fetch.js";
import { createTestDb } from "./setup";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function listingJson(version: string) {
  return JSON.stringify({
    resultCount: 1,
    results: [
      {
        trackId: 324684580,
        bundleId: "com.spotify.client",
        trackName: "Spotify",
        version,
        currentVersionReleaseDate: "2026-05-19T11:42:00Z",
        releaseNotes: `Notes for ${version}`,
        trackViewUrl: "https://apps.apple.com/us/app/id324684580?uo=4",
        artworkUrl512: "https://is1-ssl.mzstatic.com/a/512x512bb.jpg",
        screenshotUrls: [],
        ipadScreenshotUrls: [],
      },
    ],
  });
}

async function seedAppStoreSource(db: ReturnType<typeof createTestDb>) {
  await db.insert(organizations).values({ id: "org_s", name: "Spotify", slug: "spotify" });
  await db.insert(sources).values({
    id: "src_s",
    name: "Spotify",
    slug: "spotify-ios",
    type: "appstore",
    url: "https://apps.apple.com/us/app/id324684580",
    orgId: "org_s",
    metadata: JSON.stringify({
      appStore: { trackId: "324684580", platform: "ios", storefront: "us" },
    }),
  });
  return (await db.select().from(sources).where(eq(sources.id, "src_s")))[0]!;
}

describe("appstore fetchOne", () => {
  it("mints a release with a version-distinct URL, and dedups on re-fetch", async () => {
    const db = createTestDb();
    const source = await seedAppStoreSource(db);
    globalThis.fetch = (async () =>
      new Response(listingJson("9.0.12"), { status: 200 })) as unknown as typeof fetch;

    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const first = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(first.releasesInserted).toBe(1);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_s"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe("https://apps.apple.com/us/app/id324684580?v=9.0.12");
    expect(rows[0]!.version).toBe("9.0.12");

    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const second = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(second.releasesInserted).toBe(0);
    expect(await db.select().from(releases).where(eq(releases.sourceId, "src_s"))).toHaveLength(1);
  });

  it("mints a second release when the version bumps", async () => {
    const db = createTestDb();
    const source = await seedAppStoreSource(db);
    globalThis.fetch = (async () =>
      new Response(listingJson("9.0.12"), { status: 200 })) as unknown as typeof fetch;
    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    globalThis.fetch = (async () =>
      new Response(listingJson("9.1.0"), { status: 200 })) as unknown as typeof fetch;
    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(await db.select().from(releases).where(eq(releases.sourceId, "src_s"))).toHaveLength(2);
  });
});

describe("appstore pollOne", () => {
  it("marks the source changed without an HTTP probe", async () => {
    const db = createTestDb();
    const source = await seedAppStoreSource(db);
    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const result = await pollOne(db as any, source, new Date());
    expect(result.changed).toBe(true);
  });
});
