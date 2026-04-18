import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { logger } from "@buildinternet/releases-lib/logger";
import { getRecentReleasesByOrg, linkReleaseCoverage } from "../db/queries.js";
import { groupReleases, type GroupingCandidate } from "../ai/grouping.js";
import { decidedByAgent } from "../db/schema-coverage.js";

export interface IngestGroupingDeps {
  /** Override the candidate fetcher (defaults to {@link getRecentReleasesByOrg}). */
  fetchCandidates?: typeof getRecentReleasesByOrg;
  /** Override the grouping agent (defaults to {@link groupReleases}). */
  groupReleases?: typeof groupReleases;
  /** Override the coverage writer (defaults to {@link linkReleaseCoverage}). */
  linkCoverage?: typeof linkReleaseCoverage;
  /** Lookback window for the same-org candidate set. Defaults to 7 days. */
  windowDays?: number;
}

export interface IngestGroupingResult {
  /** Number of release_coverage rows successfully written. */
  written: number;
  /** Reason ingest grouping was skipped or failed. Absent on full success. */
  skipped?: string;
}

/**
 * Run release_coverage grouping immediately after a fetch's inserts.
 *
 * Pulls the org's recent ±N-day window as the candidate set, asks the grouping
 * agent to cluster them, and writes one `release_coverage` row per non-singleton
 * coverage_id. Always fail-open: any error is logged and returned via `skipped`.
 * Ingest must never block on grouping.
 */
export async function runIngestTimeGrouping(
  orgId: string,
  context: string,
  deps: IngestGroupingDeps = {},
): Promise<IngestGroupingResult> {
  const fetchCandidates = deps.fetchCandidates ?? getRecentReleasesByOrg;
  const grouping = deps.groupReleases ?? groupReleases;
  const link = deps.linkCoverage ?? linkReleaseCoverage;
  const windowDays = deps.windowDays ?? 7;

  let rows: Awaited<ReturnType<typeof getRecentReleasesByOrg>>;
  try {
    rows = await fetchCandidates(orgId, daysAgoIso(windowDays));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`ingest-grouping: candidate fetch failed for ${orgId}: ${msg}`);
    return { written: 0, skipped: msg };
  }

  if (rows.length < 2) return { written: 0, skipped: "candidates < 2" };

  const candidates: GroupingCandidate[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    version: r.version,
    publishedAt: r.publishedAt,
    sourceSlug: r.sourceSlug,
    content: r.contentSummary || r.content,
  }));

  let result: Awaited<ReturnType<typeof groupReleases>>;
  try {
    result = await grouping(candidates, { context });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`ingest-grouping: agent call failed for ${orgId}: ${msg}`);
    return { written: 0, skipped: msg };
  }

  const decidedBy = decidedByAgent(result.model);
  let written = 0;
  for (const cluster of result.clusters) {
    if (cluster.coverageIds.length === 0) continue;
    for (const coverageId of cluster.coverageIds) {
      try {
        await link({
          canonicalId: cluster.canonicalId,
          coverageId,
          reason: cluster.reason,
          decidedBy,
        });
        written++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`ingest-grouping: link failed (${cluster.canonicalId} ← ${coverageId}): ${msg}`);
        return { written, skipped: msg };
      }
    }
  }

  return { written };
}
