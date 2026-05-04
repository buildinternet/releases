// Page-based pagination for the MCP `list_*` tools. Renders a markdown footer
// instead of a JSON envelope so an LLM caller can see "there's more" without
// schema awareness. The `Pagination` shape from
// `@buildinternet/releases-core/cli-contracts` is the source of truth for
// totals + hasMore math.

import { computePagination } from "@buildinternet/releases-core/cli-contracts";

export interface McpPaginationInput {
  page?: number;
  limit?: number;
}

export interface McpPagination {
  page: number;
  pageSize: number;
  offset: number;
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
