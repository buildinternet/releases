/**
 * Nightly tombstone sweep (#666).
 *
 * Hard-purges rows from `organizations`, `sources`, and `products` whose
 * `deleted_at` is older than `TOMBSTONE_RETENTION_DAYS` (default 30). Soft
 * deletes are reversible up to that boundary; after it, FK CASCADE wipes the
 * dependent rows (releases, knowledge_pages, source_changelog_files,
 * release_coverage, etc.) and the Vectorize index.
 *
 * Runs at 05:30 UTC daily — sequenced after sweep-search-queries (05:00) so
 * the two sweeps don't compete for D1 capacity.
 */

import { and, eq, lt, isNotNull, isNull, inArray, notInArray, type Column } from "drizzle-orm";
import { createDb } from "../db.js";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { finalizeRunRow, insertRunningRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";

export const CRON_NAME = "sweep-tombstones";
export const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;
export const DEFAULT_RETENTION_DAYS = 30;

export type SweepTombstonesEnv = {
  DB: D1Database;
  CRON_ENABLED?: string;
  TOMBSTONE_RETENTION_DAYS?: string;
  RELEASES_INDEX?: VectorizeIndex;
  /** TEST-ONLY: bypass createDb(env.DB) and use the provided instance directly. */
  _drizzleOverride?: any;
};

function parseRetentionDays(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

export async function sweepTombstones(env: SweepTombstonesEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    console.log("[sweep-tombstones] CRON_ENABLED=false; skipping");
    return;
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const now = new Date();
  const retentionDays = parseRetentionDays(env.TOMBSTONE_RETENTION_DAYS);
  const cutoff = daysAgoIso(retentionDays);

  await reconcileStaleRunning(db, {
    cronName: CRON_NAME,
    now,
    thresholdMs: STALE_RUNNING_THRESHOLD_MS,
  });

  const runId = await insertRunningRow(db, { cronName: CRON_NAME, startedAt: now.toISOString() });

  let purgedSources = 0;
  let purgedProducts = 0;
  let purgedOrgs = 0;
  let purgedVectors = 0;

  // Predicate is "tombstoned and older than cutoff" — same shape on each table.
  const expired = (col: Column) => and(isNotNull(col), lt(col, cutoff));

  try {
    // Pre-collect release IDs for any sources we're about to purge so we can
    // clean Vectorize after the FK cascade does its thing. Doing this before
    // DELETE keeps the Vectorize cleanup fire-and-forget without depending on
    // post-delete state.
    const sourcesToPurge: { id: string }[] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(expired(sources.deletedAt));

    const releaseIdsToCleanup: string[] = [];
    if (sourcesToPurge.length > 0) {
      // Chunk inArray reads to stay well under D1's 100-bind limit.
      const CHUNK = 90;
      const sourceIds = sourcesToPurge.map((s) => s.id);
      for (let i = 0; i < sourceIds.length; i += CHUNK) {
        const slice = sourceIds.slice(i, i + CHUNK);
        // oxlint-disable-next-line no-await-in-loop -- chunked inArray under D1's bind cap
        const rows: { id: string }[] = await db
          .select({ id: releases.id })
          .from(releases)
          .where(inArray(releases.sourceId, slice));
        releaseIdsToCleanup.push(...rows.map((r) => r.id));
      }

      // Sources first (cascades to releases, source_changelog_files, etc.)
      const deleted = await db
        .delete(sources)
        .where(expired(sources.deletedAt))
        .returning({ id: sources.id });
      purgedSources = deleted.length;
    }

    // Products next (no children that aren't already covered).
    const deletedProducts = await db
      .delete(products)
      .where(expired(products.deletedAt))
      .returning({ id: products.id });
    purgedProducts = deletedProducts.length;

    // Orgs last (cascades any remaining children — domain_aliases, org_tags,
    // org_accounts, knowledge_pages, etc.).
    //
    // Defense-in-depth: skip orgs that still have an active product or source.
    // Normal soft-delete cascade-tombstones children, but a manual revive of a
    // child without reviving the parent would otherwise let the cascade FK on
    // products.org_id wipe an active product when we hard-purge the org. The
    // soft path is reversible up to the retention boundary; this guard makes
    // the cron's hard-delete safe regardless of how the tombstones got set.
    const orgsBlockedByActiveProducts = await db
      .selectDistinct({ orgId: products.orgId })
      .from(products)
      .innerJoin(organizations, eq(organizations.id, products.orgId))
      .where(and(expired(organizations.deletedAt), isNull(products.deletedAt)));
    const orgsBlockedByActiveSources = await db
      .selectDistinct({ orgId: sources.orgId })
      .from(sources)
      .innerJoin(organizations, eq(organizations.id, sources.orgId))
      .where(and(expired(organizations.deletedAt), isNull(sources.deletedAt)));
    const blockedOrgIds = new Set<string>([
      ...orgsBlockedByActiveProducts
        .map((r: { orgId: string | null }) => r.orgId)
        .filter((id: string | null): id is string => !!id),
      ...orgsBlockedByActiveSources
        .map((r: { orgId: string | null }) => r.orgId)
        .filter((id: string | null): id is string => !!id),
    ]);

    const orgDeleteWhere =
      blockedOrgIds.size > 0
        ? and(expired(organizations.deletedAt), notInArray(organizations.id, [...blockedOrgIds]))
        : expired(organizations.deletedAt);
    const deletedOrgs = await db
      .delete(organizations)
      .where(orgDeleteWhere)
      .returning({ id: organizations.id });
    purgedOrgs = deletedOrgs.length;
    if (blockedOrgIds.size > 0) {
      console.warn(
        `[sweep-tombstones] skipped ${blockedOrgIds.size} expired orgs with active children — manual cleanup needed`,
      );
    }

    // Vectorize cleanup: delete release vectors for purged sources. Mirrors
    // the chunked deleteByIds pattern used by DELETE /sources/:slug/releases.
    if (releaseIdsToCleanup.length > 0 && env.RELEASES_INDEX) {
      const CHUNK = 500;
      for (let i = 0; i < releaseIdsToCleanup.length; i += CHUNK) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- Vectorize chunked delete (API batch limit)
          await env.RELEASES_INDEX.deleteByIds(releaseIdsToCleanup.slice(i, i + CHUNK));
          purgedVectors += Math.min(CHUNK, releaseIdsToCleanup.length - i);
        } catch (err) {
          console.warn(
            `[sweep-tombstones] Vectorize delete chunk failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finalizeRunRow(db, runId, {
      endedAt: new Date().toISOString(),
      status: "aborted",
      abortReason: "config_missing",
      candidates: 0,
      dispatched: 0,
      skippedOverCap: 0,
      dispatchErrors: 1,
      sessionsStarted: [],
      dispatchErrorDetail: [{ orgSlug: "n/a", error: message }],
      notes: `purge failed: ${message}`,
    });
    throw err;
  }

  const totalPurged = purgedOrgs + purgedSources + purgedProducts;
  const notes = `orgs=${purgedOrgs} sources=${purgedSources} products=${purgedProducts} vectors=${purgedVectors} (older than ${retentionDays}d)`;

  await finalizeRunRow(db, runId, {
    endedAt: new Date().toISOString(),
    status: "done",
    candidates: totalPurged,
    dispatched: totalPurged,
    skippedOverCap: 0,
    dispatchErrors: 0,
    sessionsStarted: [],
    dispatchErrorDetail: [],
    notes,
  });

  console.log(`[sweep-tombstones] done: ${notes}`);
}
