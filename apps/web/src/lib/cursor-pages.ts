/**
 * Follow an API list's `pagination.nextCursor` across pages. List routes cap
 * `?limit=` (100 for most), so anything that needs the whole list — or a
 * lookup that may sit past page 1 — must walk the cursor rather than trust a
 * single big page.
 */

/** Default safety cap so a pathological list can't become an unbounded loop. */
export const MAX_CURSOR_PAGES = 25;

export interface CursorPage {
  pagination: { nextCursor: string | null };
}

/**
 * Yield each page in order. Stops when the cursor runs out, a cursor repeats
 * (some feeds fail open to page 1 on a bad cursor, which would otherwise loop),
 * or `maxPages` is reached.
 */
export async function* cursorPages<P extends CursorPage>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  maxPages = MAX_CURSOR_PAGES,
): AsyncGenerator<P> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(cursor);
    yield res;
    const next = res.pagination.nextCursor;
    if (!next || seen.has(next)) return;
    seen.add(next);
    cursor = next;
  }
}

/** Every item across all pages, flattened via `itemsOf`. */
export async function collectCursorPages<P extends CursorPage, T>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  itemsOf: (page: P) => readonly T[],
  maxPages = MAX_CURSOR_PAGES,
): Promise<T[]> {
  const all: T[] = [];
  for await (const page of cursorPages(fetchPage, maxPages)) all.push(...itemsOf(page));
  return all;
}
