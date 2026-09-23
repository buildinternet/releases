import { parseFeedCursorKey, type FeedCursorKey } from "@releases/core-internal/feed-cursor";
import { computePagination } from "@buildinternet/releases-core/cli-contracts";
import { fromBase64Url } from "@buildinternet/releases-core/cursor";
import type { Kind } from "@buildinternet/releases-core/kinds";
import type { SearchMode } from "@buildinternet/releases-core/schema";
import { resolvePageWindow, type PageWindow } from "@releases/queries/pagination";

export interface McpPaginationInput {
  page?: number;
  limit?: number;
}

// Page window shape + clamp math are shared with the REST list routes
// (`@releases/queries/pagination`); this module keeps the MCP-only rendering
// (markdown footer, `_meta` payloads, cursor token, search meta).
export type McpPagination = PageWindow;

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

export type ListNoun = "sources" | "organizations" | "products" | "catalog entries" | "collections";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parseMcpPagination(
  input: McpPaginationInput,
  opts: { defaultPageSize?: number; maxPageSize?: number } = {},
): McpPagination {
  return resolvePageWindow(input, {
    defaultPageSize: opts.defaultPageSize ?? DEFAULT_LIMIT,
    maxPageSize: opts.maxPageSize ?? MAX_LIMIT,
  });
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

export { slicePage } from "@releases/queries/pagination";

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
// release between page 1 and page 2 shifts the slice. They page on the
// REST feeds' `publishedAt|fetchedAt|id` cursor (`buildFeedCursor` in
// `@releases/core-internal/feed-cursor`).

const DEFAULT_FEED_LIMIT = 50;
const MAX_FEED_LIMIT = 200;

/**
 * Read a `get_latest_releases` cursor. Accepts the shared feed-cursor format
 * and, for callers holding a token from before the switch, the old
 * base64url `publishedAt|id` token (read as the legacy 2-part cursor).
 * Unparseable input is null; the caller restarts at the head of the feed.
 */
export function decodeReleaseCursor(token: string): FeedCursorKey | null {
  if (!token) return null;
  if (!token.includes("|")) {
    const legacy = fromBase64Url(token);
    return legacy && legacy.includes("|") ? parseFeedCursorKey(legacy) : null;
  }
  return parseFeedCursorKey(token);
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
  collectionHits?: number;
}

export interface McpSearchMeta {
  mode: SearchMode;
  limit: number;
  returned: number;
  hitCap: boolean;
  hitCounts: McpSearchHitCounts;
  degraded: boolean;
  /**
   * Echo of the applied `kind` filter, when one was passed. Lets a caller
   * confirm the taxonomy filter took effect (release hits resolve through
   * `source.kind ?? product.kind`; catalog hits match the row's own kind).
   * Omitted entirely when no kind filter was applied.
   */
  kind?: Kind;
  /**
   * Echo of the applied `type` (section) filter — which of orgs / catalog /
   * releases / collections the caller asked for. Omitted when unset (all
   * sections searched).
   */
  type?: string[];
  /**
   * Echo of the resolved product identifier (`orgSlug/productSlug`) when a
   * `product` filter was applied and matched. Omitted when no product filter
   * was passed.
   */
  product?: string;
}

export function buildSearchMeta(opts: {
  mode: SearchMode;
  limit: number;
  counts: McpSearchHitCounts;
  degraded?: boolean;
  kind?: Kind;
  type?: string[];
  product?: string;
}): McpSearchMeta {
  const { mode, limit, counts } = opts;
  const sections = [
    counts.orgHits,
    counts.catalogHits,
    counts.releaseHits,
    counts.chunkHits,
    counts.collectionHits,
  ];
  const hitCounts: McpSearchHitCounts = {};
  let returned = 0;
  let hitCap = false;
  for (const [i, n] of sections.entries()) {
    if (typeof n !== "number") continue;
    returned += n;
    if (limit > 0 && n >= limit) hitCap = true;
    const key = (["orgHits", "catalogHits", "releaseHits", "chunkHits", "collectionHits"] as const)[
      i
    ];
    hitCounts[key] = n;
  }
  const degraded = opts.degraded === true;
  // When semantic infra is unavailable the fallback path is lexical, so the
  // reported mode reflects what actually ran rather than what was requested.
  const meta: McpSearchMeta = {
    mode: degraded ? "lexical" : mode,
    limit,
    returned,
    hitCap,
    hitCounts,
    degraded,
  };
  // Echo applied filters only when present, so the back-compat shape (and the
  // `toEqual` assertions in mcp-pagination-meta.test.ts) stay intact for the
  // unfiltered case.
  if (opts.kind) meta.kind = opts.kind;
  if (opts.type && opts.type.length > 0) meta.type = opts.type;
  if (opts.product) meta.product = opts.product;
  return meta;
}
