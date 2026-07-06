/**
 * Demotion automation (#1958, follow-up to the stub-tier epic #1947).
 * `promoteStubOrg` deliberately keeps `release_locations` rows in place after
 * promotion — stamped with `source_id` but not consumed — precisely so this
 * sweep can run the reverse transition losslessly: when a `tracked` org has
 * lost every live source it was promoted from, flip it back to `tier: "stub"`
 * and clear the now-dead `source_id` stamps so a future re-promotion
 * re-materializes cleanly rather than pointing at a source that no longer
 * exists.
 *
 * Eligibility, deliberately conservative:
 *   - `tier = 'tracked'` — a stub org is already the target state.
 *   - Zero LIVE sources (`deleted_at IS NULL`). A **paused** source still
 *     counts as live — pausing is a reversible curator action, not removal,
 *     so it must never trigger demotion.
 *   - At least one live (`deleted_at IS NULL`) `release_locations` row. This
 *     locator gate protects legacy `tracked` orgs that predate the locator
 *     model and have no declared locations — those have nothing to
 *     re-materialize from, so demoting them would be a one-way trip to a stub
 *     with no path back via promotion.
 *
 * Gated behind the existing `well-known-materialization-enabled` flag (no new
 * flag) — demotion is part of the same owner-declared-manifest materialization
 * story as promotion. Wired into the `0 4 * * *` daily-scan tick alongside
 * the other daily cron sweeps.
 */
import { and, count, eq, inArray, isNull, notExists } from "drizzle-orm";
import { organizations, releaseLocations, sources } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import { createDb, type D1Db } from "../db.js";
import { affectedRows } from "../lib/well-known/promote.js";
import { IN_ARRAY_CHUNK_SIZE } from "../lib/d1-limits.js";

export interface StubDemotionEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  FLAGS?: FlagshipBinding;
  WELL_KNOWN_MATERIALIZATION_ENABLED?: string;
  /** TEST-ONLY: bypass createDb(env.DB) and use the provided instance directly. */
  _drizzleOverride?: D1Db;
}

export interface StubDemotionResult {
  scanned: number;
  demoted: number;
  stampsCleared: number;
}

/**
 * Sweep `tracked` orgs for ones that have lost every live source (paused
 * sources still count as live) but still carry at least one live declared
 * locator, and demote them back to `tier: "stub"`. Clears `source_id` stamps
 * on that org's locators whose stamped source is gone (soft-deleted or
 * hard-deleted/missing) — the locator rows themselves are untouched, keeping
 * the promotion/demotion cycle symmetric and lossless.
 */
export async function sweepStubDemotions(env: StubDemotionEnv): Promise<StubDemotionResult> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "well-known", event: "stub-demotion-cron-disabled" });
    return { scanned: 0, demoted: 0, stampsCleared: 0 };
  }

  const materializationEnabled = await flag(
    env.FLAGS,
    env.WELL_KNOWN_MATERIALIZATION_ENABLED,
    FLAGS.wellKnownMaterializationEnabled,
  );
  if (!materializationEnabled) {
    logEvent("info", { component: "well-known", event: "stub-demotion-disabled" });
    return { scanned: 0, demoted: 0, stampsCleared: 0 };
  }

  const db = env._drizzleOverride ?? createDb(env.DB);

  // Candidate `tracked` orgs with zero live sources. LEFT JOIN + a
  // COUNT(sources.id) = 0 filter (via HAVING) catches both "never had a
  // source" and "every source has since been soft-deleted"; paused sources
  // are still live rows so they're excluded from demotion by construction —
  // no separate fetchPriority check needed.
  const zeroLiveSourceOrgs = await db
    .select({ orgId: organizations.id, liveSourceCount: count(sources.id) })
    .from(organizations)
    .leftJoin(sources, and(eq(sources.orgId, organizations.id), isNull(sources.deletedAt)))
    .where(and(eq(organizations.tier, "tracked"), isNull(organizations.deletedAt)))
    .groupBy(organizations.id)
    .having(eq(count(sources.id), 0));

  if (zeroLiveSourceOrgs.length === 0) {
    logEvent("info", {
      component: "well-known",
      event: "stub-demotion-scan-complete",
      scanned: 0,
      demoted: 0,
      stampsCleared: 0,
    });
    return { scanned: 0, demoted: 0, stampsCleared: 0 };
  }

  const candidateIds = zeroLiveSourceOrgs.map((r) => r.orgId);

  // Locator gate: only demote orgs that still have at least one live declared
  // locator to re-materialize from. Chunk the IN-lookup at the D1 90-id bind
  // limit.
  const orgsWithLiveLocators = new Set<string>();
  for (let i = 0; i < candidateIds.length; i += IN_ARRAY_CHUNK_SIZE) {
    const chunk = candidateIds.slice(i, i + IN_ARRAY_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- chunked IN lookup (90-id D1 limit)
    const rows = await db
      .selectDistinct({ orgId: releaseLocations.orgId })
      .from(releaseLocations)
      .where(and(inArray(releaseLocations.orgId, chunk), isNull(releaseLocations.deletedAt)));
    for (const r of rows) orgsWithLiveLocators.add(r.orgId);
  }

  const eligibleOrgIds = candidateIds.filter((id) => orgsWithLiveLocators.has(id));

  let demoted = 0;
  let stampsCleared = 0;
  const now = new Date().toISOString();

  for (const orgId of eligibleOrgIds) {
    try {
      // Guarded flip: the eligibility set is a snapshot, so re-assert the
      // demotion condition inside the write itself — the org must still be
      // `tracked` AND still have zero live sources (one may have been created
      // or un-deleted since the scan). 0 rows affected = no longer eligible;
      // skip without counting it as demoted.
      // oxlint-disable-next-line no-await-in-loop -- one org at a time; bounded by the daily candidate set
      const flipResult = await db
        .update(organizations)
        .set({ tier: "stub", updatedAt: now })
        .where(
          and(
            eq(organizations.id, orgId),
            eq(organizations.tier, "tracked"),
            notExists(
              db
                .select({ id: sources.id })
                .from(sources)
                .where(and(eq(sources.orgId, orgId), isNull(sources.deletedAt))),
            ),
          ),
        );
      if (affectedRows(flipResult) === 0) continue;
      // Stamp clear follows a successful flip so `stampsCleared` only counts
      // work done for orgs that were actually demoted.
      // oxlint-disable-next-line no-await-in-loop -- per-demoted-org cleanup
      const cleared = await clearDeadLocatorStamps(db, orgId);
      demoted++;
      stampsCleared += cleared;
      logEvent("info", {
        component: "well-known",
        event: "stub-demoted",
        orgId,
        stampsCleared: cleared,
      });
    } catch (err) {
      logEvent("error", {
        component: "well-known",
        event: "stub-demotion-failed",
        orgId,
        err: err instanceof Error ? err : String(err),
      });
    }
  }

  logEvent("info", {
    component: "well-known",
    event: "stub-demotion-scan-complete",
    scanned: candidateIds.length,
    demoted,
    stampsCleared,
  });

  return { scanned: candidateIds.length, demoted, stampsCleared };
}

/**
 * Clear `release_locations.source_id` on any live locator row for this org
 * whose stamped source no longer exists live (soft-deleted, or hard-deleted
 * so no row remains at all — the FK's `ON DELETE SET NULL` already handles
 * that case, but a soft-deleted source row still exists and needs an
 * explicit clear). The locator rows themselves are never touched otherwise.
 * Returns the number of rows cleared.
 */
async function clearDeadLocatorStamps(db: D1Db, orgId: string): Promise<number> {
  const stampedLocators = await db
    .select({ id: releaseLocations.id, sourceId: releaseLocations.sourceId })
    .from(releaseLocations)
    .where(
      and(
        eq(releaseLocations.orgId, orgId),
        isNull(releaseLocations.deletedAt),
        // sourceId IS NOT NULL, expressed via inArray-safe predicate below.
      ),
    );
  const stamped = stampedLocators.filter(
    (l): l is { id: string; sourceId: string } => l.sourceId !== null,
  );
  if (stamped.length === 0) return 0;

  const stampedSourceIds = [...new Set(stamped.map((l) => l.sourceId))];
  const liveSourceIds = new Set<string>();
  for (let i = 0; i < stampedSourceIds.length; i += IN_ARRAY_CHUNK_SIZE) {
    const chunk = stampedSourceIds.slice(i, i + IN_ARRAY_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- chunked IN lookup (90-id D1 limit)
    const rows = await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(inArray(sources.id, chunk), isNull(sources.deletedAt)));
    for (const r of rows) liveSourceIds.add(r.id);
  }

  const deadLocatorIds = stamped.filter((l) => !liveSourceIds.has(l.sourceId)).map((l) => l.id);
  if (deadLocatorIds.length === 0) return 0;

  for (let i = 0; i < deadLocatorIds.length; i += IN_ARRAY_CHUNK_SIZE) {
    const chunk = deadLocatorIds.slice(i, i + IN_ARRAY_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- chunked update (90-id D1 limit)
    await db
      .update(releaseLocations)
      .set({ sourceId: null, updatedAt: new Date().toISOString() })
      .where(inArray(releaseLocations.id, chunk));
  }

  return deadLocatorIds.length;
}
