/**
 * Heading-aware slicing for CHANGELOG files. Slices start on a heading
 * (offset=0 preserved for preamble) and end at the last heading inside
 * the requested range, overshooting to the next heading only when a
 * single section is bigger than `limit`. Successive slices via
 * `nextOffset` reconstruct the file exactly.
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

export function hasRangeParams(params: { offset?: string | null; limit?: string | null }): boolean {
  return params.offset != null || params.limit != null;
}

export function parseRangeParam(raw: string | null | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

interface ChangelogFileRow {
  path: string;
  filename: string;
  url: string;
  rawUrl: string;
  content: string;
  bytes: number;
  fetchedAt: string;
}

interface ChangelogFileSummaryLite {
  path: string;
  filename: string;
  url: string;
  bytes: number;
  fetchedAt: string;
}

/** 1MB — mirrors CHANGELOG_MAX_BYTES in src/adapters/github.ts. */
const CHANGELOG_MAX_BYTES = 1024 * 1024;

/**
 * Derive the `truncated` signal from the stored `bytes` column. A file
 * whose byte length is exactly CHANGELOG_MAX_BYTES was almost certainly
 * truncated by the fetcher — natural files are vanishingly unlikely to
 * land on that exact boundary. Keeps us out of migration territory.
 */
export function isTruncated(bytes: number): boolean {
  return bytes >= CHANGELOG_MAX_BYTES;
}

export interface ChangelogResponse extends ChangelogFileRow, ChangelogSliceResult {
  truncated: boolean;
  truncatedAt: number | null;
  files: ChangelogFileSummaryLite[];
}

/**
 * Build the `GET /v1/sources/:slug/changelog` response body from a DB row
 * and (optional) range params. Shared by the worker and local route handlers.
 * The `files` index is attached by callers after resolving the full set of
 * changelog files for a source.
 */
export function buildChangelogResponse(
  row: ChangelogFileRow,
  params: { offset?: string | null; limit?: string | null },
  files: ChangelogFileSummaryLite[] = [],
): ChangelogResponse {
  const truncated = isTruncated(row.bytes);
  const truncatedAt = truncated ? row.bytes : null;
  const base = {
    path: row.path,
    filename: row.filename,
    url: row.url,
    rawUrl: row.rawUrl,
    bytes: row.bytes,
    fetchedAt: row.fetchedAt,
  };
  if (!hasRangeParams(params)) {
    const totalChars = row.content.length;
    return {
      ...base,
      content: row.content,
      offset: 0,
      limit: totalChars,
      nextOffset: null,
      totalChars,
      truncated,
      truncatedAt,
      files,
    };
  }
  const slice = sliceChangelog(row.content, {
    offset: parseRangeParam(params.offset),
    limit: parseRangeParam(params.limit),
  });
  return { ...base, ...slice, truncated, truncatedAt, files };
}
