/**
 * Source fetch-health transitions.
 *
 * `consecutive_errors`, `consecutive_no_change`, and `unproductive_drains`
 * are one counter each, written from poll-fetch, fetch-log ingest, and the
 * Firecrawl workflow. A read-modify-write from a row loaded at the start of
 * a run loses increments when two runs overlap, and a stale write can put
 * backoff (or an auto-pause) back onto a source that has since recovered.
 *
 * Each bump is a single UPDATE. SQLite evaluates the right-hand side against
 * the pre-update row, so overlapping bumps each add one, and the backoff
 * deadline is computed from that same pre-update count.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../../db.js";

/** Pause a scrape/agent source after this many consecutive deterministic failures. */
export const AUTO_PAUSE_AFTER_ERRORS = 6;
/** Pause a source after this many flagged drains that insert nothing. */
export const UNPRODUCTIVE_DRAIN_PAUSE_AFTER = 5;
export const ERROR_BACKOFF_CAP_HOURS = 72;
export const NO_CHANGE_BACKOFF_CAP_HOURS = 48;

type CounterName = "consecutiveErrors" | "consecutiveNoChange" | "unproductiveDrains";
type CounterColumn = (typeof sources)[CounterName];

export interface SourceCounterBump {
  value: number;
  fetchPriority: string | null;
  nextFetchAfter: string | null;
  /** True only when this write changed `fetch_priority` to `paused`. */
  didPause: boolean;
}

export interface BumpSourceCounterOpts {
  /** Pause when this bump crosses `pauseAt` and the source is not already paused. */
  pauseAt?: number;
  /** Set `next_fetch_after` from the pre-update count, capped at this many hours. */
  backoffCapHours?: typeof ERROR_BACKOFF_CAP_HOURS | typeof NO_CHANGE_BACKOFF_CAP_HOURS;
  /** ISO timestamp. `next_fetch_after` is at least this far out (Retry-After). */
  backoffFloorIso?: string;
  extra?: {
    consecutiveErrors?: number | null;
    consecutiveNoChange?: number | null;
    changeDetectedAt?: string | null;
    lastFetchedAt?: string | null;
    metadata?: SQL | string | null;
  };
}

/** Hours of backoff for the Nth consecutive hit (1-indexed), capped. */
export function failureBackoffHours(count: number, capHours = ERROR_BACKOFF_CAP_HOURS): number {
  return Math.min(Math.pow(2, count - 1), capHours);
}

function hoursCase(col: CounterColumn, capHours: 48 | 72): SQL {
  // Pre-update count `prior` backs off by failureBackoffHours(prior + 1).
  // The first count whose delay is already the cap, and everything above it,
  // is the ELSE arm, so this ladder cannot drift from the JS helper.
  const arms: SQL[] = [];
  for (let prior = 0; prior < 16; prior++) {
    const hours = failureBackoffHours(prior + 1, capHours);
    if (hours >= capHours) break;
    arms.push(sql`WHEN ${prior} THEN ${hours}`);
  }
  return sql`CASE COALESCE(${col}, 0) ${sql.join(arms, sql` `)} ELSE ${capHours} END`;
}

function nextFetchAfterSql(col: CounterColumn, capHours: 48 | 72, floorIso?: string): SQL {
  const at = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || (${hoursCase(col, capHours)}) || ' hours')`;
  return floorIso ? sql`max(${floorIso}, ${at})` : at;
}

function pauseSql(col: CounterColumn, pauseAt: number): SQL {
  return sql`CASE WHEN COALESCE(${col}, 0) >= ${pauseAt - 1} AND COALESCE(${sources.fetchPriority}, 'normal') != 'paused' THEN 'paused' ELSE ${sources.fetchPriority} END`;
}

function counterColumn(name: CounterName) {
  return sources[name];
}

/**
 * UPDATE that increments `name`. Not awaited — callers that already batch a
 * fetch_log insert with the bookkeeping pass the builder to `db.batch`.
 */
export function bumpSourceCounterQuery(
  db: D1Db,
  sourceId: string,
  name: CounterName,
  opts: BumpSourceCounterOpts = {},
) {
  const col = counterColumn(name);
  const set: {
    consecutiveErrors?: SQL | number | null;
    consecutiveNoChange?: SQL | number | null;
    unproductiveDrains?: SQL | number | null;
    fetchPriority?: SQL;
    nextFetchAfter?: SQL | string | null;
    changeDetectedAt?: string | null;
    lastFetchedAt?: string | null;
    metadata?: SQL | string | null;
  } = {
    [name]: sql`COALESCE(${col}, 0) + 1`,
  };
  if (opts.pauseAt != null) set.fetchPriority = pauseSql(col, opts.pauseAt);
  if (opts.backoffCapHours != null) {
    set.nextFetchAfter = nextFetchAfterSql(col, opts.backoffCapHours, opts.backoffFloorIso);
  }
  if (opts.extra) Object.assign(set, opts.extra);
  return db.update(sources).set(set).where(eq(sources.id, sourceId)).returning({
    value: col,
    fetchPriority: sources.fetchPriority,
    nextFetchAfter: sources.nextFetchAfter,
  });
}

export async function bumpSourceCounter(
  db: D1Db,
  sourceId: string,
  name: CounterName,
  opts: BumpSourceCounterOpts = {},
): Promise<SourceCounterBump | null> {
  // One batch, so the priority we read is the priority this UPDATE saw.
  // `didPause` is that transition, not a guess from the post-update row
  // (a source that was already paused, or one re-paused above the threshold,
  // looks the same afterwards).
  const priorQuery = db
    .select({ fetchPriority: sources.fetchPriority })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);
  const [priorRows, updatedRows] = await db.batch([
    priorQuery,
    bumpSourceCounterQuery(db, sourceId, name, opts),
  ] as [typeof priorQuery, ReturnType<typeof bumpSourceCounterQuery>]);
  const row = updatedRows[0];
  if (!row || row.value == null) return null;
  const wasPaused = (priorRows[0]?.fetchPriority ?? "normal") === "paused";
  return {
    value: row.value,
    fetchPriority: row.fetchPriority,
    nextFetchAfter: row.nextFetchAfter,
    didPause: opts.pauseAt != null && !wasPaused && row.fetchPriority === "paused",
  };
}

/**
 * Increment `consecutive_errors` and push `next_fetch_after` out on the
 * exponential ladder (at least `retryAfterMs` when the upstream said so).
 * Pausing is opt-in: feed and GitHub poll errors must not pause, because a
 * success does not move `fetch_priority` back off `paused`. The scrape/agent
 * path passes `pauseAt`.
 */
export async function recordConsecutiveFetchError(
  db: D1Db,
  sourceId: string,
  opts?: { retryAfterMs?: number; pauseAt?: number },
): Promise<SourceCounterBump | null> {
  const retryAfterMs = opts?.retryAfterMs;
  return bumpSourceCounter(db, sourceId, "consecutiveErrors", {
    ...(opts?.pauseAt != null ? { pauseAt: opts.pauseAt } : {}),
    backoffCapHours: ERROR_BACKOFF_CAP_HOURS,
    backoffFloorIso:
      retryAfterMs != null && retryAfterMs > 0
        ? new Date(Date.now() + retryAfterMs).toISOString()
        : undefined,
  });
}
