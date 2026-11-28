/**
 * Shared fetch-log ingest core, extracted from the `POST /admin/logs/fetch`
 * handler (#1946) so the D1 persister can call it in-process without going
 * through HTTP.
 *
 * `ingestFetchLog` runs, in order: the fetch_log insert (throws on failure,
 * matching the route's existing 500 behavior), the #1851 scrape-failure
 * backoff/auto-pause, the #1862 drain-convergence streak, and a
 * best-effort StatusHub notify. All side effects after the insert are
 * best-effort — they never fail the log write.
 *
 * Auth + body parsing (including the `wasFlagged` transport-only strip) stay
 * in the route handler — HTTP boundary concerns a future in-process caller
 * won't have.
 */
import { eq } from "drizzle-orm";
import {
  fetchLog,
  sources,
  type FetchLog,
  type NewFetchLog,
} from "@buildinternet/releases-core/schema";
import type { D1Db } from "../../db.js";
import { classifyDbError, dbErrorToWireCode } from "@releases/lib/db-errors";
import { logEvent } from "@releases/lib/log-event";
import { InternalError } from "@releases/lib/releases-error";
import {
  AUTO_PAUSE_AFTER_ERRORS,
  UNPRODUCTIVE_DRAIN_PAUSE_AFTER,
  bumpSourceCounter,
  failureBackoffHours,
  recordConsecutiveFetchError,
  resetUnproductiveDrains,
} from "./source-fetch-health.js";

export { failureBackoffHours };

// ── Auto-backoff for non-converging scrape/agent fetches (#1851) ──────────
//
// The scrape/agent extraction path (`DeterministicUpdateWorkflow`) is the only writer of
// this endpoint. Unlike the feed/GitHub poll path (`cron/poll-fetch.ts`), it
// never bumped `sources.consecutive_errors` or set `next_fetch_after` on
// failure — so a source whose extraction deterministically fails (e.g. a crawl
// body that maxes the output-token cap → 0 entries committed → content hash
// never advances → source stays "stale") was re-dispatched by the SourceActor
// at full tier cadence forever, re-billing an Anthropic extraction every cycle.
//
// We apply the same exponential ladder poll-fetch uses, but only for
// *deterministic, non-self-resolving* failures — a maxed-out extraction
// (`model`) or an anti-bot interstitial our renderer can't clear
// (`bot_challenge`). Transient infra blips are intentionally excluded so a
// healthy source isn't throttled/paused by a one-off render failure (mirrors
// poll-fetch's transient-error carve-out). A success resets
// `consecutive_errors` to 0 and clears `next_fetch_after` via
// `updateSourceAfterFetch`, so this self-heals the moment extraction recovers.

const BACKOFF_ERROR_CATEGORIES = new Set(["model", "bot_challenge"]);
// After AUTO_PAUSE_AFTER_ERRORS consecutive deterministic failures (~2^(n-1)
// hours of retries on the exponential ladder), pause the source so it stops
// spending and surfaces for review rather than retrying indefinitely.

// ── Auto-pause for non-converging *empty* drains (#1862) ──────────────────
//
// The #1851 backoff above only catches HARD failures (model/bot_challenge). A
// source whose drain succeeds but extracts nothing — the change-detector had
// flagged it, yet the page yields 0 items (SPA shell, moved changelog, dead
// source) — is written back as healthy, so nothing ever accumulates. We count
// consecutive *flagged drains that found 0 items* and pause once that streak
// hits UNPRODUCTIVE_DRAIN_PAUSE_AFTER.
//
// A drain that re-finds the existing releases (found > 0, inserted 0) is a
// healthy "nothing new" and is not a strike. Any fetch that inserts at least
// one release resets the streak, whether or not that fetch was flagged.

/**
 * Whether a recorded fetch outcome is a deterministic, non-self-resolving
 * failure that warrants error backoff. Pure so it can be unit-tested without a
 * DB. `errorCategory` comes from the extraction path's `CategorizedError`.
 */
export function shouldBackoffScrapeFailure(errorCategory: unknown): boolean {
  return typeof errorCategory === "string" && BACKOFF_ERROR_CATEGORIES.has(errorCategory);
}

function countOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * What a recorded fetch does to the unproductive-drain streak.
 *
 * - `reset`: the fetch inserted at least one release. Clears the streak
 *   whether or not the fetch was flagged.
 * - `strike`: a flagged drain whose extraction found 0 items. Five of these
 *   in a row pause the source.
 * - `neutral`: everything else, including a flagged drain that re-found the
 *   existing releases and inserted nothing. The streak is left as it is.
 */
export function drainConvergenceAction(input: {
  wasFlagged: boolean;
  releasesFound: number;
  releasesInserted: number;
}): "reset" | "strike" | "neutral" {
  if (input.releasesInserted > 0) return "reset";
  if (input.wasFlagged && input.releasesFound === 0) return "strike";
  return "neutral";
}

async function applyScrapeFailureBackoff(db: D1Db, sourceId: string): Promise<void> {
  const bumped = await recordConsecutiveFetchError(db, sourceId, {
    pauseAt: AUTO_PAUSE_AFTER_ERRORS,
    pauseReason: "extraction_errors",
  });
  if (!bumped) return;

  logEvent(bumped.didPause ? "warn" : "info", {
    component: "fetch-log",
    event: bumped.didPause ? "source-auto-paused" : "scrape-failure-backoff",
    sourceId,
    consecutiveErrors: bumped.value,
    backoffHours: failureBackoffHours(bumped.value),
    paused: bumped.didPause,
  });
}

/**
 * Count one flagged drain that extracted 0 items, and pause at the threshold
 * (#1862). The caller has already decided this fetch is a strike.
 * Un-pausing (source PATCH moving `fetchPriority` off `paused`) zeroes the
 * streak (#2550) — this function does not, so a stale count re-pauses
 * immediately. Best-effort.
 */
async function recordUnproductiveDrain(db: D1Db, sourceId: string): Promise<void> {
  const bumped = await bumpSourceCounter(db, sourceId, "unproductiveDrains", {
    pauseAt: UNPRODUCTIVE_DRAIN_PAUSE_AFTER,
    pauseReason: "unproductive_drains",
  });
  if (!bumped) return;

  logEvent(bumped.didPause ? "warn" : "info", {
    component: "fetch-log",
    event: bumped.didPause ? "source-auto-paused-unproductive" : "drain-unproductive",
    sourceId,
    unproductiveDrains: bumped.value,
    paused: bumped.didPause,
    ...(bumped.didPause ? { pausedReason: "unproductive_drains" } : {}),
  });
}

export interface FetchLogWriteInput {
  sourceId: string | null;
  sessionId: string | null;
  releasesFound: number;
  releasesInserted: number;
  durationMs: number;
  status: string;
  error: string | null;
  errorCategory: string | null;
  /** Transport-only convergence signal (#1862) — stripped before insert, drives `applyDrainConvergence`. */
  wasFlagged?: boolean;
}

/** Env slice used by `ingestFetchLog` — just the StatusHub DO binding. */
export interface FetchLogEnv {
  STATUS_HUB?: DurableObjectNamespace;
}

/**
 * fetch_log insert + backoff/auto-pause + #1862 drain convergence + StatusHub
 * notify, in that order, matching the route's best-effort semantics. Throws
 * only if the fetch_log INSERT itself fails.
 */
export async function ingestFetchLog(
  db: D1Db,
  env: FetchLogEnv,
  input: FetchLogWriteInput,
): Promise<FetchLog> {
  const { wasFlagged, ...body } = input;

  let inserted;
  try {
    // Cast: `body` is loosely typed at the HTTP boundary (the route's request
    // contract, not a runtime guarantee) the same way the pre-extraction
    // handler passed the parsed JSON body straight to `.values()` untyped.
    [inserted] = await db
      .insert(fetchLog)
      .values(body as unknown as NewFetchLog)
      .returning();
  } catch (err) {
    const classified = classifyDbError(err);
    throw new InternalError("Failed to insert fetch log", {
      cause: err,
      code: classified ? dbErrorToWireCode(classified.code) : "internal_error",
      ...(classified
        ? { details: { dbCode: classified.code, transient: classified.transient } }
        : {}),
    });
  }

  // Throttle sources whose scrape/agent extraction deterministically fails so
  // the SourceActor stops re-billing them every cycle (#1851). Best-effort —
  // never fail the log write over a scheduling side-effect.
  if (body.sourceId && shouldBackoffScrapeFailure(body.errorCategory)) {
    try {
      await applyScrapeFailureBackoff(db, body.sourceId);
    } catch {
      // scheduling backoff is best-effort
    }
  }

  // Unproductive-drain streak (#1862). A strike is a flagged drain that
  // extracted 0 items. Re-finding existing releases is neutral. Any insert
  // resets the streak, flagged or not — including a fetch that was not itself
  // a drain.
  if (body.sourceId) {
    const action = drainConvergenceAction({
      wasFlagged: wasFlagged === true,
      releasesFound: countOf(body.releasesFound),
      releasesInserted: countOf(body.releasesInserted),
    });
    try {
      if (action === "reset") await resetUnproductiveDrains(db, body.sourceId);
      else if (action === "strike") await recordUnproductiveDrain(db, body.sourceId);
    } catch {
      // convergence pause is best-effort
    }
  }

  // Best-effort notify StatusHub for live dashboard
  if (env.STATUS_HUB) {
    try {
      // Resolve source name for the dashboard display
      let sourceName: string | undefined;
      let sourceSlug: string | undefined;
      if (body.sourceId) {
        const [src] = await db
          .select({ name: sources.name, slug: sources.slug })
          .from(sources)
          .where(eq(sources.id, body.sourceId));
        sourceName = src?.name;
        sourceSlug = src?.slug;
      }

      const id = env.STATUS_HUB.idFromName("global");
      const stub = env.STATUS_HUB.get(id);
      await stub.fetch(
        new Request("https://do/event", {
          method: "POST",
          body: JSON.stringify({
            type: "fetch:complete",
            id: inserted.id,
            sourceId: body.sourceId,
            sessionId: body.sessionId ?? null,
            sourceName,
            sourceSlug,
            releasesFound: body.releasesFound,
            releasesInserted: body.releasesInserted,
            durationMs: body.durationMs,
            status: body.status,
            error: body.error,
            createdAt: inserted.createdAt,
          }),
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch {
      // Dashboard notification is best-effort
    }
  }

  return inserted;
}
