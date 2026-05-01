import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq, inArray } from "drizzle-orm";
import {
  releases,
  knowledgePages,
  sourceChangelogChunks,
} from "@buildinternet/releases-core/schema";
import { RELEASE_URL_UPSERT } from "@releases/core-internal/release-upsert";
import {
  D1_MAX_BINDINGS,
  RELEASES_BATCH_CHUNK_SIZE,
  RELEASES_ID_IN_CHUNK_SIZE,
  CHANGELOG_CHUNK_INSERT_CHUNK_SIZE,
} from "../../workers/api/src/lib/d1-limits.js";

// D1 rejects any prepared statement that binds more than D1_MAX_BINDINGS
// parameters. These tests use Drizzle's .toSQL() to count the placeholders
// the route would actually emit, so they stay accurate if the schema or
// Drizzle's SQL shape changes — the chunk constants in d1-limits.ts must
// be bumped down whenever a new column pushes the per-row bind count up.
//
// Background: a `D1_CHUNK_SIZE = 100` with 13 binds/row silently 500'd every
// non-trivial `/v1/sources/:slug/releases/batch` request — ~30 of 46 stale
// sources were getting their new rows dropped at the write path.

const db = drizzle(new Database(":memory:"));

const mockRow = (i: number) => ({
  sourceId: "src_x",
  version: `v${i}`,
  type: "feature" as const,
  title: `t${i}`,
  content: "c",
  url: `https://example.invalid/${i}`,
  contentHash: "h",
  publishedAt: "2026-01-01",
  media: "[]",
});

describe("releases batch insert bind budget", () => {
  it(`chunk of RELEASES_BATCH_CHUNK_SIZE stays under D1's ${D1_MAX_BINDINGS}-bind cap`, () => {
    const chunk = Array.from({ length: RELEASES_BATCH_CHUNK_SIZE }, (_, i) => mockRow(i));
    const q = db.insert(releases).values(chunk).onConflictDoUpdate(RELEASE_URL_UPSERT).toSQL();
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
  });

  it("chunk one larger than RELEASES_BATCH_CHUNK_SIZE exceeds the cap", () => {
    // Boundary guard: if this ever passes, the constant can be raised — or
    // Drizzle changed how it generates placeholders. Either way, revisit.
    const chunk = Array.from({ length: RELEASES_BATCH_CHUNK_SIZE + 1 }, (_, i) => mockRow(i));
    const q = db.insert(releases).values(chunk).onConflictDoUpdate(RELEASE_URL_UPSERT).toSQL();
    expect(q.params.length).toBeGreaterThan(D1_MAX_BINDINGS);
  });
});

describe("releases id-IN bind budget", () => {
  const ids = Array.from({ length: RELEASES_ID_IN_CHUNK_SIZE }, (_, i) => `rel_${i}`);

  it("SELECT ... WHERE id IN (chunk) stays under the cap", () => {
    const q = db.select().from(releases).where(inArray(releases.id, ids)).toSQL();
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
  });

  it("UPDATE ... SET embedded_at WHERE id IN (chunk) stays under the cap", () => {
    // +1 for the SET binding — this is the path that was silently 500ing
    // inside waitUntil when the chunk was 100.
    const q = db
      .update(releases)
      .set({ embeddedAt: "2026-01-01" })
      .where(inArray(releases.id, ids))
      .toSQL();
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
  });
});

const mockChunk = (i: number) => ({
  sourceChangelogFileId: "f1",
  sourceId: "s1",
  offset: i * 100,
  length: 100,
  tokens: 25,
  contentHash: `h${i}`,
  heading: null,
  vectorId: null,
  embeddedAt: null,
});

describe("source_changelog_chunks batch insert bind budget", () => {
  // The chunk INSERT binds 11 placeholders per row — Drizzle materializes
  // both `id` ($defaultFn newSourceChangelogChunkId) and `created_at`
  // ($defaultFn ISO timestamp) as bound values, on top of the nine
  // explicit columns. Pre-fix the constant was 11 (counting only the
  // explicit columns), so each chunked statement carried 121 binds and
  // D1 rejected it with "too many SQL variables" the moment a file
  // produced enough chunks to fill one batch — surfaced in prod for
  // 28 zero-chunk CHANGELOGs after #624's predicate fix unblocked them.
  it(`chunk of CHANGELOG_CHUNK_INSERT_CHUNK_SIZE stays under D1's ${D1_MAX_BINDINGS}-bind cap`, () => {
    const rows = Array.from({ length: CHANGELOG_CHUNK_INSERT_CHUNK_SIZE }, (_, i) => mockChunk(i));
    const q = db.insert(sourceChangelogChunks).values(rows).toSQL();
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
  });

  it("chunk one larger than CHANGELOG_CHUNK_INSERT_CHUNK_SIZE exceeds the cap", () => {
    const rows = Array.from({ length: CHANGELOG_CHUNK_INSERT_CHUNK_SIZE + 1 }, (_, i) =>
      mockChunk(i),
    );
    const q = db.insert(sourceChangelogChunks).values(rows).toSQL();
    expect(q.params.length).toBeGreaterThan(D1_MAX_BINDINGS);
  });
});

describe("knowledge_pages playbook id-IN bind budget", () => {
  // loadPlaybookNotesForSources runs SELECT ... WHERE scope='playbook' AND
  // orgId IN (chunk). The scope eq adds one extra bind on top of the IN.
  const ids = Array.from({ length: RELEASES_ID_IN_CHUNK_SIZE }, (_, i) => `org_${i}`);

  it("SELECT ... WHERE scope=? AND orgId IN (chunk) stays under the cap", () => {
    const q = db
      .select({ orgId: knowledgePages.orgId, notes: knowledgePages.notes })
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "playbook"), inArray(knowledgePages.orgId, ids)))
      .toSQL();
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
  });
});
