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

import { and, lt, isNotNull, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { finalizeRunRow, insertRunningRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";

export const CRON_NAME = "sweep-tombstones";
export const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;
export const DEFAULT_RETENTION_DAYS = 30;

export type SweepTombstonesEnv = {
  DB: D1Database;
  CRON_ENABLED?: string;
  TOMBSTONE_RETENTION_DAYS?: string;
  RELEASES_INDEX?: VectorizeIndex;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
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

  const db = env._drizzleOverride ?? drizzle(env.DB);
  const now = new Date();
  const retentionDays = parseRetentionDays(env.TOMBSTONE_RETENTION_DAYS);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

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

  try {
    // Pre-collect release IDs for any sources we're about to purge so we can
    // clean Vectorize after the FK cascade does its thing. Doing this before
    // DELETE keeps the Vectorize cleanup fire-and-forget without depending on
    // post-delete state.
    const sourcesToPurge: { id: string }[] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(isNotNull(sources.deletedAt), lt(sources.deletedAt, cutoff)));

    const releaseIdsToCleanup: string[] = [];
    if (sourcesToPurge.length > 0) {
      // Chunk inArray reads to stay well under D1's 100-bind limit.
      const CHUNK = 90;
      const sourceIds = sourcesToPurge.map((s: { id: string }) => s.id);
      for (let i = 0; i < sourceIds.length; i += CHUNK) {
        const slice = sourceIds.slice(i, i + CHUNK);
        // oxlint-disable-next-line no-await-in-loop -- chunked inArray under D1's bind cap
        const rows: { id: string }[] = await db
          .select({ id: releases.id })
          .from(releases)
          .where(inArray(releases.sourceId, slice));
        releaseIdsToCleanup.push(...rows.map((r: { id: string }) => r.id));
      }
    }

    // Sources first (cascades to releases, source_changelog_files, etc.)
    if (sourcesToPurge.length > 0) {
      const deleted = await db
        .delete(sources)
        .where(and(isNotNull(sources.deletedAt), lt(sources.deletedAt, cutoff)))
        .returning({ id: sources.id });
      purgedSources = deleted.length;
    }

    // Products next (no children that aren't already covered).
    const deletedProducts = await db
      .delete(products)
      .where(and(isNotNull(products.deletedAt), lt(products.deletedAt, cutoff)))
      .returning({ id: products.id });
    purgedProducts = deletedProducts.length;

    // Orgs last (cascades any remaining children — domain_aliases, org_tags,
    // org_accounts, knowledge_pages, etc.).
    const deletedOrgs = await db
      .delete(organizations)
      .where(and(isNotNull(organizations.deletedAt), lt(organizations.deletedAt, cutoff)))
      .returning({ id: organizations.id });
    purgedOrgs = deletedOrgs.length;

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
