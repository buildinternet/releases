/**
 * Chunking + diffing for CHANGELOG files ahead of embedding.
 *
 * Reuses sliceChangelog from ./changelog-slice for heading-aware boundaries.
 * Pure functions only; no DB or network I/O.
 *
 * Token counting uses js-tiktoken's cl100k_base (via countTokensSafe) so the
 * `tokens` value on each Chunk matches the authoritative count stored on
 * source_changelog_files.tokens upstream.
 */

import { createHash } from "node:crypto";
import { sliceChangelog } from "@releases/core-internal/changelog-slice";
import { countTokensSafe } from "@releases/core-internal/tokens";

/**
 * Token budget per chunk. Fits well under embedding model context windows
 * and leaves retrievers room to return several chunks per query.
 */
export const CHUNK_TOKEN_BUDGET = 500;

/**
 * Token overlap between consecutive chunks. Enough to keep a sentence or
 * list item from being split across the boundary. Measured in tokens; the
 * chunker converts to a char back-step via the standard ~4 chars/token
 * approximation (see `chunkChangelog` for the rationale).
 */
export const CHUNK_TOKEN_OVERLAP = 50;

/**
 * Char back-step used to physically extend chunks backward for overlap.
 * Derived from CHUNK_TOKEN_OVERLAP × 4 (the standard cl100k approximation
 * for English prose). We use a char step rather than a true token step
 * because sliceChangelog's token mode snaps forward to headings — stepping
 * backward in tokens would require a second encode pass per chunk for no
 * retrieval-quality gain over this proportional estimate.
 */
const CHUNK_CHAR_OVERLAP_STEP = CHUNK_TOKEN_OVERLAP * 4;

export interface Chunk {
  offset: number;
  length: number;
  text: string;
  tokens: number;
  contentHash: string;
  heading: string | null;
}

/** Stable, short hash for chunk content. SHA-1 truncated to 16 hex chars. */
function hashChunk(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * Best-effort heading lookup: scan lines from the start of the file and
 * return the most recent `#`/`##`/`###` heading whose line begins at or
 * before `offset`. Returns just the heading text (no leading hashes) or
 * null if none qualify.
 */
function findHeadingBefore(content: string, offset: number): string | null {
  let lastHeading: string | null = null;
  let lineStart = 0;
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === "\n") {
      if (lineStart > offset) break;
      const line = content.slice(lineStart, i);
      const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
      if (m) lastHeading = m[2].trim();
      lineStart = i + 1;
    }
  }
  return lastHeading;
}

/**
 * Chunk a changelog into ~CHUNK_TOKEN_BUDGET-sized, heading-aware slices
 * with a CHUNK_TOKEN_OVERLAP token tail copied into the next chunk. Last
 * chunk has no overlap. Returns [] for empty input.
 *
 * Overlap approach: after sliceChangelog returns a heading-snapped start,
 * we physically extend the chunk backward by CHUNK_CHAR_OVERLAP_STEP chars
 * (a proportional estimate of CHUNK_TOKEN_OVERLAP tokens). We do NOT snap
 * this back-step to a heading because sliceChangelog would re-snap forward
 * and erase the overlap. The final `tokens` value is an exact cl100k count
 * of the physically-sliced text, so retrieval metadata is authoritative
 * even if the back-step is token-approximate.
 */
export function chunkChangelog(content: string): Chunk[] {
  if (!content || content.length === 0) return [];

  const chunks: Chunk[] = [];
  let cursor = 0;
  // Safety: cap iterations so a degenerate input cannot loop forever.
  const maxIterations = content.length + 16;
  let iterations = 0;

  while (cursor < content.length) {
    if (++iterations > maxIterations) break;

    const slice = sliceChangelog(content, {
      offset: cursor,
      tokens: CHUNK_TOKEN_BUDGET,
    });

    // sliceChangelog snaps `offset` forward to the next heading (preserving
    // 0). That gives us the heading-aligned end of the *previous* chunk and
    // the natural start of *this* one.
    let startOffset = slice.offset;
    const snappedEnd = slice.offset + slice.content.length;

    // Overlap: for chunks after the first, physically extend the start
    // backward by CHUNK_CHAR_OVERLAP_STEP chars so the prior chunk's tail
    // is duplicated here. We do not snap this back-step to a heading
    // because sliceChangelog would just re-snap forward and erase the
    // overlap. Clamp so we never pass the previous chunk's start
    // (otherwise we would re-emit content the previous chunk already
    // covered in full).
    if (chunks.length > 0) {
      const prev = chunks[chunks.length - 1];
      const prevStart = prev.offset;
      startOffset = Math.max(slice.offset - CHUNK_CHAR_OVERLAP_STEP, prevStart + 1);
    }

    const text = content.slice(startOffset, snappedEnd);

    if (text.length > 0) {
      chunks.push({
        offset: startOffset,
        length: text.length,
        text,
        tokens: countTokensSafe(text),
        contentHash: hashChunk(text),
        heading: findHeadingBefore(content, startOffset),
      });
    }

    if (slice.nextOffset == null) break;

    // Advance the cursor to the natural (heading-snapped) end so the next
    // iteration starts cleanly at a heading. Overlap is layered on by the
    // back-step above.
    if (slice.nextOffset <= cursor) break;
    cursor = slice.nextOffset;
  }

  return chunks;
}

export interface ExistingChunkRow {
  id: string;
  offset: number;
  contentHash: string;
  vectorId: string | null;
}

export interface DiffResult {
  toInsert: Chunk[];
  toDelete: Array<{ id: string; vectorId: string | null }>;
  unchanged: Array<{ id: string; chunk: Chunk }>;
}

/**
 * Diff a freshly-chunked file against existing DB rows. Match is by
 * contentHash only — content moving within the file (e.g. new entry
 * prepended) does NOT trigger re-embedding for sections that are
 * byte-for-byte identical.
 *
 * - toInsert: chunks in `next` whose hash is not in `existing`.
 * - toDelete: existing rows whose hash is not in `next`.
 * - unchanged: existing rows whose hash matches a chunk in `next`, paired
 *   with that chunk so callers can update offset/length without re-embedding.
 *
 * Each existing row is consumed at most once; if `next` contains duplicate
 * hashes the unmatched copies fall through to toInsert.
 */
export function diffChunks(args: { existing: ExistingChunkRow[]; next: Chunk[] }): DiffResult {
  const { existing, next } = args;

  const existingByHash = new Map<string, ExistingChunkRow[]>();
  for (const row of existing) {
    const bucket = existingByHash.get(row.contentHash);
    if (bucket) bucket.push(row);
    else existingByHash.set(row.contentHash, [row]);
  }

  const toInsert: Chunk[] = [];
  const unchanged: Array<{ id: string; chunk: Chunk }> = [];
  const consumed = new Set<string>();

  for (const chunk of next) {
    const bucket = existingByHash.get(chunk.contentHash);
    const match = bucket && bucket.length > 0 ? bucket.shift() : undefined;
    if (match) {
      consumed.add(match.id);
      unchanged.push({ id: match.id, chunk });
    } else {
      toInsert.push(chunk);
    }
  }

  const toDelete: Array<{ id: string; vectorId: string | null }> = [];
  for (const row of existing) {
    if (!consumed.has(row.id)) {
      toDelete.push({ id: row.id, vectorId: row.vectorId });
    }
  }

  return { toInsert, toDelete, unchanged };
}

/**
 * Build a stable, unique vector ID for a chunk. Format:
 *   chunk_<first12ofhash>_<file_id>
 *
 * - First 12 hex chars of the chunk's content hash → 48 bits of entropy,
 *   collision-resistant within a single file.
 * - File ID suffix scopes vectors to their source file so deletion is
 *   targeted and IDs from different files cannot collide even on
 *   improbable hash overlap.
 */
export function buildVectorId(sourceChangelogFileId: string, contentHash: string): string {
  return `chunk_${contentHash.slice(0, 12)}_${sourceChangelogFileId}`;
}
