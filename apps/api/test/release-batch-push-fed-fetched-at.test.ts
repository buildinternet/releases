/**
 * Push-fed sources (#2374) have no poll cron to stamp `lastFetchedAt`; the
 * batch write itself IS the fetch. `ingestReleaseBatch` must stamp it on any
 * successful call for a push-fed source, but leave it untouched for a normal
 * source (poll-fetch / the workflow owns that stamp there).
 */
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { ingestReleaseBatch } from "../src/lib/ingest/release-batch-ingest.js";
import type { D1Db } from "../src/db.js";
import { createTestDb, type TestDb } from "./setup";

const ORG_ID = "org_pf000000000000000001";

async function seedSource(db: TestDb, id: string, metadata: Record<string, unknown> = {}) {
  await db.insert(organizations).values({
    id: ORG_ID,
    slug: "pushco",
    name: "Push Co",
    category: "developer-tools",
  });
  await db.insert(sources).values({
    id,
    orgId: ORG_ID,
    slug: id,
    name: id,
    type: "scrape",
    url: `https://example.com/${id}`,
    metadata: JSON.stringify(metadata),
  });
  const [row] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
  return row as Source;
}

describe("ingestReleaseBatch — push-fed lastFetchedAt stamp (#2374)", () => {
  it("stamps lastFetchedAt for a push-fed source on a successful batch write", async () => {
    const db = createTestDb();
    const src = await seedSource(db, "src_push1", { ingestMode: "push" });
    expect(src.lastFetchedAt).toBeNull();

    await ingestReleaseBatch(db as unknown as D1Db, {}, src, {
      releases: [{ title: "Release 1", content: "Body", url: "https://example.com/1" }],
      enrichMode: false,
    });

    const [after] = await db.select().from(sources).where(eq(sources.id, src.id)).limit(1);
    expect(after!.lastFetchedAt).not.toBeNull();
  });

  it("stamps lastFetchedAt even on a no-op push (inserted === 0)", async () => {
    const db = createTestDb();
    const src = await seedSource(db, "src_push2", { ingestMode: "push" });

    // First write inserts the row; second identical write is a no-op re-run.
    await ingestReleaseBatch(db as unknown as D1Db, {}, src, {
      releases: [{ title: "Release 1", content: "Body", url: "https://example.com/1" }],
      enrichMode: false,
    });
    await db.update(sources).set({ lastFetchedAt: null }).where(eq(sources.id, src.id));

    const [{ lastFetchedAt: reset }] = await db
      .select({ lastFetchedAt: sources.lastFetchedAt })
      .from(sources)
      .where(eq(sources.id, src.id));
    expect(reset).toBeNull();

    const result = await ingestReleaseBatch(db as unknown as D1Db, {}, src, {
      releases: [{ title: "Release 1", content: "Body", url: "https://example.com/1" }],
      enrichMode: false,
    });
    expect(result.inserted).toBe(0);

    const [after] = await db.select().from(sources).where(eq(sources.id, src.id)).limit(1);
    expect(after!.lastFetchedAt).not.toBeNull();
  });

  it("does not stamp lastFetchedAt for a normal (non-push-fed) source", async () => {
    const db = createTestDb();
    const src = await seedSource(db, "src_normal1");
    expect(src.lastFetchedAt).toBeNull();

    await ingestReleaseBatch(db as unknown as D1Db, {}, src, {
      releases: [{ title: "Release 1", content: "Body", url: "https://example.com/1" }],
      enrichMode: false,
    });

    const [after] = await db.select().from(sources).where(eq(sources.id, src.id)).limit(1);
    expect(after!.lastFetchedAt).toBeNull();
  });
});
