/**
 * Push-fed staleness signal (#2381): flag push-fed sources
 * (`metadata.ingestMode: "push"`) that have quietly stopped receiving
 * pushes. These sources are fed directly by their publisher — typically
 * `actions/publish-changelog` POSTing to `POST /v1/sources/:id/releases/batch`
 * on every push — and have no local poll cadence, so they're excluded from
 * both the poll cron and the first-party staleness scan
 * ({@link locallyFetchedSql}). Nothing else notices when a publisher's
 * pipeline quietly breaks (a rotated/expired API token, a disabled workflow,
 * a `paths:` filter that no longer matches, a repo rename) — releases just
 * stop arriving.
 *
 * "Last activity" for a push-fed source is the later of `lastFetchedAt` (the
 * batch route stamps this on every successful push, including a no-op
 * re-run) and the newest non-suppressed release date — the same signal the
 * first-party scan uses. This matters in practice: a source that switched to
 * push-fed after a prior scrape era can carry a stale `lastFetchedAt` from
 * before the switch while still having recent release rows.
 *
 * The overdue window reuses the first-party scan's knobs
 * (`SOURCE_STALE_FLOOR_DAYS` / `SOURCE_STALE_MULTIPLIER`) — no new env var.
 * Unlike the first-party scan, a push-fed source with no established cadence
 * (`medianGapDays == null`, e.g. new or sparse) is NOT skipped: a broken
 * pipeline on a new source still matters, so it falls back to a fixed
 * {@link NO_CADENCE_WINDOW_DAYS}-day window instead.
 *
 * Emits warn-level events on the `push-staleness` component; the daily
 * {@link sendStalenessDigest} cron rolls this into the operator digest under
 * its own "No pushes lately" section.
 */
import { createDb } from "../db.js";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { pushFedSql } from "../queries/source-fetch-routing.js";
import { parsePositiveInt } from "./feed-enrich.js";
import {
  DEFAULT_FLOOR_DAYS as SOURCE_STALE_DEFAULT_FLOOR_DAYS,
  DEFAULT_MULTIPLIER as SOURCE_STALE_DEFAULT_MULTIPLIER,
  newestReleaseSql,
} from "./source-staleness.js";

export interface PushStalenessEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  /** Same knob the first-party scan uses (default 14). No push-specific env var. */
  SOURCE_STALE_FLOOR_DAYS?: string;
  /** Same knob the first-party scan uses (default 3). No push-specific env var. */
  SOURCE_STALE_MULTIPLIER?: string;
  /** TEST-ONLY: bypass createDb(env.DB) and use the provided instance directly. */
  _drizzleOverride?: unknown;
}

/** Window (days) for a push-fed source with no established cadence; see the file header. */
export const NO_CADENCE_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** One push-fed source flagged as overdue during {@link scanStalePushFedSources}. */
export type PushStaleEntry = {
  sourceId: string;
  slug: string;
  orgSlug: string | null;
  orgName: string | null;
  medianGapDays: number | null;
  windowDays: number;
  daysSinceActivity: number;
  lastActivityAt: string;
};

export type PushStalenessScanResult = {
  scanned: number;
  stale: number;
  entries: PushStaleEntry[];
};

/**
 * Scan push-fed, non-deleted, non-hidden, non-paused sources and warn on any
 * whose last activity (max of `lastFetchedAt` and newest non-suppressed
 * release) is older than its overdue window. Returns counts and the flagged
 * rows for digest email / observability.
 */
export async function scanStalePushFedSources(
  env: PushStalenessEnv,
  now: Date = new Date(),
): Promise<PushStalenessScanResult> {
  if (env.CRON_ENABLED === "false") return { scanned: 0, stale: 0, entries: [] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as the sibling scans
  const db: any = env._drizzleOverride ?? createDb(env.DB);
  const floorDays = parsePositiveInt(env.SOURCE_STALE_FLOOR_DAYS, SOURCE_STALE_DEFAULT_FLOOR_DAYS);
  const multiplier = parsePositiveInt(env.SOURCE_STALE_MULTIPLIER, SOURCE_STALE_DEFAULT_MULTIPLIER);

  // One grouped aggregate: each eligible push-fed source plus the date of its
  // newest non-suppressed release. `MAX(CASE …)` ignores suppressed rows and
  // falls back to created_at when published_at is null, mirroring the
  // first-party scan. Eligibility (push-fed, not deleted, not hidden) is
  // filtered in SQL; the paused check runs in JS alongside everyone else.
  const rows: Array<{
    id: string;
    slug: string;
    orgId: string | null;
    orgSlug: string | null;
    orgName: string | null;
    medianGapDays: number | null;
    fetchPriority: string | null;
    lastFetchedAt: string | null;
    createdAt: string | null;
    newestRelease: string | null;
  }> = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      orgId: sources.orgId,
      orgSlug: organizations.slug,
      orgName: organizations.name,
      medianGapDays: sources.medianGapDays,
      fetchPriority: sources.fetchPriority,
      lastFetchedAt: sources.lastFetchedAt,
      createdAt: sources.createdAt,
      newestRelease: newestReleaseSql(),
    })
    .from(sources)
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .leftJoin(releases, eq(releases.sourceId, sources.id))
    .where(
      and(
        isNull(sources.deletedAt),
        // `is_hidden` is nullable on sources; NULL means visible.
        or(eq(sources.isHidden, false), isNull(sources.isHidden)),
        pushFedSql(sources.metadata),
      ),
    )
    .groupBy(sources.id);

  const entries: PushStaleEntry[] = [];
  for (const r of rows) {
    // Paused is an operator's explicit "stop caring" switch.
    if (r.fetchPriority === "paused") continue;

    const windowDays =
      r.medianGapDays != null
        ? Math.max(floorDays, r.medianGapDays * multiplier)
        : NO_CADENCE_WINDOW_DAYS;

    // Last activity = the later of lastFetchedAt and the newest non-suppressed
    // release, falling back to createdAt when neither is set.
    const lastActivity =
      [r.lastFetchedAt, r.newestRelease]
        .filter((v): v is string => !!v)
        .toSorted()
        .at(-1) ?? r.createdAt;
    if (!lastActivity) continue;

    const overdueCutoff = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
    if (lastActivity >= overdueCutoff) continue;

    const daysSince = Math.round((now.getTime() - new Date(lastActivity).getTime()) / DAY_MS);
    const roundedWindow = Math.round(windowDays);
    const entry: PushStaleEntry = {
      sourceId: r.id,
      slug: r.slug,
      orgSlug: r.orgSlug,
      orgName: r.orgName,
      medianGapDays: r.medianGapDays,
      windowDays: roundedWindow,
      daysSinceActivity: daysSince,
      lastActivityAt: lastActivity,
    };
    entries.push(entry);
    logEvent("warn", {
      component: "push-staleness",
      event: "stale-source",
      sourceId: r.id,
      slug: r.slug,
      orgId: r.orgId,
      medianGapDays: r.medianGapDays,
      windowDays: roundedWindow,
      daysSinceActivity: daysSince,
      lastActivityAt: lastActivity,
    });
  }

  entries.sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);

  const stale = entries.length;
  logEvent(stale > 0 ? "warn" : "info", {
    component: "push-staleness",
    event: "scan-complete",
    scanned: rows.length,
    stale,
  });
  return { scanned: rows.length, stale, entries };
}
