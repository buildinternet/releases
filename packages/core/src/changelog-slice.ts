/**
 * Heading-aware CHANGELOG slicer. Start/end always land on `##` headings
 * (offset=0 preserved for preamble); single oversized sections overshoot
 * rather than get cut mid-entry. Chaining `nextOffset` reconstructs the
 * full file exactly. Budget by chars (`limit`) or tokens (`tokens`,
 * cl100k_base) — `tokens` wins when both are passed.
 */

import { countTokens, countTokensSafe } from "./tokens";
import { DEFAULT_CHANGELOG_SLICE_LIMIT, parseRangeParam } from "./changelog-range";

export { DEFAULT_CHANGELOG_SLICE_LIMIT, parseRangeParam };

export interface ChangelogSliceOptions {
  offset?: number;
  limit?: number;
  tokens?: number;
}

export interface ChangelogSliceResult {
  content: string;
  offset: number;
  limit: number;
  /** Requested token budget, echoed when the caller used token mode. */
  tokens?: number;
  nextOffset: number | null;
  totalChars: number;
  /** Encoded token count of the returned `content`. Only set in token mode. */
  sliceTokens?: number;
}

const MAX_SLICE_LIMIT = 500_000;
export const DEFAULT_CHANGELOG_SLICE_TOKENS = 10_000;
const MAX_SLICE_TOKENS = 200_000;
/** Values surfaced in CLI/MCP descriptions so agents default to predictable slices. */
export const CHANGELOG_TOKEN_BRACKETS = [2_000, 5_000, 10_000, 20_000] as const;

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

function clampTokens(tokens: number | undefined): number | undefined {
  if (tokens === undefined) return undefined;
  if (!Number.isFinite(tokens) || tokens <= 0) return DEFAULT_CHANGELOG_SLICE_TOKENS;
  if (tokens > MAX_SLICE_TOKENS) return MAX_SLICE_TOKENS;
  return Math.floor(tokens);
}

/**
 * Walk forward heading-by-heading, encoding each section once and summing
 * as we go. BPE merges rarely cross `\n##` boundaries, so the running sum
 * is within ~1% of an exact re-encode — but O(M) total instead of the
 * O(N·M) you get from re-encoding cumulative prefixes. The caller does
 * one final exact `countTokens` on the chosen slice to populate
 * `sliceTokens`, so the response value is always exact.
 *
 * Overshoots to the first heading boundary when a single section exceeds
 * the budget, mirroring char-mode behavior so callers always make progress.
 */
function findTokenSliceEnd(
  content: string,
  snappedStart: number,
  budget: number,
  headings: number[],
  totalChars: number,
): number {
  const candidates: number[] = [];
  for (const h of headings) {
    if (h > snappedStart) candidates.push(h);
  }
  if (candidates.length === 0 || candidates[candidates.length - 1] !== totalChars) {
    candidates.push(totalChars);
  }

  let cursor = snappedStart;
  let runningTokens = 0;
  let lastFit = -1;
  for (const end of candidates) {
    const sectionTokens = countTokens(content.slice(cursor, end));
    const nextTotal = runningTokens + sectionTokens;
    if (nextTotal <= budget) {
      lastFit = end;
      runningTokens = nextTotal;
      cursor = end;
    } else {
      break;
    }
  }

  return lastFit !== -1 ? lastFit : candidates[0];
}

export function sliceChangelog(
  content: string,
  opts: ChangelogSliceOptions = {},
): ChangelogSliceResult {
  const totalChars = content.length;
  const offset = clampOffset(opts.offset, totalChars);
  const tokenBudget = clampTokens(opts.tokens);
  const limit = clampLimit(opts.limit);
  const headings = findHeadings(content);

  let snappedStart: number;
  if (offset === 0) {
    snappedStart = 0;
  } else {
    const next = headings.find((p) => p >= offset);
    snappedStart = next !== undefined ? next : totalChars;
  }

  let snappedEnd: number;

  if (tokenBudget !== undefined) {
    snappedEnd =
      snappedStart >= totalChars
        ? totalChars
        : findTokenSliceEnd(content, snappedStart, tokenBudget, headings, totalChars);
  } else {
    const requestedEnd = snappedStart + limit;
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
  }

  const slice = content.slice(snappedStart, snappedEnd);
  const nextOffset = snappedEnd < totalChars ? snappedEnd : null;

  const result: ChangelogSliceResult = {
    content: slice,
    offset: snappedStart,
    limit,
    nextOffset,
    totalChars,
  };
  if (tokenBudget !== undefined) {
    result.tokens = tokenBudget;
    result.sliceTokens = countTokens(slice);
  }
  return result;
}

export function hasRangeParams(params: {
  offset?: string | null;
  limit?: string | null;
  tokens?: string | null;
}): boolean {
  return params.offset != null || params.limit != null || params.tokens != null;
}

/**
 * Unify how CLI/MCP surfaces with numeric inputs produce the stringified
 * `{offset,limit,tokens}` shape `buildChangelogResponse` consumes.
 *
 * Rule: `tokens` takes precedence. Otherwise, fall back to the default
 * 40k-char slice when the caller passes an offset OR a limit without a
 * value — matches Context7 behavior where any range hint implies "don't
 * return the whole file".
 */
export function resolveChangelogRangeParams(input: {
  offset?: number;
  limit?: number;
  tokens?: number;
}): { offset: string | null; limit: string | null; tokens: string | null } {
  const inTokenMode = input.tokens !== undefined;
  const ranging = input.offset !== undefined || input.limit !== undefined || inTokenMode;
  return {
    offset: input.offset !== undefined ? String(input.offset) : null,
    limit: inTokenMode
      ? null
      : input.limit !== undefined
        ? String(input.limit)
        : ranging
          ? String(DEFAULT_CHANGELOG_SLICE_LIMIT)
          : null,
    tokens: inTokenMode ? String(input.tokens) : null,
  };
}

interface ChangelogFileRow {
  path: string;
  filename: string;
  url: string;
  rawUrl: string;
  content: string;
  bytes: number;
  /** Cached full-file token count. Null for rows written before the column existed. */
  tokens?: number | null;
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

/**
 * Pick the row a changelog read should serve. Callers guarantee `rows` is
 * non-empty. When `requestedPath` is set, returns the exact match or `null`
 * to signal "not found". Otherwise prefers the root CHANGELOG (no slash in
 * path) and falls back to the first row by caller-provided order.
 */
export function selectChangelogFile<T extends { path: string }>(
  rows: readonly T[],
  requestedPath: string | null | undefined,
): T | null {
  if (requestedPath) {
    return rows.find((r) => r.path === requestedPath) ?? null;
  }
  return rows.find((r) => !r.path.includes("/")) ?? rows[0];
}

export type ChangelogResponse = Omit<ChangelogFileRow, "tokens"> &
  ChangelogSliceResult & {
    truncated: boolean;
    truncatedAt: number | null;
    /** Full-file token count (cl100k_base). Always populated in responses. */
    totalTokens: number;
    files: ChangelogFileSummaryLite[];
  };

/**
 * Format the "what did I just get" status line shared by the CLI footer
 * and both MCP tool response headers. Shape varies with whether the
 * caller requested a token budget and whether more content follows.
 */
export function formatChangelogSliceLine(
  response: Pick<
    ChangelogResponse,
    "offset" | "content" | "totalChars" | "totalTokens" | "sliceTokens" | "nextOffset"
  >,
): string {
  const end = response.offset + response.content.length;
  const tail = response.nextOffset != null ? `next: offset=${response.nextOffset}` : "end of file";
  const charPart = `chars ${response.offset}–${end} of ${response.totalChars}`;
  const head =
    response.sliceTokens !== undefined
      ? `${response.sliceTokens} tokens (${charPart} / ${response.totalTokens} total tokens)`
      : `${charPart} (${response.totalTokens} total tokens)`;
  return `Slice: ${head} — ${tail}`;
}

/**
 * Build the `GET /v1/sources/:slug/changelog` response body from a DB row
 * and (optional) range params. Shared by the worker and local route handlers.
 * The `files` index is attached by callers after resolving the full set of
 * changelog files for a source.
 */
export function buildChangelogResponse(
  row: ChangelogFileRow,
  params: { offset?: string | null; limit?: string | null; tokens?: string | null },
  files: ChangelogFileSummaryLite[] = [],
): ChangelogResponse {
  const truncated = isTruncated(row.bytes);
  const truncatedAt = truncated ? row.bytes : null;
  const totalTokens = row.tokens ?? countTokensSafe(row.content);
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
      totalTokens,
      truncated,
      truncatedAt,
      files,
    };
  }
  const slice = sliceChangelog(row.content, {
    offset: parseRangeParam(params.offset),
    limit: parseRangeParam(params.limit),
    tokens: parseRangeParam(params.tokens),
  });
  return { ...base, ...slice, totalTokens, truncated, truncatedAt, files };
}
