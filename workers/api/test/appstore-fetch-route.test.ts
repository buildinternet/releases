/**
 * Regression test: POST /v1/sources/:id/fetch for an appstore source must pass
 * through to fetchOne (real iTunes lookup + insert) rather than falling into the
 * flagged/queued no-op branch.
 *
 * Before the fix, the eligibility guard in sources.ts did not include
 * `isAppStoreFetched(src)`, so appstore sources were silently "queued" with
 * { queued: true, type: "flagged" } and no release was ever inserted.
 *
 * Mirrors appstore-materialize.test.ts: static import of sourceRoutes, only the
 * network is stubbed (globalThis.fetch). No mock.module — that leaks across
 * bun's shared test process and poisons sibling tests that use the real feed
 * adapter (workflows-ai, poll-fetch-github-override).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const LISTING = JSON.stringify({
  resultCount: 1,
  results: [
    {
      trackId: 324684580,
      bundleId: "com.spotify.client",
      trackName: "Spotify",
      version: "9.0.12",
      currentVersionReleaseDate: "2026-05-19T11:42:00Z",
      releaseNotes: "Bug fixes.",
      trackViewUrl: "https://apps.apple.com/us/app/id324684580?uo=4",
      sellerName: "Spotify AB",
      primaryGenreName: "Music",
      artworkUrl512: "https://is1-ssl.mzstatic.com/a/512x512bb.jpg",
      screenshotUrls: [],
      ipadScreenshotUrls: [],
      minimumOsVersion: "13.0",
    },
  ],
});

// Minimal STATUS_HUB DO stub — the :slug/fetch route emits a status event at the
// end via getStatusHub. Same shape used by the other sourceRoutes fetch tests.
const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({
    fetch: async () => new Response("ok", { status: 200 }),
  }),
};

async function seedAppStoreSource(db: ReturnType<typeof createTestDb>) {
  await db.insert(organizations).values({ id: "org_s", name: "Spotify", slug: "spotify" });
  await db.insert(sources).values({
    id: "src_s",
    name: "Spotify iOS",
    slug: "spotify-ios",
    type: "appstore",
    url: "https://apps.apple.com/us/app/id324684580",
    orgId: "org_s",
    metadata: JSON.stringify({
      appStore: { trackId: "324684580", platform: "ios", storefront: "us" },
    }),
  });
}

describe("POST /v1/sources/:id/fetch — appstore eligibility", () => {
  it("routes an appstore source through fetchOne (fetched, release inserted) not the flagged branch", async () => {
    const db = createTestDb();
    await seedAppStoreSource(db);
    globalThis.fetch = (async () =>
      new Response(LISTING, { status: 200 })) as unknown as typeof realFetch;
    const app = createTestApp(db, [sourceRoutes], { env: { STATUS_HUB: statusHubStub } });

    // Typed-id bare path works without an org-scoped prefix.
    const res = await app(new Request("https://x.test/v1/sources/src_s/fetch", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Must NOT be the flagged/queued no-op shape.
    expect(body.queued).toBeUndefined();
    expect(body.type).not.toBe("flagged");

    // Must report a real fetch.
    expect(body.fetched).toBe(true);
    expect(body.releasesInserted).toBe(1);

    // Strongest signal: a release row was actually inserted for this source.
    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_s"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toContain("?v=");
    expect(rows[0]!.url).toBe("https://apps.apple.com/us/app/id324684580?v=9.0.12");
    expect(rows[0]!.version).toBe("9.0.12");
  });
});
