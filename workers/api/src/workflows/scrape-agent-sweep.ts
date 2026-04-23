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
  SweepEnv,
} from "../cron/scrape-agent-sweep.js";
import { finalizeRunRow, insertRunningRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";
import { sendCronReport } from "../lib/notifications.js";

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
  ANTHROPIC_API_KEY?: { get(): Promise<string> };
  ANTHROPIC_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: { get(): Promise<string> };
  SEND_EMAIL?: { send(message: unknown): Promise<void> };
  EMAIL_NOTIFY_ENABLED?: string;
  EMAIL_NOTIFY_TO?: string;
  EMAIL_FROM?: string;
  ADMIN_BASE_URL?: string;
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
    RELEASED_API_KEY: (await env.RELEASED_API_KEY?.get()) ?? "",
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
    RELEASED_API_KEY: "",
  };
}

export class ScrapeAgentSweepWorkflow extends WorkflowEntrypoint<
  ScrapeAgentSweepWorkflowEnv,
  ScrapeAgentSweepParams
> {
  async run(_event: WorkflowEvent<ScrapeAgentSweepParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;

    if (env.CRON_ENABLED === "false") {
      console.log("[scrape-agent-workflow] CRON_ENABLED=false; skipping");
      return;
    }
    if (env.SCRAPE_AGENT_CRON_ENABLED === "false") {
      console.log("[scrape-agent-workflow] SCRAPE_AGENT_CRON_ENABLED=false; skipping");
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
        const apiKey = await env.ANTHROPIC_API_KEY?.get();
        if (!apiKey) {
          console.warn("[scrape-agent-workflow] ANTHROPIC_API_KEY missing — skipping preflight");
          return { action: "proceed" };
        }
        const gatewayToken = await env.AI_GATEWAY_TOKEN?.get().catch(() => undefined);
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

    await step.do("finalize-done", async () => {
      const derived = deriveSweepStatus({
        candidates: rows.length,
        dispatchResults,
        strandedCount,
      });
      const sessionsStarted = dispatchResults.flatMap((r) => (r.ok ? [r.sessionId] : []));
      const dispatchErrors = dispatchResults.flatMap((r) =>
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
        dispatchErrors: dispatchErrors.length,
        sessionsStarted,
        dispatchErrorDetail: dispatchErrors,
        notes: derived.notes ?? null,
      });
      console.log(
        `[scrape-agent-workflow] done: run=${runId} status=${derived.status} candidates=${rows.length} dispatched=${sessionsStarted.length} errors=${dispatchErrors.length} skipped=${skippedOverCap}`,
      );
      const reportEnv = resolveReportEnv(env);
      await sendCronReport(
        reportEnv,
        buildReport(reportEnv, {
          runId,
          startedAt,
          endedAt,
          durationMs: endedAtMs - new Date(startedAt).getTime(),
          status: derived.status,
          abortReason: derived.abortReason,
          candidates: rows.length,
          dispatched: sessionsStarted.length,
          skippedOverCap,
          dispatchErrors: dispatchErrors.length,
          notes: derived.notes ?? null,
          sessionsStarted,
          dispatchErrorDetail: dispatchErrors,
        }),
      );
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
