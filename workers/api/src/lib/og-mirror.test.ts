import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../../../../tests/db-helper.js";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { mirrorReleaseOgImages, parseOgImageFromMetadata } from "./og-mirror.js";

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
  opts: { sourceId: string; title?: string; summary?: string | null; metadata?: string | null },
) {
  const id = `rel_${++relSeq}`;
  db.insert(releases)
    .values({
      id,
      sourceId: opts.sourceId,
      title: opts.title ?? id,
      content: "body",
      summary: opts.summary ?? null,
      metadata: opts.metadata ?? "{}",
      publishedAt: "2026-05-01T00:00:00.000Z",
    } as any)
    .run();
  return id;
}

function metadataOf(db: ReturnType<typeof mkDb>, id: string): string | null {
  const [row] = db
    .select({ metadata: releases.metadata })
    .from(releases)
    .where(eq(releases.id, id))
    .all();
  return row?.metadata ?? null;
}

/** Stub R2 bucket recording puts. */
function makeBucket() {
  const puts: Array<{ key: string; contentType?: string }> = [];
  const bucket = {
    put: async (
      key: string,
      _value: unknown,
      opts?: { httpMetadata?: { contentType?: string } },
    ) => {
      puts.push({ key, contentType: opts?.httpMetadata?.contentType });
      return {} as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

/** Fetch stub returning a fixed-size PNG for any URL, recording calls. */
function pngFetch(bytes = 2048, contentType = "image/png") {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return new Response(new Uint8Array(bytes).fill(1), {
      status: 200,
      headers: { "content-type": contentType },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("mirrorReleaseOgImages", () => {
  test("mirrors a release: fetches the opengraph-image route once and stamps metadata.ogImage", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const id = seedRelease(db, { sourceId: "src_a", title: "Ship it" });
    const { bucket, puts } = makeBucket();
    const { fetchImpl, calls } = pngFetch();

    const report = await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl },
      [id],
    );

    expect(report).toEqual({ attempted: 1, mirrored: 1, skippedUnchanged: 0, failed: 0 });
    expect(calls).toEqual([`https://releases.sh/release/${id}/opengraph-image`]);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(new RegExp(`^og/release/${id}-[0-9a-f]{20}\\.png$`));
    expect(puts[0]!.contentType).toBe("image/png");

    const stored = parseOgImageFromMetadata(metadataOf(db, id));
    expect(stored?.key).toBe(puts[0]!.key);
    expect(stored?.hash).toMatch(/^[0-9a-f]{20}$/);
  });

  test("idempotent: a second run against an unchanged release is a no-op (no fetch, no put)", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const id = seedRelease(db, { sourceId: "src_a", title: "Ship it" });
    const { bucket, puts } = makeBucket();
    const first = pngFetch();

    await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl: first.fetchImpl },
      [id],
    );
    expect(puts).toHaveLength(1);

    const second = pngFetch();
    const report = await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl: second.fetchImpl },
      [id],
    );

    expect(report).toEqual({ attempted: 1, mirrored: 0, skippedUnchanged: 1, failed: 0 });
    expect(second.calls).toHaveLength(0);
    expect(puts).toHaveLength(1);
  });

  test("re-mirrors when the title changes (hash changes)", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const id = seedRelease(db, { sourceId: "src_a", title: "v1" });
    const { bucket, puts } = makeBucket();

    await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl: pngFetch().fetchImpl },
      [id],
    );
    const firstKey = puts[0]!.key;

    db.update(releases)
      .set({ title: "v2 — retitled" } as any)
      .where(eq(releases.id, id))
      .run();

    const report = await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl: pngFetch().fetchImpl },
      [id],
    );

    expect(report.mirrored).toBe(1);
    expect(puts).toHaveLength(2);
    expect(puts[1]!.key).not.toBe(firstKey);
  });

  test("fail-open: a network/timeout error is caught (not thrown) and skipped", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const id = seedRelease(db, { sourceId: "src_a" });
    const { bucket, puts } = makeBucket();
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const report = await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl },
      [id],
    );

    expect(report).toEqual({ attempted: 1, mirrored: 0, skippedUnchanged: 0, failed: 1 });
    expect(puts).toHaveLength(0);
    expect(parseOgImageFromMetadata(metadataOf(db, id))).toBeNull();
  });

  test("fail-open: an R2 put error leaves metadata untouched (no dangling pointer)", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const id = seedRelease(db, { sourceId: "src_a" });
    const bucket = {
      put: async () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;
    const { fetchImpl } = pngFetch();

    const report = await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl },
      [id],
    );

    expect(report.failed).toBe(1);
    // Pointer is only written after a successful PUT — a PUT failure must not
    // stamp metadata.ogImage (that would point og:image at a missing object).
    expect(parseOgImageFromMetadata(metadataOf(db, id))).toBeNull();
  });

  test("fail-open: a non-ok render response leaves metadata untouched", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const id = seedRelease(db, { sourceId: "src_a" });
    const { bucket, puts } = makeBucket();
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const report = await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl },
      [id],
    );

    expect(report).toEqual({ attempted: 1, mirrored: 0, skippedUnchanged: 0, failed: 1 });
    expect(puts).toHaveLength(0);
    expect(parseOgImageFromMetadata(metadataOf(db, id))).toBeNull();
  });

  test("fail-open: a non-PNG content type is skipped", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const id = seedRelease(db, { sourceId: "src_a" });
    const { bucket, puts } = makeBucket();
    const { fetchImpl } = pngFetch(2048, "text/html");

    const report = await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl },
      [id],
    );

    expect(report.failed).toBe(1);
    expect(puts).toHaveLength(0);
  });

  test("fail-open: an oversized response is skipped", async () => {
    const db = mkDb();
    seedSource(db, "src_a");
    const id = seedRelease(db, { sourceId: "src_a" });
    const { bucket, puts } = makeBucket();
    const { fetchImpl } = pngFetch(4 * 1024 * 1024);

    const report = await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl },
      [id],
    );

    expect(report.failed).toBe(1);
    expect(puts).toHaveLength(0);
  });

  test("no-op for an empty id list", async () => {
    const db = mkDb();
    const { bucket } = makeBucket();
    const report = await mirrorReleaseOgImages(
      { db: db as any, bucket, webBase: "https://releases.sh", fetchImpl: pngFetch().fetchImpl },
      [],
    );
    expect(report).toEqual({ attempted: 0, mirrored: 0, skippedUnchanged: 0, failed: 0 });
  });
});

describe("parseOgImageFromMetadata", () => {
  test("returns null for missing/malformed metadata", () => {
    expect(parseOgImageFromMetadata(null)).toBeNull();
    expect(parseOgImageFromMetadata(undefined)).toBeNull();
    expect(parseOgImageFromMetadata("not json")).toBeNull();
    expect(parseOgImageFromMetadata("{}")).toBeNull();
    expect(parseOgImageFromMetadata(JSON.stringify({ ogImage: { key: "" } }))).toBeNull();
    expect(parseOgImageFromMetadata(JSON.stringify({ ogImage: "bogus" }))).toBeNull();
  });

  test("extracts a well-formed ogImage", () => {
    const raw = JSON.stringify({ ogImage: { key: "og/release/rel_1-abc.png", hash: "abc" } });
    expect(parseOgImageFromMetadata(raw)).toEqual({ key: "og/release/rel_1-abc.png", hash: "abc" });
  });

  test("preserves sibling metadata keys (json_set semantics)", () => {
    const raw = JSON.stringify({ composition: { bugs: 1, features: 0, enhancements: 0 } });
    expect(parseOgImageFromMetadata(raw)).toBeNull();
    const parsed = JSON.parse(raw);
    expect(parsed.composition).toBeDefined();
  });
});
