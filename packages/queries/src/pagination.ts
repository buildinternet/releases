/**
 * Page-number pagination window shared by the REST list routes and the MCP
 * `list_*` tools. Each surface parses its own input (URL query strings vs.
 * typed tool arguments) and renders its own envelope; the clamp-and-offset
 * math lives here so the two can't drift.
 *
 * Cursor pagination is not here yet: the REST feeds use
 * `@releases/core-internal/feed-cursor` and MCP `get_latest_releases` still has
 * its own token format. See docs/architecture/shared-queries.md.
 */

export interface PageWindow {
  page: number;
  pageSize: number;
  offset: number;
}

export interface PageWindowOpts {
  defaultPageSize: number;
  maxPageSize: number;
}

function positiveInt(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Clamp a requested `{ page, limit }` into a page window. Missing, zero,
 * negative, or non-finite values fall back to page 1 / `defaultPageSize`;
 * `limit` is capped at `maxPageSize`, and `defaultPageSize` never exceeds it.
 */
export function resolvePageWindow(
  input: { page?: number; limit?: number },
  opts: PageWindowOpts,
): PageWindow {
  const defaultPageSize = Math.min(opts.defaultPageSize, opts.maxPageSize);
  const limit = positiveInt(input.limit);
  const pageSize = limit === null ? defaultPageSize : Math.min(limit, opts.maxPageSize);
  const page = positiveInt(input.page) ?? 1;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Slice an in-memory list to one page window. */
export function slicePage<T>(items: T[], window: Pick<PageWindow, "offset" | "pageSize">): T[] {
  return items.slice(window.offset, window.offset + window.pageSize);
}
