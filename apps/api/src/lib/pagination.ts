import {
  DEFAULT_PAGE_SIZE,
  computePagination,
  type ListResponse,
} from "@buildinternet/releases-core/cli-contracts";

export interface ListPaginationParams {
  page: number;
  pageSize: number;
  offset: number;
}

export function parseListPagination(
  params: URLSearchParams,
  opts: { defaultPageSize?: number; maxPageSize?: number } = {},
): ListPaginationParams {
  const maxPageSize = opts.maxPageSize ?? DEFAULT_PAGE_SIZE;
  const defaultPageSize = Math.min(opts.defaultPageSize ?? DEFAULT_PAGE_SIZE, maxPageSize);

  const rawLimit = parseInt(params.get("limit") ?? String(defaultPageSize), 10);
  const pageSize =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxPageSize) : defaultPageSize;

  const rawPage = parseInt(params.get("page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
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

export function slicePage<T>(items: T[], pagination: ListPaginationParams): T[] {
  return items.slice(pagination.offset, pagination.offset + pagination.pageSize);
}

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
