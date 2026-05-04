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

// Returns the markdown footer line(s) when there's more than one page; null
// when the result fits in a single page so the terse case stays terse.
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
  if (totalPages <= 1) return null;
  const nextHint = meta.hasMore ? `\nPass \`page: ${pagination.page + 1}\` to continue.` : "";
  return `Page ${pagination.page} of ${totalPages} · Showing ${returned} of ${totalItems} ${noun}.${nextHint}`;
}

export function slicePage<T>(items: T[], pagination: McpPagination): T[] {
  return items.slice(pagination.offset, pagination.offset + pagination.pageSize);
}
