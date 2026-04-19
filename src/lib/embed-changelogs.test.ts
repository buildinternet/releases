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
import { countTokensSafe } from "@releases/core-internal/tokens";

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
  expect(headings.some((h) => h === "Section A" || h === "Section B")).toBe(
    true,
  );
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
