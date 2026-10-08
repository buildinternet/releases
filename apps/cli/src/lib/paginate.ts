/**
 * `--page-all` streaming for the page-based list readers.
 *
 * Normally a `--json` list call returns a single page wrapped in a
 * `{ items, pagination }` envelope, and the caller walks pages with
 * `--page`/`--limit`. `--page-all` instead walks every page itself and streams
 * the result as newline-delimited JSON (NDJSON) — one item per line — so an
 * agent can consume an entire result set in one command without managing the
 * cursor. NDJSON (rather than one giant array) keeps memory flat and lets a
 * consumer process rows as they arrive.
 */

import { writeJsonLine } from "./output.js";
import { logger } from "@buildinternet/releases-lib/logger";

export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
}

/**
 * Walk every page of a page-based list endpoint, starting from page 1, and
 * stream each item as a single NDJSON line via {@link writeJsonLine}.
 *
 * `fetchPage(page)` returns that page's items plus whether more pages remain.
 * `project` shapes each item before it's written (e.g. the compact/full
 * mapping `list --json` already applies); it defaults to the identity.
 *
 * Iteration stops when the backend reports no more pages or hands back an
 * empty page (defensive against a backend that reports `hasMore: true`
 * indefinitely). `MAX_PAGES` is a final backstop against an unbounded loop.
 *
 * Returns the number of items streamed.
 */
export async function streamAllPages<T>(
  fetchPage: (page: number) => Promise<PageResult<T>>,
  project: (item: T) => unknown = (item) => item,
): Promise<number> {
  const MAX_PAGES = 10_000;
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    // Sequential by nature: page N+1 isn't known to exist until page N's
    // `hasMore` comes back, so the pages can't be fetched in parallel.
    // oxlint-disable-next-line no-await-in-loop -- pagination cursor depends on prior page
    const { items, hasMore } = await fetchPage(page);
    for (const item of items) {
      // oxlint-disable-next-line no-await-in-loop -- stream each line, awaiting backpressure drain
      await writeJsonLine(project(item));
      total++;
    }
    if (!hasMore || items.length === 0) break;
  }
  return total;
}

/**
 * Wire `--page-all` into a list reader's action handler. Shared across the
 * page-based readers (`list`, `org list`, `admin product list`) so each gets
 * identical flag semantics from one place:
 *
 * - not requested → returns `false`; the caller proceeds with its normal
 *   single-page path.
 * - combined with `--page` → hard error (the two contradict).
 * - requested without `--json` → warns and returns `false` (falls through to
 *   the table), mirroring how `--full`/`--fields` behave.
 * - requested with `--json` → streams every page as NDJSON and returns `true`,
 *   signalling the caller to `return` immediately.
 *
 * `fetchPage`/`project` are forwarded to {@link streamAllPages}; the caller's
 * closure captures its own filters and page size.
 */
export async function handlePageAll<T>(
  opts: { pageAll?: boolean; page?: string; json?: boolean },
  fetchPage: (page: number) => Promise<PageResult<T>>,
  project?: (item: T) => unknown,
): Promise<boolean> {
  if (!opts.pageAll) return false;
  if (opts.page !== undefined) {
    logger.error("--page-all walks every page; drop --page (or use --page without --page-all)");
    process.exit(1);
  }
  if (!opts.json) {
    logger.warn("--page-all only affects --json output; ignoring it");
    return false;
  }
  await streamAllPages(fetchPage, project);
  return true;
}
