/**
 * Deterministic per-source update loop (#1878).
 *
 * A routine `update` run is a deterministic fetch→extract pipeline: the worker
 * agent only ever issued one batch of `manage_source(fetch)` calls, and every
 * real decision (URL, crawl vs render, incremental vs seed, dedup, retry) lives
 * in `scrapeFetch`. This module runs that fetch directly over the due sources,
 * with no Managed-Agents session — skipping the Haiku agent loop whose ~19k-token
 * prompt+skills+playbook cache-creation was ~84% of a session's cost.
 *
 * Kept as a pure module (no DO state, no SDK) so the loop + result parsing are
 * unit-testable. `scrapeFetch` returns a result STRING — JSON on success, an
 * `Error [category]: ...` string on a handled failure — and may throw on infra
 * errors; the loop normalizes all three into a structured per-source result.
 */

export interface ScrapeFetchOutcome {
  /** Source identifier (src_… id or slug) that was fetched. */
  source: string;
  ok: boolean;
  status?: string;
  releasesFound?: number;
  releasesInserted?: number;
  error?: string;
  /** Error category parsed from an `Error [category]: …` result, when present. */
  errorCategory?: string;
}

export interface UpdateLoopSummary {
  results: ScrapeFetchOutcome[];
  /** Sources actually fetched (excludes those skipped for budget). */
  sourcesProcessed: number;
  /** Sources not started because the wall-clock budget was exhausted. */
  sourcesSkipped: number;
  totalReleasesFound: number;
  totalReleasesInserted: number;
  /** Count of processed sources whose fetch failed. */
  errorCount: number;
}

export interface UpdateLoopOptions {
  /**
   * Wall-clock ms after which no NEW fetch is started — remaining sources are
   * reported as skipped rather than risking the DO's session timeout mid-fetch.
   */
  budgetMs: number;
  /** Injectable clock (defaults to Date.now) so tests can drive the budget. */
  now?: () => number;
}

const ERROR_WITH_CATEGORY = /^Error \[([a-z]+)\]:\s*(.*)$/s;

/** Normalize a `scrapeFetch` result string into a structured outcome. */
export function parseScrapeFetchResult(source: string, raw: string): ScrapeFetchOutcome {
  const withCategory = raw.match(ERROR_WITH_CATEGORY);
  if (withCategory) {
    return { source, ok: false, error: withCategory[2], errorCategory: withCategory[1] };
  }
  if (raw.startsWith("Error:")) {
    return { source, ok: false, error: raw.slice("Error:".length).trim() };
  }
  try {
    const parsed = JSON.parse(raw) as {
      status?: string;
      releasesFound?: number;
      releasesInserted?: number;
    };
    return {
      source,
      ok: true,
      status: parsed.status,
      releasesFound: parsed.releasesFound ?? 0,
      releasesInserted: parsed.releasesInserted ?? 0,
    };
  } catch {
    // A non-JSON, non-`Error` string is unexpected — treat as a failure so it
    // surfaces rather than being silently counted as a success.
    return { source, ok: false, error: `Unparseable fetch result: ${raw.slice(0, 200)}` };
  }
}

/**
 * Fetch each source in sequence via `scrapeFetch`, aggregating counts. Never
 * throws: a per-source throw becomes an error outcome so one bad source can't
 * abort the batch. Stops STARTING new fetches once the wall-clock budget is
 * exhausted (an in-flight fetch is always allowed to finish).
 */
export async function runScrapeFetchLoop(
  sources: string[],
  scrapeFetchSource: (source: string) => Promise<string>,
  options: UpdateLoopOptions,
): Promise<UpdateLoopSummary> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const results: ScrapeFetchOutcome[] = [];
  let sourcesSkipped = 0;

  for (const source of sources) {
    if (now() - startedAt >= options.budgetMs) {
      sourcesSkipped = sources.length - results.length;
      break;
    }
    try {
      const raw = await scrapeFetchSource(source);
      results.push(parseScrapeFetchResult(source, raw));
    } catch (err) {
      results.push({
        source,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let totalReleasesFound = 0;
  let totalReleasesInserted = 0;
  let errorCount = 0;
  for (const r of results) {
    totalReleasesFound += r.releasesFound ?? 0;
    totalReleasesInserted += r.releasesInserted ?? 0;
    if (!r.ok) errorCount += 1;
  }

  return {
    results,
    sourcesProcessed: results.length,
    sourcesSkipped,
    totalReleasesFound,
    totalReleasesInserted,
    errorCount,
  };
}
