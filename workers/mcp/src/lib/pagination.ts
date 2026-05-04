import { computePagination } from "@buildinternet/releases-core/cli-contracts";
import { fromBase64Url, toBase64Url } from "@buildinternet/releases-core/cursor";
import type { SearchMode } from "@buildinternet/releases-core/schema";

export interface McpPaginationInput {
  page?: number;
  limit?: number;
}

export interface McpPagination {
  page: number;
  pageSize: number;
  offset: number;
}

// Mirrors `Pagination` from `@buildinternet/releases-core/cli-contracts` with
// `totalItems` / `totalPages` required (we always pass a backend total in) and
// adds `nextPage` so clients don't recompute `page + 1`. The `kind` field
// pairs with `McpCursorPaginationMeta` for clean discriminated-union narrowing.
export interface McpPaginationMeta {
  kind: "page";
  page: number;
  pageSize: number;
  returned: number;
  totalItems: number;
  totalPages: number;
  hasMore: boolean;
  nextPage?: number;
}

export type ListNoun = "sources" | "organizations" | "products" | "catalog entries";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parseMcpPagination(
  input: McpPaginationInput,
  opts: { defaultPageSize?: number; maxPageSize?: number } = {},
): McpPagination {
  const maxPageSize = opts.maxPageSize ?? MAX_LIMIT;
  const defaultPageSize = Math.min(opts.defaultPageSize ?? DEFAULT_LIMIT, maxPageSize);

  const rawLimit = input.limit;
  const pageSize =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), maxPageSize)
      : defaultPageSize;

  const rawPage = input.page;
  const page =
    typeof rawPage === "number" && Number.isFinite(rawPage) && rawPage > 0
      ? Math.floor(rawPage)
      : 1;

  return { page, pageSize, offset: (page - 1) * pageSize };
}

// Returns the markdown footer line(s) when the caller might want to keep
// paging — multi-page results, or any case where they've asked for a page past
// the only page (so they get context, not a bare "no entries"). Single-page
// results on page 1 omit the footer so the terse case stays terse.
//
// The continuation hint echoes the caller's `limit` whenever it differs from
// the default so a follow-up `page: N+1` call doesn't silently revert to 50
// and shift the slice underfoot.
export function renderPageFooter(opts: {
  pagination: McpPagination;
  returned: number;
  totalItems: number;
  noun: ListNoun;
}): string | null {
  const { pagination, returned, totalItems, noun } = opts;
  const meta = computePagination({
    page: pagination.page,
    pageSize: pagination.pageSize,
    returned,
    totalItems,
  });
  const totalPages = meta.totalPages ?? 1;
  if (totalPages <= 1 && pagination.page <= 1) return null;
  const nextHint = meta.hasMore
    ? `\nPass \`page: ${pagination.page + 1}, limit: ${pagination.pageSize}\` to continue.`
    : "";
  return `Page ${pagination.page} of ${totalPages} · Showing ${returned} of ${totalItems} ${noun}.${nextHint}`;
}

export function slicePage<T>(items: T[], pagination: McpPagination): T[] {
  return items.slice(pagination.offset, pagination.offset + pagination.pageSize);
}

// Build the `_meta.pagination` payload for a list_* tool result. Always
// populates `totalPages` (caller passes a real total) and adds `nextPage`
// only when more pages exist, so clients can branch on `nextPage != null`.
export function buildPaginationMeta(opts: {
  pagination: McpPagination;
  returned: number;
  totalItems: number;
}): McpPaginationMeta {
  const computed = computePagination({
    page: opts.pagination.page,
    pageSize: opts.pagination.pageSize,
    returned: opts.returned,
    totalItems: opts.totalItems,
  });
  const meta: McpPaginationMeta = {
    kind: "page",
    page: computed.page,
    pageSize: computed.pageSize,
    returned: computed.returned,
    totalItems: opts.totalItems,
    totalPages: computed.totalPages ?? 1,
    hasMore: computed.hasMore,
  };
  if (computed.hasMore) meta.nextPage = computed.page + 1;
  return meta;
}

// ── Cursor-based pagination (feed-shaped surfaces) ────────────────────
//
// Append-only feeds (`get_latest_releases`) can't use page numbers — a new
// release between page 1 and page 2 shifts the slice. Encode the last row's
// (publishedAt, id) into an opaque token so continuation is stable.

const DEFAULT_FEED_LIMIT = 50;
const MAX_FEED_LIMIT = 200;

export interface ReleaseCursorValue {
  lastPublishedAt: string | null;
  lastId: string;
}

export function encodeReleaseCursor(v: ReleaseCursorValue): string {
  return toBase64Url(`${v.lastPublishedAt ?? ""}|${v.lastId}`);
}

export function decodeReleaseCursor(token: string): ReleaseCursorValue | null {
  if (!token) return null;
  const raw = fromBase64Url(token);
  if (!raw) return null;
  const sep = raw.indexOf("|");
  // Reject when there's no separator or the id half is empty.
  if (sep < 0 || sep === raw.length - 1) return null;
  const left = raw.slice(0, sep);
  return { lastPublishedAt: left || null, lastId: raw.slice(sep + 1) };
}

export function parseFeedLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_FEED_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_FEED_LIMIT);
}

export interface McpCursorPaginationMeta {
  kind: "cursor";
  returned: number;
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
}

export function buildCursorMeta(opts: {
  returned: number;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}): McpCursorPaginationMeta {
  const meta: McpCursorPaginationMeta = {
    kind: "cursor",
    returned: opts.returned,
    limit: opts.limit,
    hasMore: opts.hasMore,
  };
  if (opts.hasMore && opts.nextCursor) meta.nextCursor = opts.nextCursor;
  return meta;
}

// ── Search meta (ranking-bounded surfaces) ────────────────────────────
//
// Search isn't paginated — results are top-ranked, and "page 2" of a ranked
// query isn't a coherent thing without re-ranking. The honest signal a client
// wants is "did we cap your results, and how were they distributed?"

export interface McpSearchHitCounts {
  orgHits?: number;
  catalogHits?: number;
  releaseHits?: number;
  chunkHits?: number;
}

export interface McpSearchMeta {
  mode: SearchMode;
  limit: number;
  returned: number;
  hitCap: boolean;
  hitCounts: McpSearchHitCounts;
  degraded: boolean;
}

export function buildSearchMeta(opts: {
  mode: SearchMode;
  limit: number;
  counts: McpSearchHitCounts;
  degraded?: boolean;
}): McpSearchMeta {
  const { mode, limit, counts } = opts;
  const sections = [counts.orgHits, counts.catalogHits, counts.releaseHits, counts.chunkHits];
  const hitCounts: McpSearchHitCounts = {};
  let returned = 0;
  let hitCap = false;
  for (const [i, n] of sections.entries()) {
    if (typeof n !== "number") continue;
    returned += n;
    if (limit > 0 && n >= limit) hitCap = true;
    const key = (["orgHits", "catalogHits", "releaseHits", "chunkHits"] as const)[i];
    hitCounts[key] = n;
  }
  const degraded = opts.degraded === true;
  // When semantic infra is unavailable the fallback path is lexical, so the
  // reported mode reflects what actually ran rather than what was requested.
  return { mode: degraded ? "lexical" : mode, limit, returned, hitCap, hitCounts, degraded };
}
