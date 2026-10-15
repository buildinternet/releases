/**
 * Persist release-candidate, backport, and sibling-package coverage detected
 * at ingest. `decided_by` is distinct from `system:changesets` so the
 * changesets retier never clears these links.
 */
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { releases, sources } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage.js";
import {
  clusterVersionLines,
  type VersionLineInput,
} from "@releases/core-internal/version-line-cluster";
import { publishedDay, versionIdentity } from "@buildinternet/releases-core/content-dedup";
import { logEvent } from "@releases/lib/log-event";
import type { D1Db } from "../../db.js";
import { IN_ARRAY_CHUNK_SIZE } from "../d1-limits.js";
import { RELEASE_COVERAGE_INSERT_CHUNK_SIZE } from "../d1-limits.js";
import { releaseBodyHash } from "./content-dedup.js";

/**
 * Kept out of `schema-coverage.ts` — editing that file is a schema change
 * the CI pairing gate would require a migration for.
 */
export const DECIDED_BY_VERSION_LINE = "system:version-line";

export interface VersionLinePersistResult {
  coverageIds: Set<string>;
  clusters: number;
}

function dayShift(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function toInput(row: {
  id: string;
  sourceId: string;
  version: string | null;
  title: string;
  content: string;
  publishedAt: string | null;
  bodyHash: string | null;
}): VersionLineInput {
  return {
    id: row.id,
    sourceId: row.sourceId,
    version: row.version,
    title: row.title,
    content: row.content,
    publishedAt: row.publishedAt,
    bodyHash: row.bodyHash ?? releaseBodyHash(row.content, row.title),
  };
}

/**
 * Link version-line coverage for `inserted` and the nearby rows they might
 * attach to (same source over the rc/backport window, plus same-day sibling
 * sources in the org). `onConflictDoNothing` so a changesets or human link
 * already on a row is left alone.
 */
export async function clusterAndPersistVersionLines(
  db: D1Db,
  inserted: Array<{
    id: string;
    version: string | null;
    title: string;
    content: string;
    publishedAt: string | null;
  }>,
  context: { component: string; sourceId: string; orgId: string | null },
): Promise<VersionLinePersistResult> {
  const empty = { coverageIds: new Set<string>(), clusters: 0 };
  if (inserted.length === 0) return empty;

  const days = [
    ...new Set(
      inserted.map((row) => publishedDay(row.publishedAt)).filter((d): d is string => !!d),
    ),
  ];
  // No day and no version token: nothing structural to attach.
  if (days.length === 0 && !inserted.some((row) => versionIdentity(row.version, row.title))) {
    return empty;
  }

  const earliest = days.length > 0 ? days.reduce((a, b) => (a < b ? a : b)) : null;
  const latest = days.length > 0 ? days.reduce((a, b) => (a > b ? a : b)) : null;
  const sourceClause =
    earliest && latest
      ? and(
          eq(releases.sourceId, context.sourceId),
          gte(releases.publishedAt, dayShift(earliest, -120)),
          lt(releases.publishedAt, dayShift(latest, 1)),
        )
      : eq(releases.sourceId, context.sourceId);

  const sameSource = await db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      version: releases.version,
      title: releases.title,
      content: releases.content,
      publishedAt: releases.publishedAt,
      bodyHash: releases.bodyHash,
    })
    .from(releases)
    .where(sourceClause)
    .orderBy(desc(releases.publishedAt))
    .limit(300);

  let siblings: typeof sameSource = [];
  if (context.orgId && earliest && latest) {
    siblings = await db
      .select({
        id: releases.id,
        sourceId: releases.sourceId,
        version: releases.version,
        title: releases.title,
        content: releases.content,
        publishedAt: releases.publishedAt,
        bodyHash: releases.bodyHash,
      })
      .from(releases)
      .innerJoin(sources, eq(releases.sourceId, sources.id))
      .where(
        and(
          eq(sources.orgId, context.orgId),
          gte(releases.publishedAt, earliest),
          lt(releases.publishedAt, dayShift(latest, 1)),
        ),
      )
      .limit(200);
  }

  const byId = new Map<string, VersionLineInput>();
  for (const row of [...sameSource, ...siblings]) byId.set(row.id, toInput(row));
  // Inserted rows win so a just-written body is what we cluster, even if the
  // lookback query's limit dropped them.
  for (const row of inserted) {
    byId.set(row.id, toInput({ ...row, sourceId: context.sourceId, bodyHash: null }));
  }

  const ids = [...byId.keys()];
  const alreadyCovered = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_ARRAY_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + IN_ARRAY_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked IN (100 bind param limit)
    const rows = await db
      .select({ id: releaseCoverage.coverageId })
      .from(releaseCoverage)
      .where(inArray(releaseCoverage.coverageId, chunk));
    for (const row of rows) alreadyCovered.add(row.id);
  }
  for (const id of alreadyCovered) byId.delete(id);

  const clusters = clusterVersionLines([...byId.values()]);
  // Only persist a cluster that touches a row this ingest actually wrote.
  // Re-clustering the whole lookback on every fetch would hide older rows
  // that were never part of this write.
  const insertedIds = new Set(inserted.map((row) => row.id));
  const fresh = clusters.filter(
    (cluster) =>
      insertedIds.has(cluster.canonicalId) || cluster.coverageIds.some((id) => insertedIds.has(id)),
  );
  if (fresh.length === 0) return empty;

  const now = new Date().toISOString();
  const coverageRows = fresh.flatMap((cluster) =>
    cluster.coverageIds.map((coverageId) => ({
      canonicalId: cluster.canonicalId,
      coverageId,
      reason: cluster.reason,
      decidedBy: DECIDED_BY_VERSION_LINE,
      decidedAt: now,
    })),
  );

  for (let i = 0; i < coverageRows.length; i += RELEASE_COVERAGE_INSERT_CHUNK_SIZE) {
    const chunk = coverageRows.slice(i, i + RELEASE_COVERAGE_INSERT_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert (100 bind param limit)
    await db.insert(releaseCoverage).values(chunk).onConflictDoNothing();
  }

  const coverageIds = new Set(fresh.flatMap((cluster) => cluster.coverageIds));
  logEvent("info", {
    component: context.component,
    event: "version-line-clustered",
    sourceId: context.sourceId,
    clusters: fresh.length,
    coverageCount: coverageIds.size,
    reasons: fresh.map((cluster) => cluster.reason),
  });
  return { coverageIds, clusters: fresh.length };
}
