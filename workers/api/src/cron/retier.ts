import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import { sources, releases } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";

// Median gap thresholds in days. Sources with a median gap at or below
// NORMAL_MAX are retiered to "normal" (polled every 4h), between NORMAL_MAX
// and LOW_MAX to "low" (polled every 24h). Above LOW_MAX, current tier is
// preserved — this pass never auto-pauses, because manual and automatic
// pauses are indistinguishable on the current schema.
const NORMAL_MAX_DAYS = 14;
const LOW_MAX_DAYS = 90;

// Window of history used to measure cadence.
const LOOKBACK_DAYS = 180;

// Minimum releases in the lookback to produce a cadence signal. Sources
// below the threshold persist `medianGapDays = null` and are never
// retiered — brand-new sources keep whatever tier they were added with.
const MIN_RELEASES_FOR_SIGNAL = 3;

type FetchPriority = "normal" | "low" | "paused";

export async function retierSources(env: { DB: D1Database; CRON_ENABLED?: string }): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "retier", event: "cron-disabled" });
    return;
  }

  const db = drizzle(env.DB);
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();

  const recent = await db
    .select({ sourceId: releases.sourceId, publishedAt: releases.publishedAt })
    .from(releases)
    .where(
      sql`${releases.publishedAt} IS NOT NULL AND ${releases.publishedAt} >= ${cutoff} AND ${releases.suppressed} = 0`,
    );

  const datesBySource = new Map<string, string[]>();
  for (const r of recent) {
    if (!r.publishedAt) continue;
    const arr = datesBySource.get(r.sourceId) ?? [];
    arr.push(r.publishedAt);
    datesBySource.set(r.sourceId, arr);
  }

  // Pull every source, including paused ones — we persist cadence for all
  // so the dashboard can flag "this paused source still has a heartbeat."
  // Only non-paused sources are considered for tier changes below.
  const allSources = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      fetchPriority: sources.fetchPriority,
    })
    .from(sources);

  let retiered = 0;
  let withSignal = 0;
  // Build one UPDATE per source. Each statement binds at most 4 values
  // (id, medianGapDays, lastRetieredAt, optional fetchPriority), under
  // D1's 100-bind per-statement cap — chunk at 25 rows per db.batch() so
  // each chunk's ~100 binds stays a single round-trip.
  const writes = allSources.map((src) => {
    const dates = datesBySource.get(src.id) ?? [];
    const medianGap = dates.length >= MIN_RELEASES_FOR_SIGNAL ? computeMedianGapDays(dates) : null;
    if (medianGap != null) withSignal++;

    const current = src.fetchPriority as FetchPriority;
    const target =
      medianGap != null && current !== "paused" ? classifyTier(medianGap, current) : current;

    const updates: {
      fetchPriority?: FetchPriority;
      medianGapDays: number | null;
      lastRetieredAt: string;
    } = {
      medianGapDays: medianGap,
      lastRetieredAt: now,
    };
    if (target !== current) {
      updates.fetchPriority = target;
      logEvent("info", {
        component: "retier",
        event: "tier-changed",
        sourceSlug: src.slug,
        from: current,
        to: target,
        medianGapDays: medianGap!.toFixed(1),
        releaseCount: dates.length,
      });
      retiered++;
    }

    return db.update(sources).set(updates).where(eq(sources.id, src.id));
  });
  const RETIER_CHUNK_SIZE = 25; // floor(100 / 4 binds per UPDATE)
  for (let i = 0; i < writes.length; i += RETIER_CHUNK_SIZE) {
    const chunk = writes.slice(i, i + RETIER_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- chunked batch
    await db.batch(chunk as [(typeof chunk)[number], ...typeof chunk]);
  }
  logEvent("info", {
    component: "retier",
    event: "done",
    evaluated: allSources.length,
    retiered,
    withSignal,
  });
}

// Pure helpers exported for unit tests.

export function computeMedianGapDays(isoDates: string[]): number {
  const timestamps = isoDates
    .map((d) => new Date(d).getTime())
    .filter((t) => Number.isFinite(t))
    .toSorted((a, b) => a - b);
  if (timestamps.length < 2) return Number.POSITIVE_INFINITY;
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    gaps.push((timestamps[i] - timestamps[i - 1]) / 86400_000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

export function classifyTier(medianGapDays: number, current: FetchPriority): FetchPriority {
  if (medianGapDays <= NORMAL_MAX_DAYS) return "normal";
  if (medianGapDays <= LOW_MAX_DAYS) return "low";
  // Above LOW_MAX: preserve current tier. Don't auto-pause (see module
  // header) and don't demote below `low` — a very quiet source polled
  // once a day costs nothing.
  return current;
}
