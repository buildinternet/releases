import type { RawRelease } from "@releases/adapters/types.js";
// Type-only: erased at compile time, so this does NOT pull poll-fetch's runtime
// deps into the route module's import graph.
import type { IngestResult } from "../cron/poll-fetch.js";

export type BackfillBodyVia = "supplied" | "firecrawl" | "fetch" | "snapshot";

export interface SourceBackfillExtractResult {
  releases: RawRelease[];
  windows: number;
  cappedAtWindow: boolean;
  droppedChars: number;
}

export interface SourceBackfillDeps {
  /** Acquire the full-page markdown (supplied / firecrawl / fetch). */
  resolveBody: () => Promise<{ markdown: string; via: BackfillBodyVia }>;
  /** Loop-all-windows extraction over the markdown. */
  extract: (markdown: string) => Promise<SourceBackfillExtractResult>;
  /** Upsert deduped rows via the standard ingest tail. */
  ingest: (rows: RawRelease[]) => Promise<IngestResult>;
  /** Embed + (re)generate summaries/titles for the inserted ids. */
  embedAndGenerate: (insertedIds: string[]) => Promise<void>;
}

export interface SourceBackfillReport {
  source: { id: string; slug: string };
  via: BackfillBodyVia;
  windows: number;
  cappedAtWindow: boolean;
  droppedChars: number;
  /** Pre-dedup mapEntries count. */
  extracted: number;
  /** Unique-by-url count submitted to ingest. */
  deduped: number;
  dateRange: { from: string | null; to: string | null };
  /** rawReleases.length reported by ingest (0 on dryRun). */
  found: number;
  /** Rows actually inserted (0 on dryRun). */
  inserted: number;
  dryRun: boolean;
  /** Caller hint, set ONLY when the Firecrawl ceiling reduced a deeper request
   *  and the run was capped with untouched tail. Populated by the route handler
   *  (via firecrawlCapGuidance), NOT by runSourceBackfill — it's a route-layer
   *  concern since only the route knows the acquisition `via` and the clamp. */
  guidance?: string;
}

/** Collapse rows sharing a synthesized dedup URL, keeping the first occurrence.
 *  A single D1 `INSERT ... ON CONFLICT` cannot touch the same `(source_id, url)`
 *  twice, so within-batch dupes must be removed before ingest chunks them. */
export function dedupeByUrl(rows: RawRelease[]): RawRelease[] {
  const seen = new Set<string>();
  const out: RawRelease[] = [];
  for (const r of rows) {
    const key = r.url ?? "";
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

export function dateRange(rows: ReadonlyArray<{ publishedAt?: Date | null }>): {
  from: string | null;
  to: string | null;
} {
  let from: number | null = null;
  let to: number | null = null;
  for (const r of rows) {
    if (!r.publishedAt) continue;
    const t = r.publishedAt.getTime();
    if (Number.isNaN(t)) continue;
    if (from === null || t < from) from = t;
    if (to === null || t > to) to = t;
  }
  return {
    from: from === null ? null : new Date(from).toISOString(),
    to: to === null ? null : new Date(to).toISOString(),
  };
}

export async function runSourceBackfill(
  source: { id: string; slug: string },
  opts: { dryRun: boolean },
  deps: SourceBackfillDeps,
): Promise<SourceBackfillReport> {
  const { markdown, via } = await deps.resolveBody();
  const extracted = await deps.extract(markdown);
  const deduped = dedupeByUrl(extracted.releases);

  const report: SourceBackfillReport = {
    source,
    via,
    windows: extracted.windows,
    cappedAtWindow: extracted.cappedAtWindow,
    droppedChars: extracted.droppedChars,
    extracted: extracted.releases.length,
    deduped: deduped.length,
    dateRange: dateRange(deduped),
    found: 0,
    inserted: 0,
    dryRun: opts.dryRun,
  };

  if (opts.dryRun) return report;

  const result = await deps.ingest(deduped);
  if (result.insertedIds.length > 0) {
    await deps.embedAndGenerate(result.insertedIds);
  }
  report.found = result.found;
  report.inserted = result.inserted;
  return report;
}

/** Upper bound on extraction windows for the Firecrawl auto-scrape path.
 *  Backfill cost is dominated by sequential Haiku extraction (~1.8s/entry),
 *  NOT the scrape (~0.2s); a window-count ceiling cannot bound a dense page's
 *  total time — it exists only as a sane default ceiling.  Supplied-markdown
 *  and plain-fetch paths are unclamped and remain the route for
 *  arbitrarily-deep histories.  Consumed inside `BackfillSourceWorkflow`'s
 *  `plan-windows` step.  See issue #1281. */
export const FIRECRAWL_BACKFILL_MAX_WINDOWS = 8;

/** The window budget actually handed to extraction: clamped to the hard
 *  ceiling on the firecrawl path, passed through verbatim otherwise. */
export function effectiveBackfillWindows(via: BackfillBodyVia, requested: number): number {
  return via === "firecrawl" ? Math.min(requested, FIRECRAWL_BACKFILL_MAX_WINDOWS) : requested;
}

/** Human/agent-facing hint, set only when the firecrawl ceiling actually
 *  reduced a deeper request AND the run stopped with untouched tail. No silent
 *  caps: the caller is told the page wasn't fully covered and how to go deeper. */
export function firecrawlCapGuidance(input: {
  via: BackfillBodyVia;
  cappedAtWindow: boolean;
  effectiveMaxWindows: number;
  requestedMaxWindows: number;
}): string | undefined {
  if (input.via !== "firecrawl") return undefined;
  if (!input.cappedAtWindow) return undefined;
  // effectiveMaxWindows <= requestedMaxWindows by construction (Math.min); they
  // are equal only when the request was already within the ceiling (no cap).
  if (input.effectiveMaxWindows >= input.requestedMaxWindows) return undefined;
  return `Capped at ${input.effectiveMaxWindows} windows to fit the Firecrawl scrape budget. Re-run with \`markdown\` supplied (render the page yourself) to backfill deeper history.`;
}
