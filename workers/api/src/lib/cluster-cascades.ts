import { clusterChangesets, type ClusterInput } from "@releases/core-internal/changesets-cluster";
import { releaseCoverage, DECIDED_BY_CHANGESETS } from "@releases/db/schema-coverage.js";
import { logEvent } from "@releases/lib/log-event";
import { RELEASE_COVERAGE_INSERT_CHUNK_SIZE } from "./d1-limits.js";

/**
 * Schema-agnostic db handle — this helper only inserts into one specific
 * table by reference. Both call sites use different drizzle generics
 * (typed schema in routes, untyped in cron) and Drizzle's insert types
 * don't unify across them, so we keep the helper structurally typed at
 * just what it actually uses.
 */
// oxlint-disable-next-line no-explicit-any -- drizzle insert chains aren't structurally compatible across schema generics; helper only uses insert→values→onConflictDoNothing
type ClusterDb = { insert: (table: typeof releaseCoverage) => any };

/**
 * Shared fingerprint of every changesets-generated cascade body — the
 * literal `Updated dependencies [` substring. Used as a fast pre-filter so
 * non-changesets sources skip the regex pass on every batch.
 */
const CHANGESETS_FINGERPRINT = "Updated dependencies [";

export interface ClusterPersistResult {
  coverageIds: Set<string>;
  clusters: number;
  hashes: string[];
}

/**
 * Run the changesets clusterer over a batch of release rows and persist
 * the detected coverage links to `release_coverage`. Uses
 * `onConflictDoNothing` so auto-decisions never overwrite a manual link.
 *
 * Returns the set of release IDs that were demoted to coverage — callers
 * can subtract these from publish lists, IndexNow counts, etc.
 */
export async function clusterAndPersistCascades(
  db: ClusterDb,
  rows: ClusterInput[],
  context: { component: string; sourceId: string },
): Promise<ClusterPersistResult> {
  if (rows.length < 2) return { coverageIds: new Set(), clusters: 0, hashes: [] };
  // Cheap pre-filter: every changesets cascade body contains this literal.
  // Non-changesets sources (GitHub release notes, blog feeds, …) skip the
  // regex pass entirely on every batch.
  if (!rows.some((r) => r.content.includes(CHANGESETS_FINGERPRINT))) {
    return { coverageIds: new Set(), clusters: 0, hashes: [] };
  }

  const clusters = clusterChangesets(rows);
  if (clusters.length === 0) return { coverageIds: new Set(), clusters: 0, hashes: [] };

  const now = new Date().toISOString();
  const coverageRows = clusters.flatMap((c) =>
    c.coverageIds.map((coverageId) => ({
      canonicalId: c.canonicalId,
      coverageId,
      reason: `changesets-cascade:${c.hash}`,
      decidedBy: DECIDED_BY_CHANGESETS,
      decidedAt: now,
    })),
  );

  for (let i = 0; i < coverageRows.length; i += RELEASE_COVERAGE_INSERT_CHUNK_SIZE) {
    const chunk = coverageRows.slice(i, i + RELEASE_COVERAGE_INSERT_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert (100 bind param limit)
    await db.insert(releaseCoverage).values(chunk).onConflictDoNothing();
  }

  const coverageIds = new Set(clusters.flatMap((c) => c.coverageIds));
  logEvent("info", {
    component: context.component,
    event: "changesets-clustered",
    sourceId: context.sourceId,
    clusters: clusters.length,
    coverageCount: coverageIds.size,
    hashes: clusters.map((c) => c.hash),
  });
  return {
    coverageIds,
    clusters: clusters.length,
    hashes: clusters.map((c) => c.hash),
  };
}
