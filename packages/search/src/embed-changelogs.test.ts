import { test, expect } from "bun:test";
import {
  CHUNK_TOKEN_BUDGET,
  CHUNK_TOKEN_OVERLAP,
  buildVectorId,
  chunkChangelog,
  diffChunks,
  type Chunk,
  type ExistingChunkRow,
} from "./embed-changelogs.js";
import { countTokensSafe } from "@buildinternet/releases-core/tokens";

function buildLargeChangelog(): string {
  // ~10kb with 5 H2 sections. Each section is padded enough that its real
  // cl100k token count exceeds CHUNK_TOKEN_BUDGET on its own — forces
  // multi-chunk behavior under token-budget slicing.
  const sections: string[] = ["# Project Changelog", ""];
  for (let s = 1; s <= 5; s++) {
    sections.push(`## Section ${s}`);
    sections.push("");
    for (let i = 0; i < 40; i++) {
      sections.push(`- Item ${s}.${i} ${"word ".repeat(30)}`);
    }
    sections.push("");
  }
  return sections.join("\n");
}

test("chunkChangelog: small content returns a single chunk", () => {
  const content = "# Tiny\n\nJust a small file with one entry.";
  const chunks = chunkChangelog(content);
  expect(chunks.length).toBe(1);
  const [c] = chunks;
  expect(c.offset).toBe(0);
  expect(c.length).toBe(content.length);
  expect(c.text).toBe(content);
  expect(c.tokens).toBeGreaterThan(0);
  expect(c.tokens).toBe(countTokensSafe(content));
  expect(c.contentHash).toMatch(/^[0-9a-f]{16}$/);
});

test("chunkChangelog: empty content returns no chunks", () => {
  expect(chunkChangelog("")).toEqual([]);
});

test("chunkChangelog: large content yields multiple chunks that cover the input", () => {
  const content = buildLargeChangelog();
  const chunks = chunkChangelog(content);

  expect(chunks.length).toBeGreaterThan(1);

  // Each chunk's authoritative token count should be in the same magnitude
  // as the budget. Sections overshoot the budget by design (heading-aware
  // slicer always makes progress), so allow headroom above CHUNK_TOKEN_BUDGET.
  for (const c of chunks) {
    expect(c.tokens).toBe(countTokensSafe(c.text));
    expect(c.tokens).toBeGreaterThan(0);
    expect(c.tokens).toBeLessThan(CHUNK_TOKEN_BUDGET * 5);
  }

  // First chunk starts at 0, last chunk reaches end of file.
  expect(chunks[0].offset).toBe(0);
  const last = chunks[chunks.length - 1];
  expect(last.offset + last.length).toBe(content.length);

  // Union of all chunks reconstructs every character (with possible overlap).
  // Walk through chunks and confirm the running max-end advances and there
  // are no gaps: each chunk's offset <= previous chunk's end.
  let maxEnd = 0;
  for (const c of chunks) {
    expect(c.offset).toBeLessThanOrEqual(maxEnd);
    const end = c.offset + c.length;
    expect(end).toBeGreaterThanOrEqual(maxEnd);
    expect(c.text).toBe(content.slice(c.offset, end));
    maxEnd = Math.max(maxEnd, end);
  }
  expect(maxEnd).toBe(content.length);
});

test("chunkChangelog: consecutive chunks overlap by ~tokens×4 chars", () => {
  const content = buildLargeChangelog();
  const chunks = chunkChangelog(content);

  // Overlap is implemented as a physical back-step of CHUNK_TOKEN_OVERLAP×4
  // chars, bounded above by the previous chunk's range. Allow ±50 char
  // tolerance because the back-step is clamped to prevStart+1 on tight
  // chunks and because not every chunk boundary triggers overlap.
  const expectedOverlap = CHUNK_TOKEN_OVERLAP * 4;
  const tolerance = 50;
  let sawOverlap = false;
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const curr = chunks[i];
    const prevEnd = prev.offset + prev.length;
    const overlap = prevEnd - curr.offset;
    expect(overlap).toBeGreaterThanOrEqual(0);
    if (overlap > 0) {
      sawOverlap = true;
      // When overlap does happen, it should be near the expected step.
      expect(overlap).toBeLessThanOrEqual(expectedOverlap + tolerance);
    }
  }
  expect(sawOverlap).toBe(true);

  // Sanity: overlap budget constant is the documented value.
  expect(CHUNK_TOKEN_OVERLAP).toBe(50);
  expect(CHUNK_TOKEN_BUDGET).toBe(500);
});

test("chunkChangelog: heading extraction reflects the most recent heading", () => {
  const parts: string[] = [];
  parts.push("# Top");
  parts.push("");
  parts.push("Preamble paragraph.");
  parts.push("");
  // Pad section A so it exceeds the budget and forces a new chunk.
  parts.push("## Section A");
  parts.push("");
  for (let i = 0; i < 30; i++) {
    parts.push(`- A entry ${i} ${"y".repeat(60)}`);
  }
  parts.push("");
  parts.push("## Section B");
  parts.push("");
  for (let i = 0; i < 30; i++) {
    parts.push(`- B entry ${i} ${"z".repeat(60)}`);
  }
  const content = parts.join("\n");

  const chunks = chunkChangelog(content);
  expect(chunks.length).toBeGreaterThan(1);

  // First chunk starts at 0 and the most recent heading at offset 0 is "Top".
  expect(chunks[0].heading).toBe("Top");

  // Some later chunk should land inside Section A or Section B.
  const headings = chunks.map((c) => c.heading);
  expect(headings.some((h) => h === "Section A" || h === "Section B")).toBe(true);
});

// Lone surrogate detector: matches a high surrogate not followed by a low
// surrogate, OR a low surrogate not preceded by a high surrogate. Either
// indicates a UTF-16 code unit that JSON.stringify will serialize as
// `\uDxxx` — syntactically valid JSON but invalid UTF-8 when decoded by a
// downstream embedding API (e.g. Voyage rejects with HTTP 400). See #626.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

test("chunkChangelog: emoji at chunk boundary does not produce lone surrogates (regression: #626)", () => {
  // Emoji-heavy synthetic CHANGELOG. Every list item carries a run of 🐛
  // (a non-BMP codepoint encoded as a UTF-16 surrogate pair) and the
  // padding length cycles by `i % 7` so the chunker's char-indexed
  // back-step lands on a different relative position per item. With this
  // shape, the heading-snapped chunk start minus 200 chars reliably falls
  // on a low surrogate. Pre-fix, four of six chunks begin with a lone
  // low surrogate (`\uDC1B`); post-fix, every chunk must be valid UTF-16.
  const sections: string[] = ["# Project Changelog", ""];
  for (let s = 1; s <= 5; s++) {
    sections.push(`## Section ${s}`);
    sections.push("");
    for (let i = 0; i < 40; i++) {
      const pad = "🐛".repeat(20 + (i % 7));
      sections.push(`- ${pad} entry ${s}.${i}`);
    }
    sections.push("");
  }
  const content = sections.join("\n");
  const chunks = chunkChangelog(content);
  expect(chunks.length).toBeGreaterThan(1);

  const offenders: Array<{ offset: number; matches: number }> = [];
  for (const chunk of chunks) {
    LONE_SURROGATE.lastIndex = 0;
    const matches = chunk.text.match(LONE_SURROGATE);
    if (matches !== null) {
      offenders.push({ offset: chunk.offset, matches: matches.length });
    }
  }
  expect(offenders).toEqual([]);

  // JSON.stringify round-trip must preserve every chunk verbatim. A lone
  // surrogate survives JSON.stringify (as `\uDxxx`) and JSON.parse, so
  // this is not the same assertion as the surrogate-pair check above —
  // it pins the wire-level invariant that the embedding call relies on.
  for (const chunk of chunks) {
    const roundTripped = JSON.parse(JSON.stringify(chunk.text)) as string;
    expect(roundTripped).toBe(chunk.text);
  }
});

test("chunkChangelog: emoji-heavy content keeps content hashes stable across runs", () => {
  // Codepoint-safe boundary snapping must be deterministic — the same
  // input has to produce the same chunk hashes every run, otherwise the
  // diffChunks fast-path treats every re-fetch as a churn event.
  const sections: string[] = ["# Project Changelog", ""];
  for (let s = 1; s <= 4; s++) {
    sections.push(`## Section ${s}`);
    sections.push("");
    for (let i = 0; i < 30; i++) {
      sections.push(`- 🐛 Item ${s}.${i} ${"🚀 word ".repeat(12)}`);
    }
    sections.push("");
  }
  const content = sections.join("\n");
  const a = chunkChangelog(content);
  const b = chunkChangelog(content);
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i].contentHash).toBe(b[i].contentHash);
    expect(a[i].offset).toBe(b[i].offset);
    expect(a[i].length).toBe(b[i].length);
  }
});

test("chunkChangelog: hash is deterministic across runs", () => {
  const content = buildLargeChangelog();
  const a = chunkChangelog(content);
  const b = chunkChangelog(content);
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i].contentHash).toBe(b[i].contentHash);
    expect(a[i].offset).toBe(b[i].offset);
    expect(a[i].length).toBe(b[i].length);
  }
});

function asExisting(chunks: Chunk[]): ExistingChunkRow[] {
  return chunks.map((c, i) => ({
    id: `row_${i}`,
    offset: c.offset,
    contentHash: c.contentHash,
    vectorId: `vec_${i}`,
  }));
}

test("diffChunks: all unchanged when hashes match", () => {
  const next = chunkChangelog(buildLargeChangelog());
  const existing = asExisting(next);
  const result = diffChunks({ existing, next });
  expect(result.toInsert).toEqual([]);
  expect(result.toDelete).toEqual([]);
  expect(result.unchanged.length).toBe(next.length);
});

test("diffChunks: editing one chunk produces one insert + one delete", () => {
  const next = chunkChangelog(buildLargeChangelog());
  expect(next.length).toBeGreaterThan(2);
  const existing = asExisting(next);

  // Mutate one chunk's hash to simulate a content edit upstream.
  const editedIndex = 1;
  const tampered: Chunk[] = next.map((c, i) =>
    i === editedIndex ? { ...c, contentHash: "edited__" + c.contentHash.slice(8) } : c,
  );

  const result = diffChunks({ existing, next: tampered });
  expect(result.toInsert.length).toBe(1);
  expect(result.toInsert[0].contentHash).toBe(tampered[editedIndex].contentHash);
  expect(result.toDelete.length).toBe(1);
  expect(result.toDelete[0].id).toBe(`row_${editedIndex}`);
  expect(result.unchanged.length).toBe(next.length - 1);
});

test("diffChunks: removed chunks appear in toDelete", () => {
  const next = chunkChangelog(buildLargeChangelog());
  expect(next.length).toBeGreaterThan(2);
  const existing = asExisting(next);
  const trimmed = next.slice(0, next.length - 2);

  const result = diffChunks({ existing, next: trimmed });
  expect(result.toInsert).toEqual([]);
  expect(result.toDelete.length).toBe(2);
  expect(result.unchanged.length).toBe(trimmed.length);
});

test("diffChunks: new chunks appear in toInsert", () => {
  const next = chunkChangelog(buildLargeChangelog());
  const existing = asExisting(next);
  const extra: Chunk = {
    offset: 999_999,
    length: 10,
    text: "brand new content here",
    tokens: 6,
    contentHash: "brandnewhash0001",
    heading: null,
  };
  const augmented = [...next, extra];

  const result = diffChunks({ existing, next: augmented });
  expect(result.toInsert.length).toBe(1);
  expect(result.toInsert[0].contentHash).toBe("brandnewhash0001");
  expect(result.toDelete).toEqual([]);
  expect(result.unchanged.length).toBe(next.length);
});

test("diffChunks: hash-matched existing rows with vectorId=null go to toReembed", () => {
  const next = chunkChangelog(buildLargeChangelog());
  expect(next.length).toBeGreaterThan(2);

  // Same shape as asExisting but every row has vectorId=null — simulates
  // the #622 trap where prior crashes between D1 INSERT and Vectorize
  // upsert leave chunks indefinitely without a vectorId.
  const existing: ExistingChunkRow[] = next.map((c, i) => ({
    id: `row_${i}`,
    offset: c.offset,
    contentHash: c.contentHash,
    vectorId: null,
  }));

  const result = diffChunks({ existing, next });
  expect(result.toInsert).toEqual([]);
  expect(result.toDelete).toEqual([]);
  expect(result.unchanged).toEqual([]);
  expect(result.toReembed.length).toBe(next.length);
  for (let i = 0; i < next.length; i++) {
    expect(result.toReembed[i].id).toBe(`row_${i}`);
    expect(result.toReembed[i].chunk.contentHash).toBe(next[i].contentHash);
  }
});

test("diffChunks: mixed vectorId state splits between unchanged and toReembed", () => {
  const next = chunkChangelog(buildLargeChangelog());
  expect(next.length).toBeGreaterThan(3);

  // Half the existing rows have a vectorId, half don't — covers the
  // partial-recovery case where some chunks landed in Vectorize and some
  // didn't.
  const existing: ExistingChunkRow[] = next.map((c, i) => ({
    id: `row_${i}`,
    offset: c.offset,
    contentHash: c.contentHash,
    vectorId: i % 2 === 0 ? `vec_${i}` : null,
  }));

  const result = diffChunks({ existing, next });
  expect(result.toInsert).toEqual([]);
  expect(result.toDelete).toEqual([]);
  // Even-indexed rows have a vectorId → unchanged.
  expect(result.unchanged.length).toBe(Math.ceil(next.length / 2));
  // Odd-indexed rows are NULL → toReembed.
  expect(result.toReembed.length).toBe(Math.floor(next.length / 2));
  for (const u of result.unchanged) {
    const idx = Number(u.id.replace("row_", ""));
    expect(idx % 2).toBe(0);
  }
  for (const r of result.toReembed) {
    const idx = Number(r.id.replace("row_", ""));
    expect(idx % 2).toBe(1);
  }
});

test("diffChunks: duplicate contentHash with one NULL existing splits across toReembed and toInsert", () => {
  // One existing row at vectorId=null, two `next` chunks with the same
  // hash. Bucket consumption pairs the first chunk with the existing row
  // (toReembed) and the second falls through to toInsert. Pinned because
  // the post-fix `setChunkVectorIds` UPDATE keys on (file, hash) and may
  // intentionally hit both rows once they coexist in D1.
  const sharedHash = "deadbeef00000001";
  const dupChunk: Chunk = {
    offset: 0,
    length: 5,
    text: "hello",
    tokens: 1,
    contentHash: sharedHash,
    heading: null,
  };
  const next: Chunk[] = [dupChunk, { ...dupChunk, offset: 5 }];
  const existing: ExistingChunkRow[] = [
    { id: "row_a", offset: 0, contentHash: sharedHash, vectorId: null },
  ];

  const result = diffChunks({ existing, next });
  expect(result.toReembed.length).toBe(1);
  expect(result.toReembed[0].id).toBe("row_a");
  expect(result.toInsert.length).toBe(1);
  expect(result.toInsert[0].contentHash).toBe(sharedHash);
  expect(result.unchanged).toEqual([]);
  expect(result.toDelete).toEqual([]);
});

test("buildVectorId: deterministic and unique across files/hashes", () => {
  const a1 = buildVectorId("scf_aaa", "0123456789abcdef0123");
  const a2 = buildVectorId("scf_aaa", "0123456789abcdef0123");
  const b = buildVectorId("scf_bbb", "0123456789abcdef0123");
  const c = buildVectorId("scf_aaa", "ffffffffffffffff0000");

  expect(a1).toBe(a2);
  expect(a1).not.toBe(b);
  expect(a1).not.toBe(c);
  expect(a1).toBe("chunk_0123456789ab_scf_aaa");
});
