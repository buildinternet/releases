/**
 * Workflow-based replacement for the `scrapeAgentSweep` cron. Same pipeline,
 * same DB side effects — each phase becomes a `step.do` boundary so partial
 * failure doesn't strand the tail of the sweep.
 *
 * Kicked from `scheduled()` when `SCRAPE_AGENT_USE_WORKFLOW=true`. The
 * existing `scrapeAgentSweep(env)` remains the default path. See issue #482.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import {
  CONCURRENCY,
  CRON_NAME,
  STALE_RUNNING_THRESHOLD_MS,
  buildReport,
  deriveSweepStatus,
  dispatchOne,
  groupByOrg,
  parseMaxSessions,
  queryCandidates,
  runPreflight,
} from "../cron/scrape-agent-sweep.js";
import { DEFAULT_FORCE_DRAIN_STALE_HOURS, pickCandidates } from "../cron/force-drain-sweep.js";
import type {
  DispatchResult,
  OrgGroup,
  PreflightAction,
  ReportBody,
  SweepEnv,
} from "../cron/scrape-agent-sweep.js";
import { finalizeRunRow, insertRunningRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";
import { sendCronReport } from "../lib/notifications.js";
import { aggregateSweepResults } from "../lib/sweep-results.js";
import type { CronReportResults } from "../lib/cron-report.js";
import { getTopSearchQueries } from "../lib/search-queries-top.js";
import type { TopSearchRow } from "../lib/search-queries-top.js";
import {
  evaluateNoResultsAlert,
  formatNoResultsAlertBody,
  getNoResultsStats,
  parseThresholds,
} from "../lib/search-no-results.js";
import { sendAlert, type AlertEnv } from "../lib/send-alert.js";
import { logEvent } from "@releases/lib/log-event";
import { getSecret, getSecretWithFallback } from "@releases/lib/secrets";

/**
 * Workflow env. Secrets stay as SecretBinding here and are resolved inside
 * the step that uses them — each step persists only its return value, so
 * keeping secrets inside step closures avoids them landing in instance state.
 */
export type ScrapeAgentSweepWorkflowEnv = {
  DB: D1Database;
  CRON_ENABLED?: string;
  SCRAPE_AGENT_CRON_ENABLED?: string;
  SCRAPE_AGENT_MAX_SESSIONS?: string;
  /**
   * Shared with the force-drain cron — same cutoff so the stranded-count
   * shown here matches the set force-drain will pick up at 04:00.
   */
  FORCE_DRAIN_STALE_HOURS?: string;
  DISCOVERY_WORKER?: Fetcher;
  RELEASED_API_KEY?: { get(): Promise<string> };
  RELEASES_API_KEY?: { get(): Promise<string> };
  ANTHROPIC_API_KEY?: { get(): Promise<string> };
  ANTHROPIC_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: { get(): Promise<string> };
  SEND_EMAIL?: { send(message: unknown): Promise<void> };
  EMAIL_NOTIFY_ENABLED?: string;
  EMAIL_NOTIFY_TO?: string;
  EMAIL_FROM?: string;
  ADMIN_BASE_URL?: string;
  /** Shared 1h dedup KV for Tier-1/Tier-2 alert emails. */
  ALERT_DEDUP_KV?: KVNamespace;
  /** Tier-2 no-results alert thresholds. Defaults: 20% over 50+ queries. */
  SEARCH_NO_RESULTS_THRESHOLD_PCT?: string;
  SEARCH_NO_RESULTS_MIN_VOLUME?: string;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: unknown;
};

export type ScrapeAgentSweepParams = {
  /** Scheduled event time, for cross-referencing against cron_runs rows. */
  scheduledTime: number;
};

/**
 * Retry policies are tuned against each step's failure modes:
 * - `query-candidates`: D1 transient errors only → quick retries.
 * - `preflight`: auth/credits are surfaced via NonRetryableError so these
 *   retries only cover transient 5xx / network failures.
 * - `dispatch-*`: each kicks a 60–120s managed-agents session. 429s are
 *   the common case, so give them a longer exponential delay.
 */
const RETRY_QUERY = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

const RETRY_PREFLIGHT = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

const RETRY_DISPATCH = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

const RETRY_AGGREGATE = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

const RETRY_TOP_SEARCHES = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

const RETRY_NO_RESULTS = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

/** How many hours back the top-searches digest covers. */
const TOP_SEARCHES_WINDOW_HOURS = 24;
/** Maximum number of search-query rows to include in the email digest. */
const TOP_SEARCHES_LIMIT = 20;
/** Window for the no-results alert evaluation; matches the digest window. */
const NO_RESULTS_WINDOW_HOURS = 24;

/**
 * How long to wait between dispatching managed-agent sessions and emailing
 * the results. Sessions auto-error after 15min of no progress (StatusHub
 * STALE_SESSION_MS), so 30min comfortably captures most healthy runs while
 * bounding the cron's wall-clock cost. Sessions still active at the cutoff
 * are reported as "still running" rather than blocking the email.
 */
const SETTLE_WINDOW_MINUTES = 30;

/** Shared fields between dispatch and report env shapes. */
function baseEnvFields(env: ScrapeAgentSweepWorkflowEnv) {
  return {
    DB: env.DB,
    CRON_ENABLED: env.CRON_ENABLED,
    SCRAPE_AGENT_CRON_ENABLED: env.SCRAPE_AGENT_CRON_ENABLED,
    SCRAPE_AGENT_MAX_SESSIONS: env.SCRAPE_AGENT_MAX_SESSIONS,
    FORCE_DRAIN_STALE_HOURS: env.FORCE_DRAIN_STALE_HOURS,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    SEND_EMAIL: env.SEND_EMAIL,
    EMAIL_NOTIFY_ENABLED: env.EMAIL_NOTIFY_ENABLED,
    EMAIL_NOTIFY_TO: env.EMAIL_NOTIFY_TO,
    EMAIL_FROM: env.EMAIL_FROM,
    ADMIN_BASE_URL: env.ADMIN_BASE_URL,
  };
}

function parseStaleHoursWorkflow(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_FORCE_DRAIN_STALE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FORCE_DRAIN_STALE_HOURS;
}

/**
 * Resolve a `SweepEnv` for `dispatchOne`. The functions in the non-workflow
 * path expect resolved strings, not secret bindings. Throws `NonRetryableError`
 * if `DISCOVERY_WORKER` is missing so the step doesn't retry a permanent gap.
 */
async function resolveDispatchEnv(env: ScrapeAgentSweepWorkflowEnv): Promise<SweepEnv> {
  if (!env.DISCOVERY_WORKER) {
    throw new NonRetryableError("DISCOVERY_WORKER binding missing");
  }
  return {
    ...baseEnvFields(env),
    DISCOVERY_WORKER: env.DISCOVERY_WORKER,
    RELEASES_API_KEY:
      (await getSecretWithFallback(env.RELEASES_API_KEY, env.RELEASED_API_KEY)) ?? "",
  };
}

/**
 * Resolve a `SweepEnv` for `buildReport` / `sendCronReport`. Neither reads
 * secrets, so we skip resolving them and stub the worker binding if absent.
 */
function resolveReportEnv(env: ScrapeAgentSweepWorkflowEnv): SweepEnv {
  return {
    ...baseEnvFields(env),
    DISCOVERY_WORKER:
      env.DISCOVERY_WORKER ?? ({ fetch: async () => new Response() } as unknown as Fetcher),
    RELEASES_API_KEY: "",
  };
}

export class ScrapeAgentSweepWorkflow extends WorkflowEntrypoint<
  ScrapeAgentSweepWorkflowEnv,
  ScrapeAgentSweepParams
> {
  async run(_event: WorkflowEvent<ScrapeAgentSweepParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;

    if (env.CRON_ENABLED === "false") {
      logEvent("info", { component: "scrape-agent-workflow", event: "cron-disabled" });
      return;
    }
    if (env.SCRAPE_AGENT_CRON_ENABLED === "false") {
      logEvent("info", { component: "scrape-agent-workflow", event: "scrape-agent-cron-disabled" });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = env._drizzleOverride ?? drizzle(env.DB);
    const cap = parseMaxSessions(env.SCRAPE_AGENT_MAX_SESSIONS);

    const { runId, sweepCorrelationId, startedAt } = await step.do("init-run", async () => {
      const now = new Date();
      await reconcileStaleRunning(db, {
        cronName: CRON_NAME,
        now,
        thresholdMs: STALE_RUNNING_THRESHOLD_MS,
      });
      const id = await insertRunningRow(db, {
        cronName: CRON_NAME,
        startedAt: now.toISOString(),
      });
      return {
        runId: id,
        sweepCorrelationId: crypto.randomUUID(),
        startedAt: now.toISOString(),
      };
    });

    const preflight = await step.do(
      "preflight",
      RETRY_PREFLIGHT,
      async (): Promise<PreflightAction> => {
        const apiKey = await getSecret(env.ANTHROPIC_API_KEY);
        if (!apiKey) {
          logEvent("warn", { component: "scrape-agent-workflow", event: "anthropic-key-missing" });
          return { action: "proceed" };
        }
        const gatewayToken = (await getSecret(env.AI_GATEWAY_TOKEN).catch(() => null)) ?? undefined;
        // Auth/credits failures are deterministic — surface them as "abort"
        // rather than burning retries. The workflow exits in the next step.
        return await runPreflight(apiKey, {
          baseURL: env.ANTHROPIC_BASE_URL,
          gatewayToken,
        });
      },
    );

    if (preflight.action === "abort") {
      await step.do("finalize-aborted", async () => {
        const endedAtMs = Date.now();
        const endedAt = new Date(endedAtMs).toISOString();
        const notes = `preflight aborted: ${preflight.abortReason}`;
        await finalizeRunRow(db, runId, {
          endedAt,
          status: "aborted",
          abortReason: preflight.abortReason,
          candidates: 0,
          dispatched: 0,
          skippedOverCap: 0,
          dispatchErrors: 0,
          sessionsStarted: [],
          dispatchErrorDetail: [],
          notes,
        });
        const reportEnv = resolveReportEnv(env);
        await sendCronReport(
          reportEnv,
          buildReport(reportEnv, {
            runId,
            startedAt,
            endedAt,
            durationMs: endedAtMs - new Date(startedAt).getTime(),
            status: "aborted",
            abortReason: preflight.abortReason,
            candidates: 0,
            dispatched: 0,
            skippedOverCap: 0,
            dispatchErrors: 0,
            notes,
          }),
        );
      });
      return;
    }

    const { rows, skippedOverCap } = await step.do("query-candidates", RETRY_QUERY, async () => {
      return await queryCandidates(db, { cap });
    });

    const groups = Array.from(groupByOrg(rows).values());

    // Fan-out chunked at CONCURRENCY. Sequential-by-chunk preserves the
    // CONCURRENCY=3 cap from the non-workflow path (`runWithConcurrency`) —
    // flattening to a single Promise.all would fan out every org at once.
    const dispatchResults: DispatchResult[] = [];
    for (let i = 0; i < groups.length; i += CONCURRENCY) {
      const chunk = groups.slice(i, i + CONCURRENCY);
      // eslint-disable-next-line no-await-in-loop
      const chunkResults = await Promise.all(
        chunk.map((group) => dispatchStep(step, env, sweepCorrelationId, group)),
      );
      dispatchResults.push(...chunkResults);
    }

    // Count sources the force-drain cron would pick up next, but only when we
    // drained nothing — the split only matters for the zero-candidates note.
    const strandedCount: number | undefined =
      rows.length === 0
        ? await step.do("count-stranded", RETRY_QUERY, async () => {
            const staleHours = parseStaleHoursWorkflow(env.FORCE_DRAIN_STALE_HOURS);
            const { totalStranded } = await pickCandidates(db, {
              now: new Date(),
              staleHours,
              cap: 0,
            });
            return totalStranded;
          })
        : undefined;

    const finalized: ReportBody = await step.do("finalize-done", async () => {
      const derived = deriveSweepStatus({
        candidates: rows.length,
        dispatchResults,
        strandedCount,
      });
      const sessionsStarted = dispatchResults.flatMap((r) => (r.ok ? [r.sessionId] : []));
      const dispatchErrorDetail = dispatchResults.flatMap((r) =>
        !r.ok ? [{ orgSlug: r.orgSlug, error: r.error }] : [],
      );
      const endedAtMs = Date.now();
      const endedAt = new Date(endedAtMs).toISOString();
      await finalizeRunRow(db, runId, {
        endedAt,
        status: derived.status,
        abortReason: derived.abortReason,
        candidates: rows.length,
        dispatched: sessionsStarted.length,
        skippedOverCap,
        dispatchErrors: dispatchErrorDetail.length,
        sessionsStarted,
        dispatchErrorDetail,
        notes: derived.notes ?? null,
      });
      logEvent("info", {
        component: "scrape-agent-workflow",
        event: "done",
        runId,
        status: derived.status,
        candidates: rows.length,
        dispatched: sessionsStarted.length,
        errors: dispatchErrorDetail.length,
        skipped: skippedOverCap,
      });
      return {
        runId,
        startedAt,
        endedAt,
        durationMs: endedAtMs - new Date(startedAt).getTime(),
        status: derived.status,
        abortReason: derived.abortReason,
        candidates: rows.length,
        dispatched: sessionsStarted.length,
        skippedOverCap,
        dispatchErrors: dispatchErrorDetail.length,
        notes: derived.notes ?? null,
        sessionsStarted,
        dispatchErrorDetail,
      };
    });

    // Sessions were dispatched async and write their fetch_log rows over the
    // next 5–15min. Sleep the settle window before rolling up what they did.
    // Skip the sleep if nothing was dispatched — there's nothing to wait on.
    let results: CronReportResults | undefined;
    if ((finalized.sessionsStarted?.length ?? 0) > 0) {
      await step.sleep("settle", `${SETTLE_WINDOW_MINUTES} minutes`);
      results = await step.do("aggregate-results", RETRY_AGGREGATE, async () => {
        const r = await aggregateSweepResults(db, finalized.sessionsStarted ?? []);
        return { ...r, settleWindowMinutes: SETTLE_WINDOW_MINUTES };
      });
    }

    // The digest is a nice-to-have — never block the daily email on a failed
    // helper. After retries exhaust, swallow the error and omit the section.
    const topSearches: TopSearchRow[] | undefined = await step
      .do("top-searches", RETRY_TOP_SEARCHES, async (): Promise<TopSearchRow[]> => {
        const since = Date.now() - TOP_SEARCHES_WINDOW_HOURS * 3_600_000;
        return getTopSearchQueries(db, { since, limit: TOP_SEARCHES_LIMIT });
      })
      .catch((err: unknown) => {
        logEvent("warn", {
          component: "scrape-agent-workflow",
          event: "top-searches-failed",
          err: err instanceof Error ? err : String(err),
        });
        return undefined;
      });

    await step.do("send-report", async () => {
      const reportEnv = resolveReportEnv(env);
      await sendCronReport(
        reportEnv,
        buildReport(reportEnv, { ...finalized, results, topSearches }),
      );
    });

    // The alert is purely informational and runs after the report has already
    // been sent — never let an aggregation hiccup escalate into a workflow
    // failure that would trigger workflow-level retries.
    await step
      .do("no-results-alert", RETRY_NO_RESULTS, async () => {
        const thresholds = parseThresholds(env);
        const since = Date.now() - NO_RESULTS_WINDOW_HOURS * 3_600_000;
        const stats = await getNoResultsStats(db, { since });
        const decision = evaluateNoResultsAlert(stats, thresholds);
        if (!decision.fire) {
          logEvent("info", {
            component: "scrape-agent-workflow",
            event: "no-results-alert-skipped",
            reason: decision.reason,
          });
          return;
        }
        const alertEnv: AlertEnv = {
          SEND_EMAIL: env.SEND_EMAIL,
          EMAIL_NOTIFY_ENABLED: env.EMAIL_NOTIFY_ENABLED,
          EMAIL_NOTIFY_TO: env.EMAIL_NOTIFY_TO,
          EMAIL_FROM: env.EMAIL_FROM,
          ALERT_DEDUP_KV: env.ALERT_DEDUP_KV,
        };
        await sendAlert(alertEnv, {
          subject: `search no-results rate ${(decision.ratio * 100).toFixed(1)}%`,
          body: formatNoResultsAlertBody(stats, decision, thresholds),
        });
      })
      .catch((err: unknown) => {
        logEvent("warn", {
          component: "scrape-agent-workflow",
          event: "no-results-alert-failed",
          err: err instanceof Error ? err : String(err),
        });
      });
  }
}

/**
 * Wrap `dispatchOne` in a retriable `step.do`. Since `dispatchOne` returns
 * `{ok:false}` instead of throwing, we re-throw on failure so the retry
 * policy fires. The outer `.catch` converts the final throw back into a
 * `DispatchResult` so `deriveSweepStatus` works identically to the cron path.
 *
 * 4xx errors other than 429 are permanent; they surface as `NonRetryableError`
 * to avoid burning retry attempts on bad auth or malformed payloads.
 */
function dispatchStep(
  step: WorkflowStep,
  env: ScrapeAgentSweepWorkflowEnv,
  sweepCorrelationId: string,
  group: OrgGroup,
): Promise<DispatchResult> {
  return step
    .do(`dispatch-${group.orgSlug}`, RETRY_DISPATCH, async (): Promise<DispatchResult> => {
      const sweepEnv = await resolveDispatchEnv(env);
      const result = await dispatchOne(sweepEnv, sweepCorrelationId, group);
      if (result.ok) return result;
      const status = parseInt(result.error.match(/^(\d{3})/)?.[1] ?? "0", 10);
      if (status >= 400 && status < 500 && status !== 429) {
        throw new NonRetryableError(`dispatch-${group.orgSlug}: ${result.error}`);
      }
      throw new Error(`dispatch-${group.orgSlug}: ${result.error}`);
    })
    .catch(
      (err: unknown): DispatchResult => ({
        orgSlug: group.orgSlug,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
}
