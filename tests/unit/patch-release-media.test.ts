import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { restoreGlobalFetch } from "../global-fetch";

/**
 * Part 1 — manual media editing via PATCH /v1/releases/:id { media: [...] }.
 * The handler REPLACES stored media[] and mirrors not-yet-mirrored items
 * through `processMediaForR2` when the MEDIA bucket is bound. We mock the R2
 * bucket + global fetch so no network/R2 is touched.
 */

let testDb: TestDatabase;

interface PutCall {
  key: string;
}

/** Minimal in-memory R2 bucket: records `put` calls, supports `onConflictDoNothing` registry inserts. */
function makeBucket() {
  const puts: PutCall[] = [];
  return {
    puts,
    async put(key: string) {
      puts.push({ key });
      return { key } as unknown;
    },
  } as unknown as R2Bucket & { puts: PutCall[] };
}

/** A 2KB fake PNG body so `processMediaForR2` passes the [1KB, 8MB] size gate. */
function fakeImageResponse(): Response {
  const bytes = new Uint8Array(2048).fill(7);
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
  });
}

function makeEnv(bucket: ReturnType<typeof makeBucket>) {
  return {
    DB: testDb.db as unknown as never,
    MEDIA: bucket as unknown as R2Bucket,
    MEDIA_ORIGIN: "https://media.releases.sh",
    GITHUB_TOKEN: { get: async () => "test-token" },
  };
}

async function seed() {
  await testDb.db.insert(organizations).values({ id: "org_acme", name: "Acme", slug: "acme" });
  await testDb.db.insert(sources).values({
    id: "src_1",
    name: "Acme Changelog",
    slug: "acme-changelog",
    orgId: "org_acme",
    type: "scrape",
    url: "https://acme.example/changelog",
  });
  await testDb.db.insert(releases).values({
    id: "rel_1",
    sourceId: "src_1",
    title: "v1",
    content: "release body",
    type: "feature",
    suppressed: false,
    media: JSON.stringify([{ type: "image", url: "https://old.example/hero.png" }]),
  });
}

async function patch(
  env: ReturnType<typeof makeEnv>,
  id: string,
  body: unknown,
): Promise<Response> {
  return sourceRoutes.request(
    `/releases/${id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(async () => {
  testDb = createTestDb();
  await seed();
});

afterEach(() => {
  testDb.cleanup();
  restoreGlobalFetch();
});

describe("PATCH /v1/releases/:id media editing", () => {
  test("replaces media[] and mirrors a third-party image to R2 (r2Key stamped)", async () => {
    let fetched = 0;
    globalThis.fetch = (() => {
      fetched++;
      return Promise.resolve(fakeImageResponse());
    }) as unknown as typeof fetch;

    const bucket = makeBucket();
    const res = await patch(makeEnv(bucket), "rel_1", {
      media: [{ type: "image", url: "https://cdn.example/new-shot.png", alt: "New shot" }],
    });
    expect(res.status).toBe(200);

    // The poster was fetched + put to R2.
    expect(fetched).toBe(1);
    expect(bucket.puts.length).toBe(1);
    expect(bucket.puts[0]!.key).toMatch(/^releases\/[0-9a-f]{64}\.png$/);

    const [row] = await testDb.db
      .select({ media: releases.media })
      .from(releases)
      .where(eq(releases.id, "rel_1"));
    const media = JSON.parse(row!.media!) as Array<{ url: string; r2Key?: string; alt?: string }>;
    // Old hero replaced wholesale by the new single item.
    expect(media.length).toBe(1);
    expect(media[0]!.url).toBe("https://cdn.example/new-shot.png");
    expect(media[0]!.alt).toBe("New shot");
    expect(media[0]!.r2Key).toMatch(/^releases\/[0-9a-f]{64}\.png$/);
  });

  test("passes through an already-mirrored item (r2Key present) without re-fetching", async () => {
    let fetched = 0;
    globalThis.fetch = (() => {
      fetched++;
      return Promise.resolve(fakeImageResponse());
    }) as unknown as typeof fetch;

    const bucket = makeBucket();
    const res = await patch(makeEnv(bucket), "rel_1", {
      media: [{ type: "image", url: "https://cdn.example/already.png", r2Key: "releases/abc.png" }],
    });
    expect(res.status).toBe(200);
    // No fetch / no put — the item carried an r2Key already.
    expect(fetched).toBe(0);
    expect(bucket.puts.length).toBe(0);

    const [row] = await testDb.db
      .select({ media: releases.media })
      .from(releases)
      .where(eq(releases.id, "rel_1"));
    const media = JSON.parse(row!.media!) as Array<{ r2Key?: string }>;
    expect(media[0]!.r2Key).toBe("releases/abc.png");
  });

  test("passes through an item already on the media origin", async () => {
    let fetched = 0;
    globalThis.fetch = (() => {
      fetched++;
      return Promise.resolve(fakeImageResponse());
    }) as unknown as typeof fetch;

    const bucket = makeBucket();
    const res = await patch(makeEnv(bucket), "rel_1", {
      media: [{ type: "image", url: "https://media.releases.sh/releases/deadbeef.png" }],
    });
    expect(res.status).toBe(200);
    expect(fetched).toBe(0);
    expect(bucket.puts.length).toBe(0);
  });

  test("stores media verbatim when the MEDIA bucket is unbound", async () => {
    const env = {
      DB: testDb.db as unknown as never,
      MEDIA_ORIGIN: "https://media.releases.sh",
      GITHUB_TOKEN: { get: async () => "test-token" },
    } as unknown as ReturnType<typeof makeEnv>;

    const res = await patch(env, "rel_1", {
      media: [{ type: "image", url: "https://cdn.example/x.png" }],
    });
    expect(res.status).toBe(200);
    const [row] = await testDb.db
      .select({ media: releases.media })
      .from(releases)
      .where(eq(releases.id, "rel_1"));
    const media = JSON.parse(row!.media!) as Array<{ url: string; r2Key?: string }>;
    expect(media[0]!.url).toBe("https://cdn.example/x.png");
    expect(media[0]!.r2Key).toBeUndefined();
  });

  test("media-only payload is accepted (does not 400 as empty); empty body still 400s", async () => {
    const bucket = makeBucket();
    // Empty media array is a valid wholesale replace (clears media[]).
    const ok = await patch(makeEnv(bucket), "rel_1", { media: [] });
    expect(ok.status).toBe(200);
    const [row] = await testDb.db
      .select({ media: releases.media })
      .from(releases)
      .where(eq(releases.id, "rel_1"));
    expect(JSON.parse(row!.media!)).toEqual([]);

    // Truly empty body still 400s.
    const empty = await patch(makeEnv(bucket), "rel_1", {});
    expect(empty.status).toBe(400);
  });

  test("404 for an unknown release id", async () => {
    const res = await patch(makeEnv(makeBucket()), "rel_missing", {
      media: [{ type: "image", url: "https://cdn.example/x.png" }],
    });
    expect(res.status).toBe(404);
  });
});
