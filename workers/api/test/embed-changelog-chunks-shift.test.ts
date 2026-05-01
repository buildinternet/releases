/**
 * Regression test for the chunk-offset shift collision in
 * `embedChangelogFileForSource`'s onDiff handler.
 *
 * The `source_changelog_chunks` table has UNIQUE(file, offset). When a
 * prepend to a CHANGELOG shifts every chunk to a higher offset, a one-pass
 * UPDATE loop briefly tries to set chunk A's offset to a value still held
 * by chunk B and fails the UNIQUE constraint. The fix is two-phase: park
 * every row at a unique negative offset first, then write final offsets.
 *
 * Originally observed in prod 2026-04-30 on the Dagster CHANGES.md fetch.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../../../tests/db-helper";
import {
  organizations,
  sources,
  sourceChangelogFiles,
  sourceChangelogChunks,
} from "@buildinternet/releases-core/schema";
import { applyChunkOffsetUpdates, applyOnDiff, setChunkVectorIds } from "../src/cron/poll-fetch.js";
import type { D1Db } from "../src/db.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

// bun-sqlite handles share the runtime drizzle API with D1 but carry a "sync"
// type tag and don't expose .batch. Wrap with a .batch shim that resolves the
// operations sequentially so SQLite's immediate UNIQUE constraint semantics
// match D1's behaviour inside a transaction.
const asD1 = (db: ReturnType<typeof mkDb>): D1Db => {
  const handle = db as unknown as D1Db & { batch?: unknown };
  if (!handle.batch) {
    handle.batch = async (ops: ReadonlyArray<Promise<unknown>>) => {
      const out: unknown[] = [];
      for (const op of ops) {
        // oxlint-disable-next-line no-await-in-loop -- shim mirrors D1 batch ordering
        out.push(await op);
      }
      return out;
    };
  }
  return handle as D1Db;
};

async function seed(db: ReturnType<typeof mkDb>) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "developer-tools" });
  await db.insert(sources).values({
    id: "src_a",
    orgId: "org_a",
    slug: "acme-changelog",
    name: "Acme Changelog",
    type: "github",
    url: "https://github.com/acme/acme",
  });
  await db.insert(sourceChangelogFiles).values({
    id: "scf_a",
    sourceId: "src_a",
    path: "CHANGES.md",
    filename: "CHANGES.md",
    url: "https://github.com/acme/acme/blob/main/CHANGES.md",
    rawUrl: "https://raw.githubusercontent.com/acme/acme/main/CHANGES.md",
    content: "stub",
    contentHash: "hash-file",
    bytes: 4,
    fetchedAt: new Date().toISOString(),
  });
  // Three chunks at offsets 100/200/300, all "unchanged" (same content_hash)
  // when the file content shifts forward.
  await db.insert(sourceChangelogChunks).values([
    {
      id: "scc_a",
      sourceChangelogFileId: "scf_a",
      sourceId: "src_a",
      offset: 100,
      length: 50,
      tokens: 10,
      contentHash: "h-a",
      heading: "Old A",
    },
    {
      id: "scc_b",
      sourceChangelogFileId: "scf_a",
      sourceId: "src_a",
      offset: 200,
      length: 50,
      tokens: 10,
      contentHash: "h-b",
      heading: "Old B",
    },
    {
      id: "scc_c",
      sourceChangelogFileId: "scf_a",
      sourceId: "src_a",
      offset: 300,
      length: 50,
      tokens: 10,
      contentHash: "h-c",
      heading: "Old C",
    },
  ]);
}

describe("applyChunkOffsetUpdates", () => {
  it("survives a forward shift that would collide on UNIQUE(file, offset)", async () => {
    const db = mkDb();
    await seed(db);

    // Every chunk shifts forward by 100 — the previous offsets are all still
    // occupied when the loop starts. A naive one-pass UPDATE collides on the
    // unique index.
    await applyChunkOffsetUpdates(asD1(db), [
      { id: "scc_a", chunk: { offset: 200, length: 60, tokens: 12, heading: "New A" } },
      { id: "scc_b", chunk: { offset: 300, length: 70, tokens: 14, heading: "New B" } },
      { id: "scc_c", chunk: { offset: 400, length: 80, tokens: 16, heading: "New C" } },
    ]);

    const rows = await db
      .select()
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.sourceChangelogFileId, "scf_a"))
      .orderBy(sourceChangelogChunks.offset);

    expect(rows.map((r) => [r.id, r.offset, r.length, r.tokens, r.heading])).toEqual([
      ["scc_a", 200, 60, 12, "New A"],
      ["scc_b", 300, 70, 14, "New B"],
      ["scc_c", 400, 80, 16, "New C"],
    ]);
  });

  it("handles a permutation (swap) of two chunk offsets", async () => {
    const db = mkDb();
    await seed(db);

    // Pure swap of A↔B's offsets — no naive ordering avoids collision.
    await applyChunkOffsetUpdates(asD1(db), [
      { id: "scc_a", chunk: { offset: 200, length: 50, tokens: 10, heading: "Old A" } },
      { id: "scc_b", chunk: { offset: 100, length: 50, tokens: 10, heading: "Old B" } },
    ]);

    const a = await db
      .select()
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.id, "scc_a"));
    const b = await db
      .select()
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.id, "scc_b"));

    expect(a[0].offset).toBe(200);
    expect(b[0].offset).toBe(100);
  });

  it("is a no-op for an empty list", async () => {
    const db = mkDb();
    await seed(db);
    await applyChunkOffsetUpdates(asD1(db), []);
    const rows = await db.select().from(sourceChangelogChunks);
    expect(rows).toHaveLength(3);
  });
});

describe("applyOnDiff", () => {
  it("reconciles a delete + insert at the same offset in a single batch — new row lands with vectorId=null", async () => {
    // The middle chunk's content changes entirely: scc_b at offset 200 is
    // removed and a new chunk takes the same slot. UNIQUE(file, offset)
    // would reject the insert if the delete had not yet been applied.
    // Folding both into one batch guarantees the delete is committed
    // alongside the insert (or neither is).
    //
    // Per #620, the new row lands with vectorId=null — the follow-up
    // setChunkVectorIds runs only after Vectorize confirms.
    const db = mkDb();
    await seed(db);

    await applyOnDiff(asD1(db), {
      fileId: "scf_a",
      sourceId: "src_a",
      diff: {
        toDelete: [{ id: "scc_b", vectorId: "vec-old-b" }],
        unchanged: [
          {
            id: "scc_a",
            chunk: {
              offset: 100,
              length: 50,
              tokens: 10,
              text: "",
              contentHash: "h-a",
              heading: "Old A",
            },
          },
          {
            id: "scc_c",
            chunk: {
              offset: 300,
              length: 50,
              tokens: 10,
              text: "",
              contentHash: "h-c",
              heading: "Old C",
            },
          },
        ],
        toInsert: [
          {
            offset: 200,
            length: 60,
            tokens: 12,
            text: "",
            contentHash: "h-new-b",
            heading: "New B",
          },
        ],
      },
    });

    const rows = await db
      .select()
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.sourceChangelogFileId, "scf_a"))
      .orderBy(sourceChangelogChunks.offset);

    expect(rows.map((r) => [r.id, r.offset, r.contentHash, r.heading])).toEqual([
      ["scc_a", 100, "h-a", "Old A"],
      [expect.not.stringMatching(/^scc_b$/), 200, "h-new-b", "New B"],
      ["scc_c", 300, "h-c", "Old C"],
    ]);
    const newRow = rows.find((r) => r.offset === 200);
    expect(newRow?.vectorId).toBeNull();
    expect(newRow?.embeddedAt).toBeNull();
  });

  it("inserts new chunks with vectorId=null so the backfill job can pick them up", async () => {
    const db = mkDb();
    await seed(db);

    await applyOnDiff(asD1(db), {
      fileId: "scf_a",
      sourceId: "src_a",
      diff: {
        toDelete: [],
        unchanged: [],
        toInsert: [
          {
            offset: 400,
            length: 50,
            tokens: 10,
            text: "",
            contentHash: "h-d",
            heading: "New D",
          },
        ],
      },
    });

    const rows = await db
      .select()
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.contentHash, "h-d"));
    expect(rows).toHaveLength(1);
    expect(rows[0].vectorId).toBeNull();
    expect(rows[0].embeddedAt).toBeNull();
  });

  it("is a no-op when the diff is empty", async () => {
    const db = mkDb();
    await seed(db);
    await applyOnDiff(asD1(db), {
      fileId: "scf_a",
      sourceId: "src_a",
      diff: { toDelete: [], unchanged: [], toInsert: [] },
    });
    const rows = await db.select().from(sourceChangelogChunks);
    expect(rows).toHaveLength(3);
  });
});

describe("setChunkVectorIds", () => {
  it("promotes staged chunks (vectorId=null) once Vectorize confirms", async () => {
    const db = mkDb();
    await seed(db);

    // Stage a new chunk at offset 400 via applyOnDiff (vectorId=null).
    await applyOnDiff(asD1(db), {
      fileId: "scf_a",
      sourceId: "src_a",
      diff: {
        toDelete: [],
        unchanged: [],
        toInsert: [
          {
            offset: 400,
            length: 50,
            tokens: 10,
            text: "",
            contentHash: "h-d",
            heading: "New D",
          },
        ],
      },
    });

    const before = await db
      .select()
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.contentHash, "h-d"));
    expect(before[0].vectorId).toBeNull();

    // Now simulate Vectorize confirming and promote the chunk.
    await setChunkVectorIds(asD1(db), {
      fileId: "scf_a",
      now: "2026-05-01T00:00:00.000Z",
      embedded: [
        {
          chunk: {
            offset: 400,
            length: 50,
            tokens: 10,
            text: "",
            contentHash: "h-d",
            heading: "New D",
          },
          vectorId: "vec-d",
          vector: [0.1],
        },
      ],
    });

    const after = await db
      .select()
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.contentHash, "h-d"));
    expect(after[0].vectorId).toBe("vec-d");
    expect(after[0].embeddedAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("is a no-op for an empty embedded list", async () => {
    const db = mkDb();
    await seed(db);
    await setChunkVectorIds(asD1(db), {
      fileId: "scf_a",
      now: "2026-05-01T00:00:00.000Z",
      embedded: [],
    });
    const rows = await db.select().from(sourceChangelogChunks);
    expect(rows.every((r) => r.vectorId === null)).toBe(true);
  });

  it("only updates rows for the given file id, not collisions on contentHash alone", async () => {
    // Two files contain a chunk with the same contentHash — promoting
    // one must not update the other.
    const db = mkDb();
    await seed(db);
    await db.insert(sourceChangelogFiles).values({
      id: "scf_b",
      sourceId: "src_a",
      path: "CHANGELOG.md",
      filename: "CHANGELOG.md",
      url: "https://github.com/acme/acme/blob/main/CHANGELOG.md",
      rawUrl: "https://raw.githubusercontent.com/acme/acme/main/CHANGELOG.md",
      content: "stub",
      contentHash: "hash-file-b",
      bytes: 4,
      fetchedAt: new Date().toISOString(),
    });
    // Both files have a chunk with contentHash "h-shared".
    await db.insert(sourceChangelogChunks).values([
      {
        id: "scc_a_shared",
        sourceChangelogFileId: "scf_a",
        sourceId: "src_a",
        offset: 500,
        length: 50,
        tokens: 10,
        contentHash: "h-shared",
        heading: "Shared",
      },
      {
        id: "scc_b_shared",
        sourceChangelogFileId: "scf_b",
        sourceId: "src_a",
        offset: 500,
        length: 50,
        tokens: 10,
        contentHash: "h-shared",
        heading: "Shared",
      },
    ]);

    await setChunkVectorIds(asD1(db), {
      fileId: "scf_a",
      now: "2026-05-01T00:00:00.000Z",
      embedded: [
        {
          chunk: {
            offset: 500,
            length: 50,
            tokens: 10,
            text: "",
            contentHash: "h-shared",
            heading: "Shared",
          },
          vectorId: "vec-shared-a",
          vector: [0.1],
        },
      ],
    });

    const a = await db
      .select()
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.id, "scc_a_shared"));
    const b = await db
      .select()
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.id, "scc_b_shared"));
    expect(a[0].vectorId).toBe("vec-shared-a");
    expect(b[0].vectorId).toBeNull();
  });
});
