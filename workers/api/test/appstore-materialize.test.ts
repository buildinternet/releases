import { describe, it, expect, afterEach } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
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

describe("POST /v1/sources/appstore", () => {
  it("materializes org + product + source + first release from a store URL", async () => {
    const db = createTestDb();
    globalThis.fetch = (async () =>
      new Response(LISTING, { status: 200 })) as unknown as typeof realFetch;
    const app = createTestApp(db, [sourceRoutes], { env: {} });

    const res = await app(
      new Request("https://x.test/v1/sources/appstore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://apps.apple.com/us/app/id324684580" }),
      }),
    );
    expect(res.status).toBe(201);

    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "spotify-ab"));
    expect(org).toBeDefined();

    const [prod] = await db.select().from(products).where(eq(products.orgId, org!.id));
    expect(prod?.kind).toBe("mobile");
    expect(prod?.avatarUrl).toBe("https://is1-ssl.mzstatic.com/a/1024x1024bb.png");

    const [src] = await db.select().from(sources).where(eq(sources.orgId, org!.id));
    expect(src?.type).toBe("appstore");
    expect(src?.slug).toBe("spotify-ios");
    expect(src?.url).toBe("https://apps.apple.com/us/app/id324684580");

    const rel = await db.select().from(releases).where(eq(releases.sourceId, src!.id));
    expect(rel).toHaveLength(1);
    expect(rel[0]!.url).toBe("https://apps.apple.com/us/app/id324684580?v=9.0.12");
  });

  it("is idempotent — a second call returns the existing source, no duplicate", async () => {
    const db = createTestDb();
    globalThis.fetch = (async () =>
      new Response(LISTING, { status: 200 })) as unknown as typeof realFetch;
    const app = createTestApp(db, [sourceRoutes], { env: {} });
    const body = JSON.stringify({ url: "https://apps.apple.com/us/app/id324684580" });
    const init = { method: "POST", headers: { "content-type": "application/json" }, body };

    await app(new Request("https://x.test/v1/sources/appstore", init));
    const res2 = await app(new Request("https://x.test/v1/sources/appstore", init));

    // Second call: no new resource, so 200 (not 201) with status: "existing".
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { status: string }).status).toBe("existing");

    expect(await db.select().from(sources)).toHaveLength(1);
    expect(await db.select().from(organizations)).toHaveLength(1);
  });

  it("returns 404 when the lookup finds nothing", async () => {
    const db = createTestDb();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ resultCount: 0, results: [] }), {
        status: 200,
      })) as unknown as typeof realFetch;
    const app = createTestApp(db, [sourceRoutes], { env: {} });
    const res = await app(
      new Request("https://x.test/v1/sources/appstore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackId: "1" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when neither url nor trackId is supplied", async () => {
    const db = createTestDb();
    const app = createTestApp(db, [sourceRoutes], { env: {} });
    const res = await app(
      new Request("https://x.test/v1/sources/appstore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
});
