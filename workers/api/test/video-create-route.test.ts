/**
 * Route smoke tests for POST /v1/sources/video.
 *
 * Focuses on the DB-free 400 paths (missing url; non-video url) and the
 * happy path with a stubbed fetch + seeded org. Modeled on
 * appstore-materialize.test.ts / appstore-fetch-route.test.ts.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../../packages/adapters/test/fixtures/youtube-playlist.xml"),
  "utf8",
);

afterEach(() => {
  restoreGlobalFetch();
});

describe("POST /v1/sources/video", () => {
  it("returns 400 when url is missing", async () => {
    const db = createTestDb();
    const app = createTestApp(db, [sourceRoutes], { env: {} });

    const res = await app(
      new Request("https://x.test/v1/sources/video", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug: "anthropic" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("returns 400 when orgSlug and orgId are both missing", async () => {
    const db = createTestDb();
    const app = createTestApp(db, [sourceRoutes], { env: {} });

    const res = await app(
      new Request("https://x.test/v1/sources/video", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("returns 400 for a non-video URL", async () => {
    const db = createTestDb();
    const app = createTestApp(db, [sourceRoutes], { env: {} });

    const res = await app(
      new Request("https://x.test/v1/sources/video", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/not-a-video", orgSlug: "anthropic" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("returns 404 when the org is not found", async () => {
    const db = createTestDb();
    // Stub the feed fetch — resolveFeed for a playlist URL is pure (no network),
    // but fetchAndParseVideoFeed will be called and needs to not hit real YouTube.
    globalThis.fetch = (async () =>
      new Response(FIXTURE, { status: 200 })) as unknown as typeof fetch;
    const app = createTestApp(db, [sourceRoutes], { env: {} });

    const res = await app(
      new Request("https://x.test/v1/sources/video", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
          orgSlug: "nonexistent-org",
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("materializes a video source and returns 201", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({
      id: "org_claude",
      name: "Anthropic",
      slug: "anthropic",
      discovery: "curated",
    });

    globalThis.fetch = (async () =>
      new Response(FIXTURE, { status: 200 })) as unknown as typeof fetch;

    const app = createTestApp(db, [sourceRoutes], { env: {} });

    const res = await app(
      new Request("https://x.test/v1/sources/video", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
          orgSlug: "anthropic",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; releaseCount: number };
    expect(body.status).toBe("indexed");
    expect(body.releaseCount).toBe(2);

    const [src] = await db.select().from(sources);
    expect(src?.type).toBe("video");

    const rels = await db.select().from(releases);
    expect(rels).toHaveLength(2);
  });

  it("returns 200 with existing status on a second call (idempotent)", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({
      id: "org_claude",
      name: "Anthropic",
      slug: "anthropic",
      discovery: "curated",
    });

    globalThis.fetch = (async () =>
      new Response(FIXTURE, { status: 200 })) as unknown as typeof fetch;

    const app = createTestApp(db, [sourceRoutes], { env: {} });
    const body = JSON.stringify({
      url: "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
      orgSlug: "anthropic",
    });
    const init = { method: "POST", headers: { "content-type": "application/json" }, body };

    await app(new Request("https://x.test/v1/sources/video", init));
    const res2 = await app(new Request("https://x.test/v1/sources/video", init));

    expect(res2.status).toBe(200);
    const resBody = (await res2.json()) as { status: string };
    expect(resBody.status).toBe("existing");

    // Only one source row created.
    const rows = await db.select().from(sources);
    expect(rows).toHaveLength(1);
  });
});
