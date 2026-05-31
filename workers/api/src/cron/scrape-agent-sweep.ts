/**
 * Daily cron that drains `changeDetectedAt`-flagged scrape-no-feed sources
 * through the managed-agents /update pipeline. See the design spec:
 * docs/superpowers/specs/2026-04-18-scrape-agent-cron-design.md.
 */

import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { and, eq, isNotNull, ne, or, isNull, sql, asc, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sources, organizations } from "@buildinternet/releases-core/schema";
import { classifyAnthropicError } from "@releases/lib/anthropic-errors.js";
import type { GatewayOptions } from "../lib/anthropic.js";
import { runWithConcurrency } from "../lib/concurrency.js";
import { insertRunningRow, finalizeRunRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";
import { sendCronReport } from "../lib/notifications.js";
import type { EmailEnv } from "../lib/email.js";
import type { CronReport } from "../lib/cron-report.js";
import { DEFAULT_FORCE_DRAIN_STALE_HOURS, pickCandidates } from "./force-drain-sweep.js";
import { logEvent } from "@releases/lib/log-event";

export type PreflightAction =
  | { action: "proceed" }
  | { action: "warn" }
  | { action: "abort"; abortReason: "anthropic_auth" | "anthropic_credits" };

/**
 * Classifies a preflight outcome from `anthropic.models.list()`. Pass `null`
 * on success, or the thrown SDK error on failure. Single source of truth for
 * the preflight matrix in the design spec. Pure function — no fetch, no side
 * effects.
 */
export function classifyPreflightResponse(err: unknown): PreflightAction {
  if (err === null || err === undefined) return { action: "proceed" };

  const classification = classifyAnthropicError(err);
  switch (classification.kind) {
    case "auth":
      return { action: "abort", abortReason: "anthropic_auth" };
    case "credits":
      return { action: "abort", abortReason: "anthropic_credits" };
    case "rate_limit":
      // Transient rate-limiting; per-session inference will surface real
      // problems. Flag the run but don't abort.
      return { action: "warn" };
    default:
      // bad_request, server (5xx), connection errors, or anything
      // unexpected: proceed but flag the run.
      return { action: "warn" };
  }
}

export type Candidate = {
  id: string;
  slug: string;
  type: "scrape" | "agent";
  orgId: string;
  orgSlug: string;
  orgName: string;
  changeDetectedAt: string;
};

export type OrgGroup = {
  orgId: string;
  orgSlug: string;
  orgName: string;
  sources: Candidate[];
};

/**
 * Group candidates by `orgId`. Preserves input order within each group
 * (the SQL caller orders by `lastFetchedAt ASC` so the most-stale sources
 * drain first within the org).
 */
export function groupByOrg(rows: Candidate[]): Map<string, OrgGroup> {
  const groups = new Map<string, OrgGroup>();
  for (const row of rows) {
    const existing = groups.get(row.orgId);
    if (existing) {
      existing.sources.push(row);
    } else {
      groups.set(row.orgId, {
        orgId: row.orgId,
        orgSlug: row.orgSlug,
        orgName: row.orgName,
        sources: [row],
      });
    }
  }
  return groups;
}

export type DispatchResult =
  | { orgSlug: string; ok: true; sessionId: string }
  | { orgSlug: string; ok: false; error: string };

type SweepStatus = "done" | "degraded" | "dispatch_failed" | "aborted";

type DerivedStatus = {
  status: SweepStatus;
  abortReason?: "anthropic_auth" | "anthropic_credits";
  notes?: string;
};

/**
 * Pure reducer from candidates + dispatch outcomes (+ optional aborted
 * preflight) to the final cron_runs status. Single source of truth for the
 * status matrix in the design spec.
 *
 * `strandedCount` is the number of scrape/agent sources the force-drain cron
 * would pick up on its next run — i.e. sources that are stale or flagged
 * `changeDetector: unreliable` via their playbook but haven't yet had
 * `changeDetectedAt` set. Passing it in lets the zero-candidate note
 * distinguish healthy-quiet (`no flagged or stranded sources`) from
 * stranded-but-unreachable (`no flagged sources; stranded=N`). When the caller
 * omits it, the legacy `no flagged sources` note is preserved.
 */
export function deriveSweepStatus(input: {
  candidates: number;
  dispatchResults: DispatchResult[];
  abortedPreflight?: Extract<PreflightAction, { action: "abort" }>;
  strandedCount?: number;
}): DerivedStatus {
  if (input.abortedPreflight) {
    return { status: "aborted", abortReason: input.abortedPreflight.abortReason };
  }
  if (input.candidates === 0) {
    if (input.strandedCount === undefined) {
      return { status: "done", notes: "no flagged sources" };
    }
    return {
      status: "done",
      notes:
        input.strandedCount > 0
          ? `no flagged sources; stranded=${input.strandedCount}`
          : "no flagged or stranded sources",
    };
  }
  const errored = input.dispatchResults.filter((r) => !r.ok).length;
  if (errored === 0) return { status: "done" };
  if (errored === input.dispatchResults.length) return { status: "dispatch_failed" };
  return { status: "degraded" };
}

type CandidateQueryResult = {
  rows: Candidate[];
  skippedOverCap: number;
};

/**
 * Query flagged scrape-no-feed and agent sources, most-stale first
 * (`lastFetchedAt ASC`). Returns up to `cap` rows; if more than `cap` matched,
 * runs a follow-up COUNT(*) to populate skippedOverCap. Most sweeps take the
 * fast path (no count query). Firecrawl-owned sources are excluded — their
 * monitor owns the fetch.
 *
 * Agent sources (#517) join the sweep once the `SCRAPE_CHANGE_DETECT_ENABLED`
 * cron pipeline flags them. The /update dispatcher handles both types
 * identically, so widening the filter is safe.
 */
export async function queryCandidates(
  db: any,
  params: { cap: number },
): Promise<CandidateQueryResult> {
  const whereClause = and(
    inArray(sources.type, ["scrape", "agent"]),
    ne(sources.fetchPriority, "paused"),
    isNotNull(sources.changeDetectedAt),
    sql`(json_extract(${sources.metadata}, '$.feedUrl') IS NULL OR ${sources.metadata} IS NULL)`,
    // Exclude Firecrawl-owned sources — their monitor fetches them, and the poll
    // cron drops them the same way (queryDueSources `notFirecrawl`). Without this
    // a source could be double-fetched by both the monitor and this sweep.
    sql`(json_extract(${sources.metadata}, '$.firecrawl.enabled') IS NULL OR json_extract(${sources.metadata}, '$.firecrawl.enabled') != 1)`,
    or(eq(sources.isHidden, false), isNull(sources.isHidden)),
    // Exclude sources whose org has fetch_paused = true (#1057).
    or(eq(organizations.fetchPaused, false), isNull(organizations.fetchPaused)),
  );

  const rows = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      type: sources.type,
      orgId: sources.orgId,
      orgSlug: organizations.slug,
      orgName: organizations.name,
      changeDetectedAt: sources.changeDetectedAt,
    })
    .from(sources)
    .innerJoin(organizations, eq(organizations.id, sources.orgId))
    .where(whereClause)
    // Order by actual staleness — the source we've gone longest WITHOUT fetching
    // wins (never-fetched, i.e. NULL, sorts first in SQLite ASC), with
    // `changeDetectedAt` as a stable tiebreaker. Ordering by `changeDetectedAt`
    // instead starved any source whose change-validator flaps every poll: each
    // poll re-stamps `changeDetectedAt = now`, perpetually sorting it to the back
    // of a capped queue so it never drains (sweep-starvation incident 2026-05-31).
    .orderBy(asc(sources.lastFetchedAt), asc(sources.changeDetectedAt))
    .limit(params.cap + 1);

  let skippedOverCap = 0;
  let sliced = rows;
  if (rows.length > params.cap) {
    sliced = rows.slice(0, params.cap);
    const countResult = await db
      .select({ c: sql<number>`count(*)` })
      .from(sources)
      .innerJoin(organizations, eq(organizations.id, sources.orgId))
      .where(whereClause);
    const totalCount = Number(countResult?.[0]?.c ?? sliced.length);
    skippedOverCap = totalCount - params.cap;
  }

  return {
    rows: sliced.map((r: any) => ({
      id: r.id,
      slug: r.slug,
      type: r.type,
      orgId: r.orgId,
      orgSlug: r.orgSlug,
      orgName: r.orgName,
      changeDetectedAt: r.changeDetectedAt,
    })),
    skippedOverCap,
  };
}

export const CRON_NAME = "scrape-agent-sweep";
export const PREFLIGHT_TIMEOUT_MS = 3000;
export const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_SESSIONS = 20;
export const CONCURRENCY = 3;

export type SweepEnv = EmailEnv & {
  DB: D1Database;
  CRON_ENABLED?: string;
  SCRAPE_AGENT_CRON_ENABLED?: string;
  SCRAPE_AGENT_MAX_SESSIONS?: string;
  /**
   * Shared with the force-drain cron — same cutoff so the stranded-count
   * shown here matches the set force-drain will pick up at 04:00.
   */
  FORCE_DRAIN_STALE_HOURS?: string;
  DISCOVERY_WORKER: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  RELEASES_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  /** Base URL included in the email body as a detail link (no trailing slash). */
  ADMIN_BASE_URL?: string;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: any;
};

function parseStaleHours(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_FORCE_DRAIN_STALE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FORCE_DRAIN_STALE_HOURS;
}

/**
 * Count scrape/agent sources the force-drain cron would pick up on its next
 * run. Reuses `pickCandidates` with `cap: 0` so the filter/quirk logic stays
 * in one place. Only meaningful when the sweep found nothing flagged — when
 * there are flagged rows, we drain them and let the breakdown note carry
 * the signal.
 */
async function countStranded(db: any, now: Date, staleHours: number): Promise<number> {
  const { totalStranded } = await pickCandidates(db, { now, staleHours, cap: 0 });
  return totalStranded;
}

export async function scrapeAgentSweep(env: SweepEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "scrape-agent-cron", event: "cron-disabled" });
    return;
  }
  if (env.SCRAPE_AGENT_CRON_ENABLED === "false") {
    logEvent("info", { component: "scrape-agent-cron", event: "scrape-agent-cron-disabled" });
    return;
  }

  const db = env._drizzleOverride ?? drizzle(env.DB);
  const now = new Date();
  const sweepCorrelationId = crypto.randomUUID();
  const cap = parseMaxSessions(env.SCRAPE_AGENT_MAX_SESSIONS);

  await reconcileStaleRunning(db, {
    cronName: CRON_NAME,
    now,
    thresholdMs: STALE_RUNNING_THRESHOLD_MS,
  });

  const runId = await insertRunningRow(db, { cronName: CRON_NAME, startedAt: now.toISOString() });

  // Pre-flight
  let aborted: Extract<PreflightAction, { action: "abort" }> | undefined;
  if (env.ANTHROPIC_API_KEY) {
    const preflight = await runPreflight(env.ANTHROPIC_API_KEY, {
      baseURL: env.ANTHROPIC_BASE_URL,
      gatewayToken: env.AI_GATEWAY_TOKEN,
    });
    if (preflight.action === "abort") aborted = preflight;
  } else {
    logEvent("warn", { component: "scrape-agent-cron", event: "anthropic-key-missing" });
  }

  if (aborted) {
    const endedAtMs = Date.now();
    const endedAt = new Date(endedAtMs).toISOString();
    const notes = `preflight aborted: ${aborted.abortReason}`;
    await finalizeRunRow(db, runId, {
      endedAt,
      status: "aborted",
      abortReason: aborted.abortReason,
      candidates: 0,
      dispatched: 0,
      skippedOverCap: 0,
      dispatchErrors: 0,
      sessionsStarted: [],
      dispatchErrorDetail: [],
      notes,
    });
    await sendCronReport(
      env,
      buildReport(env, {
        runId,
        startedAt: now.toISOString(),
        endedAt,
        durationMs: endedAtMs - now.getTime(),
        status: "aborted",
        abortReason: aborted.abortReason,
        candidates: 0,
        dispatched: 0,
        skippedOverCap: 0,
        dispatchErrors: 0,
        notes,
      }),
    );
    return;
  }

  const { rows, skippedOverCap } = await queryCandidates(db, { cap });
  const groups = groupByOrg(rows);

  const dispatchResults: DispatchResult[] = await runWithConcurrency(
    Array.from(groups.values()),
    CONCURRENCY,
    (group) => dispatchOne(env, sweepCorrelationId, group),
  );

  // Only consult the force-drain logic when nothing drained here. If we did
  // drain, the per-type breakdown below already carries the signal and the
  // extra query isn't worth the cost.
  const strandedCount =
    rows.length === 0
      ? await countStranded(db, now, parseStaleHours(env.FORCE_DRAIN_STALE_HOURS))
      : undefined;

  const derived = deriveSweepStatus({
    candidates: rows.length,
    dispatchResults,
    strandedCount,
  });
  const sessionsStarted = dispatchResults.flatMap((r) => (r.ok ? [r.sessionId] : []));
  const dispatchErrors = dispatchResults.flatMap((r) =>
    !r.ok ? [{ orgSlug: r.orgSlug, error: r.error }] : [],
  );

  // Breakdown by source type (#517) so the sweep row reveals whether an
  // unusual drain was scrape-driven, agent-driven, or both — the /update
  // pipeline handles both, but operationally they're different signals.
  // Skip the breakdown when nothing drained; `derived.notes` already
  // carries the "no flagged sources" signal in that case.
  let notes: string | null = derived.notes ?? null;
  if (rows.length > 0) {
    const scrapeCount = rows.filter((r) => r.type === "scrape").length;
    const agentCount = rows.filter((r) => r.type === "agent").length;
    const breakdown = `drained=${rows.length} (type=scrape:${scrapeCount}, type=agent:${agentCount})`;
    notes = notes ? `${notes}; ${breakdown}` : breakdown;
  }

  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  await finalizeRunRow(db, runId, {
    endedAt,
    status: derived.status,
    abortReason: derived.abortReason,
    candidates: rows.length,
    dispatched: sessionsStarted.length,
    skippedOverCap,
    dispatchErrors: dispatchErrors.length,
    sessionsStarted,
    dispatchErrorDetail: dispatchErrors,
    notes,
  });

  logEvent("info", {
    component: "scrape-agent-cron",
    event: "done",
    runId,
    status: derived.status,
    candidates: rows.length,
    dispatched: sessionsStarted.length,
    errors: dispatchErrors.length,
    skipped: skippedOverCap,
  });

  // Legacy rollback path: emails dispatch counts only. Result aggregation
  // (releases inserted per org) lives in the Workflows path, which can sleep
  // 30min for sessions to settle; the scheduled() handler that calls this
  // function can't.
  await sendCronReport(
    env,
    buildReport(env, {
      runId,
      startedAt: now.toISOString(),
      endedAt,
      durationMs: endedAtMs - now.getTime(),
      status: derived.status,
      abortReason: derived.abortReason,
      candidates: rows.length,
      dispatched: sessionsStarted.length,
      skippedOverCap,
      dispatchErrors: dispatchErrors.length,
      notes,
      sessionsStarted,
      dispatchErrorDetail: dispatchErrors,
    }),
  );
}

export type ReportBody = Omit<CronReport, "cronName" | "adminBaseUrl">;

export function buildReport(env: SweepEnv, body: ReportBody): CronReport {
  return { cronName: CRON_NAME, adminBaseUrl: env.ADMIN_BASE_URL, ...body };
}

export function parseMaxSessions(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_SESSIONS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    logEvent("warn", {
      component: "scrape-agent-cron",
      event: "invalid-max-sessions",
      raw,
      defaultValue: DEFAULT_MAX_SESSIONS,
    });
    return DEFAULT_MAX_SESSIONS;
  }
  return n;
}

export async function runPreflight(
  apiKey: string,
  gatewayOpts: GatewayOptions = {},
): Promise<PreflightAction> {
  const client = buildAnthropicClient({
    apiKey,
    baseURL: gatewayOpts.baseURL,
    gatewayToken: gatewayOpts.gatewayToken,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
  try {
    // /v1/models is a cheap, credit-free endpoint; we only care that the
    // key authenticates and the account has credits. We don't use the list.
    await client.models.list({ limit: 1 });
    return classifyPreflightResponse(null);
  } catch (err) {
    return classifyPreflightResponse(err);
  }
}

export async function dispatchOne(
  env: SweepEnv,
  sweepCorrelationId: string,
  group: OrgGroup,
): Promise<DispatchResult> {
  try {
    const res = await env.DISCOVERY_WORKER.fetch("https://discovery/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RELEASES_API_KEY}`,
      },
      body: JSON.stringify({
        company: group.orgName,
        sourceIdentifiers: group.sources.map((s) => s.id),
        orgId: group.orgId,
        correlationId: `${sweepCorrelationId}:${group.orgSlug}`,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { orgSlug: group.orgSlug, ok: false, error: `${res.status} ${body.slice(0, 200)}` };
    }
    const { sessionId } = (await res.json()) as { sessionId: string };
    return { orgSlug: group.orgSlug, ok: true, sessionId };
  } catch (err) {
    return {
      orgSlug: group.orgSlug,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
