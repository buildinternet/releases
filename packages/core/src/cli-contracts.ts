/**
 * Shared output-contract types for the `--json` surface of the `releases` CLI.
 *
 * The CLI is an implicit public API for scripts and AI agents. This module is
 * the single source of truth for the shape of paginated list responses, so the
 * OSS CLI (buildinternet/releases-cli) and the monorepo dev CLI
 * (buildinternet/releases) cannot drift on pagination semantics or envelope
 * fields.
 *
 * See buildinternet/releases-cli#24 for the motivating incident.
 */

/** Matches the API worker's hard cap so a single default request returns the
 *  broadest safe window. */
export const DEFAULT_PAGE_SIZE = 500;

export interface Pagination {
  page: number;
  pageSize: number;
  /** Number of items on THIS page. Always present. */
  returned: number;
  /** Total items across all pages. Optional — only populated when the backing
   *  API reports totals. Absent means "total unknown; use hasMore instead." */
  totalItems?: number;
  /** Total page count. Optional; absent when `totalItems` is. */
  totalPages?: number;
  /** True when more results may exist beyond this page. Conservative: when
   *  totals are unknown, derived from `returned === pageSize`. */
  hasMore: boolean;
}

export interface ListResponse<T> {
  items: T[];
  pagination: Pagination;
}

export interface ComputePaginationOpts {
  page: number;
  pageSize: number;
  returned: number;
  totalItems?: number;
}

export function computePagination(opts: ComputePaginationOpts): Pagination {
  const { page, pageSize, returned, totalItems } = opts;
  if (totalItems != null) {
    return {
      page,
      pageSize,
      returned,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / pageSize)),
      hasMore: page * pageSize < totalItems,
    };
  }
  return { page, pageSize, returned, hasMore: returned === pageSize };
}

type MetadataInput = string | Record<string, unknown> | null | undefined;

/**
 * Parse a metadata field that may be a JSON-encoded string into its nested
 * object form. No-ops for objects, null, or invalid JSON (preserves the
 * original value so we never lose data on a malformed row).
 */
export function parseMetadataField(value: MetadataInput): MetadataInput {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Narrow variant of `parseMetadataField` for callers that only care about the
 * object shape (e.g. checking whether a key exists). Returns null for strings
 * that fail to parse, for primitives, and for null/undefined inputs.
 */
export function parseMetadataObject(value: MetadataInput): Record<string, unknown> | null {
  const parsed = parseMetadataField(value);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

/**
 * Format a stderr warning explaining why a large JSON list response may be
 * truncated, with the exact flags a caller should pass to paginate.
 *
 * Returns the line to print; the caller decides where (stderr, log, etc).
 */
export function formatTruncationWarning(opts: {
  returned: number;
  pageSize: number;
  commandExample: string;
}): string {
  return (
    `warning: results may be truncated (${opts.returned} items returned, page size ${opts.pageSize}). ` +
    `Paginate explicitly: ${opts.commandExample}`
  );
}
