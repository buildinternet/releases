import { daysAgoIso } from "@releases/core-internal/dates";
import { getRecentReleasesByOrg, linkReleaseCoverage } from "../db/queries.js";
import {
  groupReleases,
  rowsToCandidates,
  writeCoverageClusters,
} from "../ai/grouping.js";
import { decidedByAgent } from "../db/schema-coverage.js";

/** Same-org lookback for ingest-time candidate selection. */
const INGEST_GROUPING_WINDOW_DAYS = 7;

export interface IngestGroupingDeps {
  fetchCandidates?: typeof getRecentReleasesByOrg;
  groupReleases?: typeof groupReleases;
  linkCoverage?: typeof linkReleaseCoverage;
}

/**
 * Cluster an org's recent releases and write any non-singleton coverage rows.
 *
 * Intended for post-fetch calls — the caller owns the try/catch so a flaky
 * agent can't block ingest. Returns the number of `release_coverage` rows
 * persisted. Throws on any underlying error (candidate fetch, agent call, or
 * link write).
 */
export async function runIngestTimeGrouping(
  orgId: string,
  context: string,
  deps: IngestGroupingDeps = {},
): Promise<number> {
  const fetchCandidates = deps.fetchCandidates ?? getRecentReleasesByOrg;
  const grouping = deps.groupReleases ?? groupReleases;
  const link = deps.linkCoverage ?? linkReleaseCoverage;

  const rows = await fetchCandidates(orgId, daysAgoIso(INGEST_GROUPING_WINDOW_DAYS));
  if (rows.length < 2) return 0;

  const candidates = rowsToCandidates(rows);
  const result = await grouping(candidates, { context });
  return writeCoverageClusters(result.clusters, decidedByAgent(result.model), link);
}
