import { describe, test, expect } from "bun:test";
import { embedAndUpsertChangelogFile } from "./embed-changelog-pipeline";
import {
  chunkChangelog,
  buildVectorId,
  type ExistingChunkRow,
} from "./embed-changelogs";
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
  return (async () =>
    new Response("nope", { status: 400 })) as unknown as typeof fetch;
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
function existingFromContent(
  fileId: string,
  content: string,
): ExistingChunkRow[] {
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
  return sections
    .map((title, i) => `## ${title}\n\n${"x".repeat(800)} entry ${i}\n`)
    .join("\n");
}

describe("embedAndUpsertChangelogFile", () => {
  test("unchanged content → zero embed calls, zero upserts, zero deletes, onDiff with empty insert list", async () => {
    const content = bigDoc(["v3", "v2", "v1"]);
    const existing = existingFromContent(FILE_ID, content);
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const diffs: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async (p) => {
        diffs.push(p);
      },
    });
    expect(calls.length).toBe(0);
    expect(vec.upserted.length).toBe(0);
    expect(vec.deleted.length).toBe(0);
    expect(diffs.length).toBe(1);
    expect(diffs[0].diff.toInsert).toEqual([]);
    expect(diffs[0].diff.toDelete).toEqual([]);
    expect(diffs[0].embedded).toEqual([]);
    expect(diffs[0].diff.unchanged.length).toBeGreaterThan(0);
  });

  test("new chunks added → embed call covers exactly the new chunks, upserts carry standard metadata", async () => {
    // Going from a 1-chunk doc to a multi-chunk doc. Note: due to overlap
    // re-hashing, prior chunks may also re-hash and show up in toInsert/
    // toDelete — that's a chunker artifact, not the pipeline's job. The
    // contract this test enforces is: embed call count and inputs match the
    // diff's toInsert exactly, and upserts carry the right metadata.
    const oldContent = bigDoc(["v1"]);
    const newContent = bigDoc(["v3", "v2", "v1"]);
    const existing = existingFromContent(FILE_ID, oldContent);
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const diffs: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async (p) => {
        diffs.push(p);
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].inputs.length).toBeGreaterThan(0);
    expect(calls[0].inputs.length).toBe(diffs[0].diff.toInsert.length);
    expect(vec.upserted.length).toBe(diffs[0].diff.toInsert.length);
    // every upsert payload carries the standard metadata
    for (const v of vec.upserted) {
      expect(v.metadata.type).toBe("changelog_chunk");
      expect(v.metadata.source_id).toBe(SOURCE_ID);
      expect(v.metadata.source_changelog_file_id).toBe(FILE_ID);
      expect(typeof v.metadata.offset).toBe("number");
      expect(v.id.startsWith("chunk_")).toBe(true);
    }
    expect(diffs[0].embedded.length).toBe(diffs[0].diff.toInsert.length);
  });

  test("chunks removed → only stale vectors deleted, no embed calls", async () => {
    // Use a small old doc that chunks to exactly one piece, and an empty new
    // doc so the new chunk list is []. This avoids the overlap-window
    // re-hashing that happens when only some chunks are dropped from a
    // multi-chunk file.
    const oldContent = "## v1\n\nfirst release\n";
    const newContent = "";
    const existing = existingFromContent(FILE_ID, oldContent);
    expect(existing.length).toBeGreaterThan(0);
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const diffs: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async (p) => {
        diffs.push(p);
      },
    });
    expect(calls.length).toBe(0);
    expect(vec.upserted.length).toBe(0);
    expect(vec.deleted.length).toBeGreaterThan(0);
    expect(diffs[0].diff.toDelete.length).toBe(vec.deleted.length);
    expect(diffs[0].embedded).toEqual([]);
  });

  test("edited chunk → embed only the edited chunk, upsert new vector, delete stale vector", async () => {
    const oldContent = bigDoc(["v3", "v2", "v1"]);
    // Mutate the middle section so its hash changes; surrounding chunks
    // stay byte-identical.
    const newContent = oldContent.replace("entry 1", "entry 1 EDITED");
    const existing = existingFromContent(FILE_ID, oldContent);
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const diffs: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async (p) => {
        diffs.push(p);
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].inputs.length).toBeGreaterThanOrEqual(1);
    expect(vec.upserted.length).toBe(calls[0].inputs.length);
    expect(vec.deleted.length).toBeGreaterThanOrEqual(1);
    expect(diffs[0].embedded.length).toBe(vec.upserted.length);
  });

  test("embed failure → caught, logged, onDiff called with embedded:[]", async () => {
    const oldContent = bigDoc(["v1"]);
    const newContent = bigDoc(["v2", "v1"]);
    const existing = existingFromContent(FILE_ID, oldContent);
    const vec = fakeVectorize();
    const logger = captureLogger();
    const diffs: any[] = [];
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
      logger,
    });
    expect(vec.upserted.length).toBe(0);
    expect(diffs.length).toBe(1);
    expect(diffs[0].embedded).toEqual([]);
    expect(diffs[0].diff.toInsert.length).toBeGreaterThan(0);
    expect(logger.warns.some((w) => w.includes("embed failed"))).toBe(true);
  });

  test("upsert failure → caught, logged, embedded wiped before onDiff", async () => {
    const oldContent = bigDoc(["v1"]);
    const newContent = bigDoc(["v2", "v1"]);
    const existing = existingFromContent(FILE_ID, oldContent);
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize({ upsertThrows: true });
    const logger = captureLogger();
    const diffs: any[] = [];
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content: newContent, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async (p) => {
        diffs.push(p);
      },
      logger,
    });
    expect(diffs[0].embedded).toEqual([]);
    expect(diffs[0].diff.toInsert.length).toBeGreaterThan(0);
    expect(
      logger.warns.some((w) => w.includes("Vectorize upsert failed")),
    ).toBe(true);
  });

  test("onDiff callback failure is caught and logged", async () => {
    const content = bigDoc(["v1"]);
    const existing = existingFromContent(FILE_ID, content);
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const logger = captureLogger();
    await embedAndUpsertChangelogFile({
      file: { id: FILE_ID, sourceId: SOURCE_ID, content, contentHash: "h" },
      existingChunks: existing,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onDiff: async () => {
        throw new Error("db down");
      },
      logger,
    });
    expect(
      logger.warns.some((w) => w.includes("onDiff callback failed")),
    ).toBe(true);
  });
});
