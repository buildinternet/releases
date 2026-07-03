import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { createDb } from "../db.js";
import { fetchLog, sources } from "@buildinternet/releases-core/schema";
import { buildBareLimitEnvelope } from "../lib/pagination.js";
import { getStatusHub, sourceMatchByIdOrSlug } from "../utils.js";
import { getActiveFetchSession } from "../lib/active-fetch-session.js";
import { classifyDbError, dbErrorToWireCode } from "@releases/lib/db-errors";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError, InternalError } from "@releases/lib/releases-error";

export const fetchLogRoutes = new Hono<Env>();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ── Auto-backoff for non-converging scrape/agent fetches (#1851) ──────────
//
// The scrape/agent extraction path (discovery worker) is the only writer of
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
const MAX_BACKOFF_HOURS = 72;
// After this many consecutive deterministic failures (~2^(n-1) ≈ 63h of retries
// with the exponential ladder), pause the source so it stops spending and
// surfaces for review rather than retrying indefinitely.
const AUTO_PAUSE_AFTER_ERRORS = 6;

// ── Auto-pause for non-converging *no-op* drains (#1862) ──────────────────
//
// The #1851 backoff above only catches HARD failures (model/bot_challenge). A
// source whose drain SUCCEEDS but finds nothing new — the extraction runs, the
// change-detector had flagged it, yet 0 releases parse — is written back as
// fully healthy (`updateSourceAfterFetch` resets every counter), so nothing
// ever accumulates. Combined with the change-detector re-flagging it each poll,
// such a source re-drained a no-op Haiku /update forever (once/day after the
// #1862 cooldown, but still indefinitely). We count consecutive *flagged-but-
// empty* drains and pause the source once it's clearly non-converging, so it
// surfaces for curator review (SPA shell, moved changelog, dead source) rather
// than draining to infinity. A productive drain (>=1 inserted) resets the count.
const UNPRODUCTIVE_DRAIN_PAUSE_AFTER = 5;

/**
 * Whether a recorded fetch outcome is a deterministic, non-self-resolving
 * failure that warrants error backoff. Pure so it can be unit-tested without a
 * DB. `errorCategory` comes from the discovery worker's `CategorizedError`.
 */
export function shouldBackoffScrapeFailure(errorCategory: unknown): boolean {
  return typeof errorCategory === "string" && BACKOFF_ERROR_CATEGORIES.has(errorCategory);
}

/**
 * Exponential backoff for the Nth consecutive error, capped, matching the
 * feed/GitHub poll path (`cron/poll-fetch.ts`). Returns the delay in hours.
 */
export function failureBackoffHours(consecutiveErrors: number): number {
  return Math.min(Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_HOURS);
}

async function applyScrapeFailureBackoff(
  db: ReturnType<typeof createDb>,
  sourceId: string,
): Promise<void> {
  const [src] = await db
    .select({ consecutiveErrors: sources.consecutiveErrors, fetchPriority: sources.fetchPriority })
    .from(sources)
    .where(eq(sources.id, sourceId));
  if (!src) return;

  const newErrors = (src.consecutiveErrors ?? 0) + 1;
  const backoffHours = failureBackoffHours(newErrors);
  const nextFetchAfter = new Date(Date.now() + backoffHours * 3600_000).toISOString();
  const shouldPause = newErrors >= AUTO_PAUSE_AFTER_ERRORS && src.fetchPriority !== "paused";

  await db
    .update(sources)
    .set({
      consecutiveErrors: newErrors,
      nextFetchAfter,
      ...(shouldPause ? { fetchPriority: "paused" as const } : {}),
    })
    .where(eq(sources.id, sourceId))
    .catch(() => {});

  logEvent(shouldPause ? "warn" : "info", {
    component: "fetch-log",
    event: shouldPause ? "source-auto-paused" : "scrape-failure-backoff",
    sourceId,
    consecutiveErrors: newErrors,
    backoffHours,
    paused: shouldPause,
  });
}

/**
 * Track consecutive flagged-but-empty drains and auto-pause a non-converging
 * source (#1862). Only invoked when the fetch reported `wasFlagged` (the source
 * was flagged as changed when the drain began) — a legitimately-quiet poll that
 * was never flagged is not counted, so healthy idle sources are never paused.
 * A productive drain (`releasesInserted > 0`) resets the streak; an empty one
 * increments it and pauses at UNPRODUCTIVE_DRAIN_PAUSE_AFTER. Best-effort.
 */
async function applyDrainConvergence(
  db: ReturnType<typeof createDb>,
  sourceId: string,
  releasesInserted: number,
): Promise<void> {
  if (releasesInserted > 0) {
    // Productive drain — the source converged. Clear any accumulated streak.
    await db
      .update(sources)
      .set({ unproductiveDrains: 0 })
      .where(eq(sources.id, sourceId))
      .catch(() => {});
    return;
  }

  const [src] = await db
    .select({
      unproductiveDrains: sources.unproductiveDrains,
      fetchPriority: sources.fetchPriority,
    })
    .from(sources)
    .where(eq(sources.id, sourceId));
  if (!src) return;

  const newStreak = (src.unproductiveDrains ?? 0) + 1;
  const shouldPause = newStreak >= UNPRODUCTIVE_DRAIN_PAUSE_AFTER && src.fetchPriority !== "paused";

  await db
    .update(sources)
    .set({
      unproductiveDrains: newStreak,
      ...(shouldPause ? { fetchPriority: "paused" as const } : {}),
    })
    .where(eq(sources.id, sourceId))
    .catch(() => {});

  logEvent(shouldPause ? "warn" : "info", {
    component: "fetch-log",
    event: shouldPause ? "source-auto-paused-unproductive" : "drain-unproductive",
    sourceId,
    unproductiveDrains: newStreak,
    paused: shouldPause,
  });
}

fetchLogRoutes.get("/admin/logs/fetch", async (c) => {
  const db = createDb(c.env.DB);
  const sourceSlug = c.req.query("source");
  const rawLimit = parseInt(c.req.query("limit") ?? String(DEFAULT_LIMIT), 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  const wantsEnvelope = c.req.query("envelope") === "true";

  if (sourceSlug) {
    const [src] = await db.select().from(sources).where(sourceMatchByIdOrSlug(sourceSlug));
    if (!src) return respondError(c, new NotFoundError("Source not found"));

    const logs = await db
      .select()
      .from(fetchLog)
      .where(eq(fetchLog.sourceId, src.id))
      .orderBy(desc(fetchLog.createdAt))
      .limit(limit);
    if (!wantsEnvelope) return c.json(logs);
    // Overlay the live in-flight fetch (#1360). fetch_log only records terminal
    // states, so during a multi-minute crawl the history above shows nothing
    // newer; `activeSession` lets a single enveloped poll tell "still running"
    // from "stuck/dead". Bare-array form (above) stays unchanged for back-compat.
    const activeSession = await getActiveFetchSession(getStatusHub(c.env), src.slug);
    return c.json({ ...buildBareLimitEnvelope(logs, limit), activeSession });
  }

  const logs = await db.select().from(fetchLog).orderBy(desc(fetchLog.createdAt)).limit(limit);
  return wantsEnvelope ? c.json(buildBareLimitEnvelope(logs, limit)) : c.json(logs);
});

fetchLogRoutes.post("/admin/logs/fetch", async (c) => {
  const db = createDb(c.env.DB);
  // `wasFlagged` is a transport-only convergence signal (#1862), not a fetch_log
  // column — strip it so the insert doesn't fail on an unknown column.
  const { wasFlagged, ...body } = await c.req.json();

  let inserted;
  try {
    [inserted] = await db.insert(fetchLog).values(body).returning();
  } catch (err) {
    const classified = classifyDbError(err);
    return respondError(
      c,
      new InternalError("Failed to insert fetch log", {
        code: classified ? dbErrorToWireCode(classified.code) : "internal_error",
        ...(classified
          ? { details: { dbCode: classified.code, transient: classified.transient } }
          : {}),
      }),
    );
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

  // Auto-pause a source whose flagged drains keep coming back empty (#1862).
  // Only when the drain reported `wasFlagged` — a never-flagged poll finding
  // nothing is normal and must not count toward a pause.
  if (body.sourceId && wasFlagged === true) {
    try {
      await applyDrainConvergence(db, body.sourceId, Number(body.releasesInserted ?? 0));
    } catch {
      // convergence pause is best-effort
    }
  }

  // Best-effort notify StatusHub for live dashboard
  if (c.env.STATUS_HUB) {
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

      const id = c.env.STATUS_HUB.idFromName("global");
      const stub = c.env.STATUS_HUB.get(id);
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

  return c.json(inserted, 201);
});
