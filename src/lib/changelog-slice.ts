/**
 * Heading-aware slicing for CHANGELOG files.
 *
 * Callers pass an offset/limit (character counts) and the slicer snaps the
 * returned slice to heading boundaries so sections are never cut mid-entry.
 * Used by the `/v1/sources/:slug/changelog` range API and agent-friendly
 * Context7-style slicing.
 *
 * Guarantees:
 *   - Concatenating successive slices (feeding `nextOffset` back as `offset`)
 *     reconstructs the original file exactly.
 *   - Slices start on a heading (or at offset 0 for the first slice, so the
 *     preamble is preserved).
 *   - Slices end at the *last* heading inside the requested range when
 *     possible; if a section is bigger than `limit`, the slice overshoots to
 *     the next heading so the section is returned whole.
 *   - If `limit` covers the remainder of the file, the remainder is returned
 *     in one slice and `nextOffset` is null.
 */

export interface ChangelogSliceOptions {
  offset?: number;
  limit?: number;
}

export interface ChangelogSliceResult {
  content: string;
  offset: number;
  limit: number;
  nextOffset: number | null;
  totalChars: number;
}

export const DEFAULT_CHANGELOG_SLICE_LIMIT = 40_000;
const MAX_SLICE_LIMIT = 500_000;

function isHeadingLine(text: string, lineStart: number, lineEnd: number): boolean {
  let i = lineStart;
  let hashes = 0;
  while (i < lineEnd && text[i] === "#" && hashes < 3) {
    hashes++;
    i++;
  }
  if (hashes === 0 || i >= lineEnd) return false;
  return text[i] === " " || text[i] === "\t";
}

/** Return the line-start offset of every `#`/`##`/`###` heading in `text`. */
function findHeadings(text: string): number[] {
  const positions: number[] = [];
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      if (isHeadingLine(text, lineStart, i)) positions.push(lineStart);
      lineStart = i + 1;
    }
  }
  return positions;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_CHANGELOG_SLICE_LIMIT;
  }
  if (limit > MAX_SLICE_LIMIT) return MAX_SLICE_LIMIT;
  return Math.floor(limit);
}

function clampOffset(offset: number | undefined, total: number): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) return 0;
  if (offset >= total) return total;
  return Math.floor(offset);
}

export function sliceChangelog(
  content: string,
  opts: ChangelogSliceOptions = {},
): ChangelogSliceResult {
  const totalChars = content.length;
  const offset = clampOffset(opts.offset, totalChars);
  const limit = clampLimit(opts.limit);
  const headings = findHeadings(content);

  // Snap start forward to the next heading (preserving offset=0 so the
  // first slice always contains any preamble before the first heading).
  let snappedStart: number;
  if (offset === 0) {
    snappedStart = 0;
  } else {
    const next = headings.find((p) => p >= offset);
    snappedStart = next !== undefined ? next : totalChars;
  }

  const requestedEnd = snappedStart + limit;
  let snappedEnd: number;
  if (requestedEnd >= totalChars) {
    snappedEnd = totalChars;
  } else {
    // Prefer the last heading inside (snappedStart, requestedEnd] — i.e. cut at
    // the most recent section boundary we can without going over budget.
    let lastInRange = -1;
    for (let i = headings.length - 1; i >= 0; i--) {
      const h = headings[i];
      if (h > snappedStart && h <= requestedEnd) {
        lastInRange = h;
        break;
      }
    }
    if (lastInRange !== -1) {
      snappedEnd = lastInRange;
    } else {
      // Section is bigger than the limit OR the file has no headings.
      // Prefer overshooting to the next heading so we return a complete section.
      const overshoot = headings.find((h) => h > requestedEnd);
      snappedEnd = overshoot !== undefined ? overshoot : requestedEnd;
    }
  }

  if (snappedEnd <= snappedStart) {
    snappedEnd = Math.min(totalChars, snappedStart + Math.max(limit, 1));
  }

  const slice = content.slice(snappedStart, snappedEnd);
  const nextOffset = snappedEnd < totalChars ? snappedEnd : null;

  return {
    content: slice,
    offset: snappedStart,
    limit,
    nextOffset,
    totalChars,
  };
}

/**
 * Whether a `/v1/sources/:slug/changelog` request is asking for a slice.
 * Callers that pass no range params get the full file (back-compat).
 */
export function hasRangeParams(params: { offset?: string | null; limit?: string | null }): boolean {
  return params.offset != null || params.limit != null;
}

export function parseRangeParam(raw: string | null | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}
