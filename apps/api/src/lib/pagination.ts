import {
  DEFAULT_PAGE_SIZE,
  computePagination,
  type ListResponse,
} from "@buildinternet/releases-core/cli-contracts";
import { resolvePageWindow, type PageWindow } from "@releases/queries/pagination";

export type ListPaginationParams = PageWindow;

/**
 * Parse `?page` / `?limit` into a page window. The clamp math is shared with
 * the MCP `list_*` tools via `@releases/queries/pagination`.
 */
export function parseListPagination(
  params: URLSearchParams,
  opts: { defaultPageSize?: number; maxPageSize?: number } = {},
): ListPaginationParams {
  const limit = params.get("limit");
  const page = params.get("page");
  return resolvePageWindow(
    {
      limit: limit === null ? undefined : parseInt(limit, 10),
      page: page === null ? undefined : parseInt(page, 10),
    },
    {
      defaultPageSize: opts.defaultPageSize ?? DEFAULT_PAGE_SIZE,
      maxPageSize: opts.maxPageSize ?? DEFAULT_PAGE_SIZE,
    },
  );
}

export function buildListResponse<T>(
  items: T[],
  pagination: ListPaginationParams,
  totalItems?: number,
): ListResponse<T> {
  return {
    items,
    pagination: computePagination({
      page: pagination.page,
      pageSize: pagination.pageSize,
      returned: items.length,
      totalItems,
    }),
  };
}

export { slicePage } from "@releases/queries/pagination";

/**
 * Wrap a bare `?limit`-bounded result set in the canonical `ListResponse<T>`
 * envelope. For routes with no `?page` / count query — `hasMore` is the
 * limit-saturation heuristic, totals are omitted.
 */
export function buildBareLimitEnvelope<T>(items: T[], limit: number): ListResponse<T> {
  return {
    items,
    pagination: {
      page: 1,
      pageSize: limit,
      returned: items.length,
      hasMore: items.length >= limit,
    },
  };
}
