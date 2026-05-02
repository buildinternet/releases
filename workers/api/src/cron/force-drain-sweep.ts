/**
 * Daily force-drain cron for stranded scrape/agent sources (#518).
 *
 * Runs after the 01:00 UTC `scrape-agent-sweep`. Picks up the sources that
 * can't self-flag through the hourly poll's change-detector branch:
 *
 *   - `fetchQuirks.<slug>.changeDetector === 'unreliable'` — by definition
 *     the detector returns no signal; these must be swept on a cadence.
 *   - `last_fetched_at < now - FORCE_DRAIN_STALE_HOURS` (default 72h) —
 *     safety net for anything else that slips through.
 *
 * The cron itself doesn't dispatch sessions. It only sets
 * `changeDetectedAt = now` on the selected rows so the existing
 * `scrape-agent-sweep` picks them up on its next run (24h cadence — the
 * capped drain avoids flooding the managed-agent session budget).
 *
 * Gated behind `FORCE_DRAIN_CRON_ENABLED` (default off). When the flag is
 * on but the candidate set is empty the cron still writes a `cron_runs`
 * row with `notes='no stale/unreliable sources'` so the dashboard can
 * distinguish healthy-quiet from not-running.
 */

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import { loadFetchQuirks } from "@releases/ai-internal/playbook";
import { finalizeRunRow, insertRunningRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";
import { loadPlaybookNotesForSources } from "./poll-fetch.js";
import { logEvent } from "@releases/lib/log-event";

export const CRON_NAME = "force-drain-sweep";
export const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;
export const DEFAULT_FORCE_DRAIN_STALE_HOURS = 72;
export const DEFAULT_FORCE_SWEEP_MAX_SESSIONS = 10;

export type ForceDrainEnv = {
  DB: D1Database;
  CRON_ENABLED?: string;
  FORCE_DRAIN_CRON_ENABLED?: string;
  FORCE_DRAIN_STALE_HOURS?: string;
  FORCE_SWEEP_MAX_SESSIONS?: string;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: any;
};

export type Candidate = {
  id: string;
  slug: string;
  orgId: string | null;
  type: "scrape" | "agent";
  lastFetchedAt: string | null;
  /** Why this source was selected, used only for the cron_runs note. */
  reason: "unreliable" | "stale";
};

function parseHours(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_FORCE_DRAIN_STALE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FORCE_DRAIN_STALE_HOURS;
}

function parseCap(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_FORCE_SWEEP_MAX_SESSIONS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FORCE_SWEEP_MAX_SESSIONS;
}

/**
 * Pick the force-drain candidates for this sweep. Pure — no writes.
 *
 * Skips anything already flagged (`changeDetectedAt IS NOT NULL`) so we
 * don't double-flag; the scrape-agent-sweep will handle those on its
 * own cadence.
 */
export async function pickCandidates(
  db: any,
  params: { now: Date; staleHours: number; cap: number },
): Promise<{ candidates: Candidate[]; totalStranded: number }> {
  const staleCutoffIso = new Date(
    params.now.getTime() - params.staleHours * 3600_000,
  ).toISOString();

  const rows: Array<{
    id: string;
    slug: string;
    orgId: string | null;
    type: "scrape" | "agent";
    lastFetchedAt: string | null;
  }> = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      orgId: sources.orgId,
      type: sources.type,
      lastFetchedAt: sources.lastFetchedAt,
    })
    .from(sources)
    .where(
      and(
        inArray(sources.type, ["scrape", "agent"]),
        ne(sources.fetchPriority, "paused"),
        or(eq(sources.isHidden, false), isNull(sources.isHidden)),
        sql`(json_extract(${sources.metadata}, '$.feedUrl') IS NULL OR ${sources.metadata} IS NULL)`,
        isNull(sources.changeDetectedAt),
      ),
    );

  const playbookByOrg = await loadPlaybookNotesForSources(db, rows);

  const scored: Candidate[] = [];
  for (const r of rows) {
    const notes = r.orgId ? (playbookByOrg.get(r.orgId) ?? null) : null;
    const quirk = loadFetchQuirks(notes, r.slug);
    const isUnreliable = quirk?.changeDetector === "unreliable";
    const isStale = !r.lastFetchedAt || r.lastFetchedAt < staleCutoffIso;

    if (isUnreliable) {
      scored.push({ ...r, reason: "unreliable" });
    } else if (isStale) {
      scored.push({ ...r, reason: "stale" });
    }
  }

  // Oldest first — nulls sort before strings in JS, so this naturally
  // prioritizes never-fetched sources.
  scored.sort((a, b) => {
    const ax = a.lastFetchedAt ?? "";
    const bx = b.lastFetchedAt ?? "";
    return ax.localeCompare(bx);
  });

  return { candidates: scored.slice(0, params.cap), totalStranded: scored.length };
}

export async function forceDrainSweep(env: ForceDrainEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "force-drain-cron", event: "cron-disabled" });
    return;
  }
  if (env.FORCE_DRAIN_CRON_ENABLED !== "true") {
    logEvent("info", { component: "force-drain-cron", event: "force-drain-disabled" });
    return;
  }

  const db = env._drizzleOverride ?? drizzle(env.DB);
  const now = new Date();
  const staleHours = parseHours(env.FORCE_DRAIN_STALE_HOURS);
  const cap = parseCap(env.FORCE_SWEEP_MAX_SESSIONS);

  await reconcileStaleRunning(db, {
    cronName: CRON_NAME,
    now,
    thresholdMs: STALE_RUNNING_THRESHOLD_MS,
  });

  const runId = await insertRunningRow(db, { cronName: CRON_NAME, startedAt: now.toISOString() });

  const { candidates, totalStranded } = await pickCandidates(db, { now, staleHours, cap });

  // Flip `changeDetectedAt` on selected rows so the 01:00 scrape-agent-sweep
  // drains them tomorrow. Done in a single statement since `inArray` is cheap
  // and the list is capped at ≤ 10 by default.
  const nowIso = now.toISOString();
  if (candidates.length > 0) {
    await db
      .update(sources)
      .set({ changeDetectedAt: nowIso })
      .where(
        inArray(
          sources.id,
          candidates.map((c) => c.id),
        ),
      );
  }

  const unreliableCount = candidates.filter((c) => c.reason === "unreliable").length;
  const staleCount = candidates.filter((c) => c.reason === "stale").length;
  const skippedOverCap = Math.max(0, totalStranded - candidates.length);
  const notes =
    candidates.length === 0
      ? "no stale/unreliable sources"
      : `forced=${candidates.length} (unreliable=${unreliableCount}, stale=${staleCount}) stranded_total=${totalStranded}`;

  await finalizeRunRow(db, runId, {
    endedAt: new Date().toISOString(),
    status: "done",
    candidates: candidates.length,
    dispatched: candidates.length,
    skippedOverCap,
    dispatchErrors: 0,
    sessionsStarted: [],
    dispatchErrorDetail: [],
    notes,
  });

  logEvent("info", {
    component: "force-drain-cron",
    event: "done",
    forced: candidates.length,
    unreliable: unreliableCount,
    stale: staleCount,
    skipped: skippedOverCap,
  });
}

export type { Source };
