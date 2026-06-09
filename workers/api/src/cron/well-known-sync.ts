import { isNull, eq, and, or, lt, sql, asc } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import { logEvent } from "@releases/lib/log-event";
import { syncOrgWellKnown } from "../lib/well-known/reconcile-org.js";
import { syncSourceRepo } from "../lib/well-known/reconcile-source.js";

export interface WellKnownSyncEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  MEDIA_ORIGIN?: string;
  CRON_ENABLED?: string;
  /**
   * Re-check interval, in hours. An entity swept more recently than this is
   * skipped (due-filter); NULL/never-swept entities are always due and sorted
   * first. Default 168 (7 days) — the owner file changes rarely, so a daily
   * re-fetch of every entity is wasteful, and a 7-day cadence lets the per-run
   * cap cover a large corpus across runs. Floor of 1h; invalid → default.
   */
  WELL_KNOWN_SWEEP_INTERVAL_HOURS?: string;
  /**
   * Hard cap on entities processed per pass per run, oldest-swept-first. Bounds
   * outbound subrequests against Cloudflare's 1000-per-invocation ceiling: the
   * org pass costs 1–2 subrequests each (file + optional avatar mirror) and the
   * source pass 1 each, so the worst case is `cap * 2 + cap = cap * 3`. Default
   * 250 → ≤750 subrequests, comfortably under the ceiling. Floor of 1; invalid
   * → default. Deferred work is logged, never silently dropped, and is the
   * oldest, so it's picked up first on the next run.
   */
  WELL_KNOWN_MAX_PER_RUN?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: ReturnType<typeof createDb>;
  /** TEST-ONLY: inject fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_INTERVAL_HOURS = 168; // 7 days
const DEFAULT_MAX_PER_RUN = 250;

type Db = ReturnType<typeof createDb>;

function positiveIntOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * Stamp `metadata.wellKnownSweptAt` on a row via `json_set`, which patches only
 * that one key (NULL metadata coalesces to `{}` first). This runs after the
 * reconciler returns — on EVERY outcome (applied, unchanged, fetch-skipped, or
 * errored) — so it is the due-filter clock, distinct from the reconciler's
 * `metadata.selfDeclared.syncedAt` which only advances on a successful apply.
 * Using `json_set` (not a read-modify-write) means it can't clobber the
 * reconciler's concurrent metadata write earlier in the same iteration.
 */
async function stampSwept(
  db: Db,
  table: typeof organizations | typeof sources,
  id: string,
  iso: string,
): Promise<void> {
  await db
    .update(table)
    .set({
      metadata: sql`json_set(coalesce(${table.metadata}, '{}'), '$.wellKnownSweptAt', ${iso})`,
    })
    .where(eq(table.id, id));
}

export async function wellKnownSync(env: WellKnownSyncEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "well-known", event: "cron-disabled" });
    return;
  }
  const db = env._drizzleOverride ?? createDb(env.DB);
  const mediaOrigin = env.MEDIA_ORIGIN ?? "https://media.releases.sh";

  const intervalHours = positiveIntOr(env.WELL_KNOWN_SWEEP_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS);
  const maxPerRun = positiveIntOr(env.WELL_KNOWN_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);
  const now = new Date();
  const cutoff = new Date(now.getTime() - intervalHours * 3600_000).toISOString();

  let orgApplied = 0;
  let sourceApplied = 0;

  // Pass 1: org identity from domain .well-known files. Due-filter on
  // metadata.wellKnownSweptAt (never-swept rows are NULL → always due), cap at
  // maxPerRun, oldest-first so every org is eventually covered across runs.
  const orgSweptAt = sql<
    string | null
  >`json_extract(${organizations.metadata}, '$.wellKnownSweptAt')`;
  const orgs = await db
    .select({ id: organizations.id, domain: organizations.domain })
    .from(organizations)
    .where(
      and(
        eq(organizations.fetchPaused, false),
        isNull(organizations.deletedAt),
        or(sql`${orgSweptAt} IS NULL`, lt(orgSweptAt, cutoff)),
      ),
    )
    .orderBy(asc(orgSweptAt))
    .limit(maxPerRun);
  for (const o of orgs) {
    if (!o.domain) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-org to avoid concurrent R2 + D1 pressure on the cron budget
      const r = await syncOrgWellKnown(db, o.id, {
        bucket: env.MEDIA,
        mediaOrigin,
        domain: o.domain,
        fetchImpl: env.fetchImpl,
      });
      if (r.applied) orgApplied++;
    } catch (err) {
      logEvent("error", {
        component: "well-known",
        event: "org-sync-failed",
        orgId: o.id,
        err: err instanceof Error ? err : String(err),
      });
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- advance the due-filter clock per row regardless of outcome
      await stampSwept(db, organizations, o.id, now.toISOString());
    } catch (err) {
      logEvent("warn", {
        component: "well-known",
        event: "org-stamp-failed",
        orgId: o.id,
        err: err instanceof Error ? err : String(err),
      });
    }
  }

  // Pass 2: source→product mapping from repo-root releases.json files. Join the
  // org so a github source under a paused/deleted org is skipped too — mirrors
  // Pass 1's org predicates. (Org soft-delete already cascades deletedAt to its
  // sources, so the org deletedAt check is belt-and-suspenders against a cascade
  // gap; the fetchPaused check is the one Pass 2 would otherwise miss.) Same
  // due-filter + cap + oldest-first ordering as Pass 1.
  const srcSweptAt = sql<string | null>`json_extract(${sources.metadata}, '$.wellKnownSweptAt')`;
  const ghSources = await db
    .select({ id: sources.id })
    .from(sources)
    .innerJoin(organizations, eq(sources.orgId, organizations.id))
    .where(
      and(
        eq(sources.type, "github"),
        isNull(sources.deletedAt),
        eq(organizations.fetchPaused, false),
        isNull(organizations.deletedAt),
        or(sql`${srcSweptAt} IS NULL`, lt(srcSweptAt, cutoff)),
      ),
    )
    .orderBy(asc(srcSweptAt))
    .limit(maxPerRun);
  for (const s of ghSources) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-source to avoid concurrent GitHub raw-content fetch pressure
      const r = await syncSourceRepo(db, s.id, { fetchImpl: env.fetchImpl });
      if (r.applied) sourceApplied++;
    } catch (err) {
      logEvent("error", {
        component: "well-known",
        event: "source-sync-failed",
        sourceId: s.id,
        err: err instanceof Error ? err : String(err),
      });
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- advance the due-filter clock per row regardless of outcome
      await stampSwept(db, sources, s.id, now.toISOString());
    } catch (err) {
      logEvent("warn", {
        component: "well-known",
        event: "source-stamp-failed",
        sourceId: s.id,
        err: err instanceof Error ? err : String(err),
      });
    }
  }

  // Surface when a pass hit its cap so a backlog is visible in logs rather than
  // a silent truncation (the deferred rows are the oldest, so they lead the
  // next run). orgCapped/sourceCapped true ⇒ there may be more due than the cap.
  logEvent("info", {
    component: "well-known",
    event: "sweep-done",
    orgApplied,
    sourceApplied,
    orgProcessed: orgs.length,
    sourceProcessed: ghSources.length,
    orgCapped: orgs.length >= maxPerRun,
    sourceCapped: ghSources.length >= maxPerRun,
    maxPerRun,
    intervalHours,
  });
}
