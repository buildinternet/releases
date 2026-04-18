/**
 * Daily cron that drains `changeDetectedAt`-flagged scrape-no-feed sources
 * through the managed-agents /update pipeline. See the design spec:
 * docs/superpowers/specs/2026-04-18-scrape-agent-cron-design.md.
 */

import { and, eq, isNotNull, ne, or, isNull, sql, asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sources, organizations } from "@buildinternet/releases-core/schema";
import { runWithConcurrency } from "../lib/concurrency.js";
import { insertRunningRow, finalizeRunRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";

export type PreflightAction =
  | { action: "proceed" }
  | { action: "warn" }
  | { action: "abort"; abortReason: "anthropic_auth" | "anthropic_credits" };

/**
 * Classifies an Anthropic /v1/models pre-flight response. Single source of
 * truth for the preflight matrix in the design spec. Pure function — no
 * fetch, no side effects.
 */
export function classifyPreflightResponse(input: { status: number; body: string }): PreflightAction {
  const { status, body } = input;
  if (status === 200) return { action: "proceed" };
  if (status === 401 || status === 403) return { action: "abort", abortReason: "anthropic_auth" };
  if (status === 402) return { action: "abort", abortReason: "anthropic_credits" };
  if (status === 429) {
    // Narrow: 429 with a credit_balance_too_low error payload is permanent
    // (account out of credits). Any other 429 is transient rate-limiting;
    // per-session inference will surface real problems.
    try {
      const parsed = JSON.parse(body.slice(0, 1024)) as { error?: { type?: string } };
      if (parsed?.error?.type === "credit_balance_too_low") {
        return { action: "abort", abortReason: "anthropic_credits" };
      }
    } catch {
      // Non-JSON or malformed body: fall through to warn.
    }
    return { action: "warn" };
  }
  // 5xx or anything else unexpected: proceed but flag the run.
  return { action: "warn" };
}

export type Candidate = {
  id: string;
  slug: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  changeDetectedAt: string;
};

type OrgGroup = {
  orgId: string;
  orgSlug: string;
  orgName: string;
  sources: Candidate[];
};

/**
 * Group candidates by `orgId`. Preserves input order within each group
 * (the SQL caller orders by `changeDetectedAt ASC` so oldest flags drain
 * first within the org).
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

type DispatchResult =
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
 */
export function deriveSweepStatus(input: {
  candidates: number;
  dispatchResults: DispatchResult[];
  abortedPreflight?: Extract<PreflightAction, { action: "abort" }>;
}): DerivedStatus {
  if (input.abortedPreflight) {
    return { status: "aborted", abortReason: input.abortedPreflight.abortReason };
  }
  if (input.candidates === 0) {
    return { status: "done", notes: "no flagged sources" };
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
 * Query flagged scrape-no-feed sources. Returns up to `cap` rows; if more
 * than `cap` matched, runs a follow-up COUNT(*) to populate skippedOverCap.
 * Most sweeps take the fast path (no count query).
 */
export async function queryCandidates(
  db: any,
  params: { cap: number },
): Promise<CandidateQueryResult> {
  const whereClause = and(
    eq(sources.type, "scrape"),
    ne(sources.fetchPriority, "paused"),
    isNotNull(sources.changeDetectedAt),
    sql`(json_extract(${sources.metadata}, '$.feedUrl') IS NULL OR ${sources.metadata} IS NULL)`,
    or(eq(sources.isHidden, false), isNull(sources.isHidden)),
  );

  const rows = await db.select({
    id: sources.id,
    slug: sources.slug,
    orgId: sources.orgId,
    orgSlug: organizations.slug,
    orgName: organizations.name,
    changeDetectedAt: sources.changeDetectedAt,
  })
    .from(sources)
    .innerJoin(organizations, eq(organizations.id, sources.orgId))
    .where(whereClause)
    .orderBy(asc(sources.changeDetectedAt))
    .limit(params.cap + 1);

  let skippedOverCap = 0;
  let sliced = rows;
  if (rows.length > params.cap) {
    sliced = rows.slice(0, params.cap);
    const countResult = await db.select({ c: sql<number>`count(*)` })
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
      orgId: r.orgId,
      orgSlug: r.orgSlug,
      orgName: r.orgName,
      changeDetectedAt: r.changeDetectedAt,
    })),
    skippedOverCap,
  };
}

const CRON_NAME = "scrape-agent-sweep";
const PREFLIGHT_TIMEOUT_MS = 3000;
const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 20;
const CONCURRENCY = 3;

type SweepEnv = {
  DB: D1Database;
  CRON_ENABLED?: string;
  SCRAPE_AGENT_CRON_ENABLED?: string;
  SCRAPE_AGENT_MAX_SESSIONS?: string;
  DISCOVERY_WORKER: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  RELEASED_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: any;
};

export async function scrapeAgentSweep(env: SweepEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    console.log("[scrape-agent-cron] CRON_ENABLED=false; skipping");
    return;
  }
  if (env.SCRAPE_AGENT_CRON_ENABLED === "false") {
    console.log("[scrape-agent-cron] SCRAPE_AGENT_CRON_ENABLED=false; skipping");
    return;
  }

  const db = env._drizzleOverride ?? drizzle(env.DB);
  const now = new Date();
  const sweepCorrelationId = crypto.randomUUID();
  const cap = parseMaxSessions(env.SCRAPE_AGENT_MAX_SESSIONS);

  await reconcileStaleRunning(db, { cronName: CRON_NAME, now, thresholdMs: STALE_RUNNING_THRESHOLD_MS });

  const runId = await insertRunningRow(db, { cronName: CRON_NAME, startedAt: now.toISOString() });

  // Pre-flight
  let aborted: Extract<PreflightAction, { action: "abort" }> | undefined;
  if (env.ANTHROPIC_API_KEY) {
    const preflight = await runPreflight(env.ANTHROPIC_API_KEY);
    if (preflight.action === "abort") aborted = preflight;
  } else {
    console.warn("[scrape-agent-cron] ANTHROPIC_API_KEY missing — skipping pre-flight; sessions may fail");
  }

  if (aborted) {
    await finalizeRunRow(db, runId, {
      endedAt: new Date().toISOString(),
      status: "aborted",
      abortReason: aborted.abortReason,
      candidates: 0,
      dispatched: 0,
      skippedOverCap: 0,
      dispatchErrors: 0,
      sessionsStarted: [],
      dispatchErrorDetail: [],
      notes: `preflight aborted: ${aborted.abortReason}`,
    });
    return;
  }

  const { rows, skippedOverCap } = await queryCandidates(db, { cap });
  const groups = groupByOrg(rows);

  const dispatchResults: DispatchResult[] = await runWithConcurrency(
    Array.from(groups.values()),
    CONCURRENCY,
    (group) => dispatchOne(env, sweepCorrelationId, group),
  );

  const derived = deriveSweepStatus({ candidates: rows.length, dispatchResults });
  const sessionsStarted = dispatchResults.flatMap((r) => r.ok ? [r.sessionId] : []);
  const dispatchErrors = dispatchResults.flatMap((r) => !r.ok ? [{ orgSlug: r.orgSlug, error: r.error }] : []);

  await finalizeRunRow(db, runId, {
    endedAt: new Date().toISOString(),
    status: derived.status,
    abortReason: derived.abortReason,
    candidates: rows.length,
    dispatched: sessionsStarted.length,
    skippedOverCap,
    dispatchErrors: dispatchErrors.length,
    sessionsStarted,
    dispatchErrorDetail: dispatchErrors,
    notes: derived.notes ?? null,
  });

  console.log(`[scrape-agent-cron] done: run=${runId} status=${derived.status} candidates=${rows.length} dispatched=${sessionsStarted.length} errors=${dispatchErrors.length} skipped=${skippedOverCap}`);
}

function parseMaxSessions(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_SESSIONS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[scrape-agent-cron] invalid SCRAPE_AGENT_MAX_SESSIONS=${raw}; using default ${DEFAULT_MAX_SESSIONS}`);
    return DEFAULT_MAX_SESSIONS;
  }
  return n;
}

async function runPreflight(apiKey: string): Promise<PreflightAction> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
    });
    const body = await res.text().catch(() => "");
    return classifyPreflightResponse({ status: res.status, body });
  } catch (err) {
    console.warn(`[scrape-agent-cron] preflight failed: ${err instanceof Error ? err.message : err}`);
    return { action: "warn" };
  } finally {
    clearTimeout(timeout);
  }
}

async function dispatchOne(
  env: SweepEnv,
  sweepCorrelationId: string,
  group: OrgGroup,
): Promise<DispatchResult> {
  try {
    const res = await env.DISCOVERY_WORKER.fetch("https://discovery/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RELEASED_API_KEY}`,
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
    return { orgSlug: group.orgSlug, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
