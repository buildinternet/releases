import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, sourceRawSnapshots } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../../tests/db-helper.js";
import { createDb } from "../db.js";
import { saveRawSnapshot, loadRawSnapshot } from "./raw-snapshot.js";

function fakeR2() {
  const store = new Map<string, string>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer | string) => {
      store.set(k, typeof v === "string" ? v : new TextDecoder().decode(v));
    },
    get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
    head: async (k: string) => (store.has(k) ? {} : null),
  };
}

async function seedSource(db: ReturnType<typeof createDb>): Promise<void> {
  await db.insert(organizations).values({
    id: "org_a",
    slug: "acme",
    name: "Acme",
    category: "developer-tools",
  });
  await db.insert(sources).values({
    id: "src_x",
    orgId: "org_a",
    slug: "acme-blog",
    name: "Acme Blog",
    type: "scrape",
    url: "https://acme.test/changelog",
  });
}

describe("saveRawSnapshot / loadRawSnapshot", () => {
  it("round-trip: saves body to R2 + D1 pointer and loads it back", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    await seedSource(db);

    const R2 = fakeR2();
    const body = "# v1\nhello";

    const result = await saveRawSnapshot(
      { R2, db },
      { sourceId: "src_x", body, format: "markdown" },
    );

    // r2Key shape
    expect(result.r2Key).toBe(`sources/src_x/raw/${result.contentHash}.md`);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bytes).toBe(new TextEncoder().encode(body).length);
    // First save records a new pointer row.
    expect(result.created).toBe(true);

    // R2 store holds the body
    expect(R2.store.get(result.r2Key)).toBe(body);

    // Exactly one D1 pointer row
    const rows = await db
      .select()
      .from(sourceRawSnapshots)
      .where(eq(sourceRawSnapshots.sourceId, "src_x"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.r2Key).toBe(result.r2Key);
    expect(rows[0]!.contentHash).toBe(result.contentHash);
    expect(rows[0]!.format).toBe("markdown");
    expect(rows[0]!.bytes).toBe(result.bytes);

    // loadRawSnapshot returns the body
    const loaded = await loadRawSnapshot({ R2 }, result.r2Key);
    expect(loaded).toBe(body);
  });

  it("content-hash idempotent: same (sourceId, body) twice → same r2Key, exactly one pointer row", async () => {
    const { db: testDb } = createTestDb();
    const db = createDb(testDb as unknown as D1Database);
    await seedSource(db);

    const R2 = fakeR2();
    const body = "# v1\nhello";

    const first = await saveRawSnapshot(
      { R2, db },
      { sourceId: "src_x", body, format: "markdown" },
    );
    const second = await saveRawSnapshot(
      { R2, db },
      { sourceId: "src_x", body, format: "markdown" },
    );

    // Same r2Key returned both times
    expect(second.r2Key).toBe(first.r2Key);
    expect(second.contentHash).toBe(first.contentHash);

    // `created` distinguishes the new store from the dedup hit.
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    // Still exactly one D1 row
    const rows = await db
      .select()
      .from(sourceRawSnapshots)
      .where(eq(sourceRawSnapshots.sourceId, "src_x"));
    expect(rows).toHaveLength(1);
  });
});
