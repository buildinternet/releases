import type { RawRelease } from "@releases/adapters/types.js";
// Type-only: erased at compile time, so this does NOT pull poll-fetch's runtime
// deps into the route module's import graph.
import type { IngestResult } from "../cron/poll-fetch.js";

export type BackfillBodyVia = "supplied" | "firecrawl" | "fetch";

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
}

/** Collapse rows sharing a synthesized dedup URL, keeping the first occurrence.
 *  A single D1 `INSERT ... ON CONFLICT` cannot touch the same `(source_id, url)`
 *  twice, so within-batch dupes must be removed before ingest chunks them. */
function dedupeByUrl(rows: RawRelease[]): RawRelease[] {
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

function dateRange(rows: RawRelease[]): { from: string | null; to: string | null } {
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
