import { describe, test, expect } from "bun:test";
import { embedAndUpsertChangelogFile } from "./embed-changelog-pipeline";
import { chunkChangelog, buildVectorId, type ExistingChunkRow } from "./embed-changelogs";
import type { VectorizeIndex } from "./vector-search";

/**
 * Fake Voyage fetch — counts calls and returns deterministic vectors. Each
 * call's i-th input gets `[i+1]` as its embedding so we can tell vectors
 * apart.
 */
function fakeVoyageFetch() {
  const calls: Array<{ inputs: string[] }> = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ inputs: body.input });
    const data = body.input.map((_: string, i: number) => ({
      embedding: [i + 1],
      index: i,
    }));
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Fail every fetch with a 400 so embed throws after retries. */
function failingFetch(): typeof fetch {
  return (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
}

function fakeVectorize(opts: { upsertThrows?: boolean } = {}) {
  const upserted: any[] = [];
  const deleted: string[] = [];
  const index: VectorizeIndex = {
    async upsert(v: any[]) {
      if (opts.upsertThrows) throw new Error("vec down");
      upserted.push(...v);
      return { mutationId: "m1" };
    },
    async deleteByIds(ids: string[]) {
      deleted.push(...ids);
      return { mutationId: "m2" };
    },
    async query() {
      return { matches: [] } as any;
    },
  } as VectorizeIndex;
  return { index, upserted, deleted };
}

function captureLogger() {
  const warns: string[] = [];
  return {
    warn: (...args: unknown[]) => warns.push(args.map(String).join(" ")),
    error: (..._args: unknown[]) => {},
    warns,
  };
}

/**
 * Build ExistingChunkRow rows from current content as if it had been
 * previously embedded — every chunk gets a vectorId so deletes are realistic.
 */
function existingFromContent(fileId: string, content: string): ExistingChunkRow[] {
  return chunkChangelog(content).map((c, i) => ({
    id: `row_${i}`,
    offset: c.offset,
    contentHash: c.contentHash,
    vectorId: buildVectorId(fileId, c.contentHash),
  }));
}

const FILE_ID = "scf_1";
const SOURCE_ID = "src_1";

// Long enough to chunk into multiple pieces (CHUNK_CHAR_BUDGET is 2000).
function bigDoc(sections: string[]): string {
  return sections.map((title, i) => `## ${title}\n\n${"x".repeat(800)} entry ${i}\n`).join("\n");
}

describe("embedAndUpsertChangelogFile", () => {
  test("unchanged content → zero embed calls, zero upserts, zero deletes, onDiff with empty pending list, no commit callback", async () => {
    const content = bigDoc(["v3", "v2", "v1"]);
    const existing = existingFromContent(FILE_ID, content);
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const diffs: any[] = [];
    const commits: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async (p) => {
        diffs.push(p);
      },
      onVectorsCommitted: async (p) => {
        commits.push(p);
      },
    });
    expect(calls.length).toBe(0);
    expect(vec.upserted.length).toBe(0);
    expect(vec.deleted.length).toBe(0);
    expect(diffs.length).toBe(1);
    expect(diffs[0].diff.toInsert).toEqual([]);
    expect(diffs[0].diff.toDelete).toEqual([]);
    expect(diffs[0].pending).toEqual([]);
    expect(diffs[0].diff.unchanged.length).toBeGreaterThan(0);
    expect(commits.length).toBe(0);
  });

  test("new chunks added → onDiff fires before Vectorize upsert; onVectorsCommitted fires after", async () => {
    const oldContent = bigDoc(["v1"]);
    const newContent = bigDoc(["v3", "v2", "v1"]);
    const existing = existingFromContent(FILE_ID, oldContent);
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const events: string[] = [];
    let pending: any[] = [];
    let committed: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async (p) => {
        // At this point the upsert MUST NOT have happened yet — that's the
        // whole point of the D1-first ordering (#620).
        expect(vec.upserted.length).toBe(0);
        events.push("onDiff");
        pending = p.pending;
      },
      onVectorsCommitted: async (p) => {
        // Conversely, the upsert MUST have happened by now.
        expect(vec.upserted.length).toBeGreaterThan(0);
        events.push("onVectorsCommitted");
        committed = p.committed;
      },
    });
    expect(events).toEqual(["onDiff", "onVectorsCommitted"]);
    expect(calls.length).toBe(1);
    expect(pending.length).toBeGreaterThan(0);
    expect(committed.length).toBe(pending.length);
    // Standard metadata on each upsert payload.
    for (const v of vec.upserted) {
      expect(v.metadata.type).toBe("changelog_chunk");
      expect(v.metadata.source_id).toBe(SOURCE_ID);
      expect(v.metadata.source_changelog_file_id).toBe(FILE_ID);
      expect(v.id.startsWith("chunk_")).toBe(true);
    }
  });

  test("chunks removed → only stale vectors deleted, no embed calls, no commit", async () => {
    const oldContent = "## v1\n\nfirst release\n";
    const newContent = "";
    const existing = existingFromContent(FILE_ID, oldContent);
    expect(existing.length).toBeGreaterThan(0);
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const diffs: any[] = [];
    const commits: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async (p) => {
        diffs.push(p);
      },
      onVectorsCommitted: async (p) => {
        commits.push(p);
      },
    });
    expect(calls.length).toBe(0);
    expect(vec.upserted.length).toBe(0);
    expect(vec.deleted.length).toBeGreaterThan(0);
    expect(diffs[0].diff.toDelete.length).toBe(vec.deleted.length);
    expect(diffs[0].pending).toEqual([]);
    expect(commits.length).toBe(0);
  });

  test("edited chunk → embed only the edited chunk, upsert new vector, delete stale vector, commit fires", async () => {
    const oldContent = bigDoc(["v3", "v2", "v1"]);
    const newContent = oldContent.replace("entry 1", "entry 1 EDITED");
    const existing = existingFromContent(FILE_ID, oldContent);
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const diffs: any[] = [];
    const commits: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async (p) => {
        diffs.push(p);
      },
      onVectorsCommitted: async (p) => {
        commits.push(p);
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].inputs.length).toBeGreaterThanOrEqual(1);
    expect(vec.upserted.length).toBe(calls[0].inputs.length);
    expect(vec.deleted.length).toBeGreaterThanOrEqual(1);
    expect(diffs[0].pending.length).toBe(vec.upserted.length);
    expect(commits.length).toBe(1);
    expect(commits[0].committed.length).toBe(vec.upserted.length);
  });

  test("embed failure → caught, logged, onDiff called with pending:[], no commit", async () => {
    const oldContent = bigDoc(["v1"]);
    const newContent = bigDoc(["v2", "v1"]);
    const existing = existingFromContent(FILE_ID, oldContent);
    const vec = fakeVectorize();
    const logger = captureLogger();
    const diffs: any[] = [];
    const commits: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: {
        provider: "voyage",
        apiKey: "k",
        fetchImpl: failingFetch(),
        maxRetries: 0,
      },
      onDiff: async (p) => {
        diffs.push(p);
      },
      onVectorsCommitted: async (p) => {
        commits.push(p);
      },
      logger,
    });
    expect(vec.upserted.length).toBe(0);
    expect(diffs.length).toBe(1);
    expect(diffs[0].pending).toEqual([]);
    expect(diffs[0].diff.toInsert.length).toBeGreaterThan(0);
    expect(commits.length).toBe(0);
    expect(logger.warns.some((w) => w.includes("embed failed"))).toBe(true);
  });

  test("upsert failure → caught, logged, no commit (chunks left with vectorId=null in D1 for backfill)", async () => {
    const oldContent = bigDoc(["v1"]);
    const newContent = bigDoc(["v2", "v1"]);
    const existing = existingFromContent(FILE_ID, oldContent);
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize({ upsertThrows: true });
    const logger = captureLogger();
    const diffs: any[] = [];
    const commits: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async (p) => {
        diffs.push(p);
      },
      onVectorsCommitted: async (p) => {
        commits.push(p);
      },
      logger,
    });
    // onDiff still fires — the diff (delete + insert NULL) still needs to land.
    expect(diffs.length).toBe(1);
    expect(diffs[0].pending.length).toBeGreaterThan(0);
    // ...but commit does not, because the vectors never landed.
    expect(commits.length).toBe(0);
    expect(logger.warns.some((w) => w.includes("Vectorize upsert failed"))).toBe(true);
  });

  test("onDiff failure aborts the pipeline — Vectorize is NOT touched (#620)", async () => {
    // The whole point of the D1-first ordering: if D1 staging fails, we
    // must NOT proceed with Vectorize writes (which would create orphan
    // vectors with no D1 row pointing back at them).
    const oldContent = bigDoc(["v1"]);
    const newContent = bigDoc(["v2", "v1"]);
    const existing = existingFromContent(FILE_ID, oldContent);
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const logger = captureLogger();
    const commits: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async () => {
        throw new Error("db down");
      },
      onVectorsCommitted: async (p) => {
        commits.push(p);
      },
      logger,
    });
    expect(vec.upserted.length).toBe(0);
    expect(vec.deleted.length).toBe(0);
    expect(commits.length).toBe(0);
    expect(logger.warns.some((w) => w.includes("onDiff callback failed"))).toBe(true);
  });

  test("onVectorsCommitted failure is caught and logged", async () => {
    const oldContent = bigDoc(["v1"]);
    const newContent = bigDoc(["v2", "v1"]);
    const existing = existingFromContent(FILE_ID, oldContent);
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const logger = captureLogger();
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async () => {},
      onVectorsCommitted: async () => {
        throw new Error("db down");
      },
      logger,
    });
    // The Vectorize upsert still happened — failure was on the D1
    // follow-up. Backfill recovers because chunks stayed at vectorId=null.
    expect(vec.upserted.length).toBeGreaterThan(0);
    expect(logger.warns.some((w) => w.includes("onVectorsCommitted callback failed"))).toBe(true);
  });
});
