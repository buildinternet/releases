/**
 * Dispatch gate for the deterministic update workflow (#1946).
 *
 * This is the enforcement boundary that used to live in front of the discovery
 * worker's `/update` route and `startManagedFetchSession` RPC: kill switch →
 * daily spend cap → per-source scrape lock → start. All three former dispatch
 * points (OrgActor drain, `POST /v1/workflows/update`, poll-fetch crawl-feed
 * delegation) call this helper, so gate ordering and wording can't drift
 * between them.
 *
 * Gate order is deliberate: the kill switch is the cheapest and widest lever;
 * the spend cap blocks ALL sources so failing fast saves the per-source lock
 * round-trips; the lock is checked last, immediately before the workflow is
 * created, so a losing race never starts a duplicate run.
 *
 * The spend-cap counters stay in the KV namespace both workers already share
 * as `LATEST_CACHE` — discovery's onboard sessions keep writing `ma:spend:*`
 * via `recordSessionSpend`; this gate only reads. (Deterministic update runs
 * never wrote session-level spend — extraction sub-calls self-log `ai_usage`.)
 */

import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { checkSpendCap, type SpendCapKv } from "@releases/lib/spend-cap";
import { tryAcquireSourceLocks, releaseSourceLocks, type SourceLockEnv } from "./source-lock.js";

/**
 * Max sources per update run. Mirrors the retired discovery-side
 * MAX_UPDATE_SOURCES; OrgActor's drain chunk derives from it.
 */
export const MAX_UPDATE_SOURCES = 20;

/** Params for one deterministic update run (formerly the `/update` body). */
export interface StartUpdateParams {
  company: string;
  sourceIdentifiers: string[];
  orgId?: string;
  correlationId?: string;
}

export type StartUpdateResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      /**
       * Why dispatch was refused. Callers map these onto their own surfaces:
       * the HTTP route to 400/409/429/503, OrgActor to
       * drain-superseded/drain-failed log events.
       */
      reason: "invalid" | "kill_switch" | "spend_cap" | "locked" | "unavailable";
      message: string;
      /** Set for `locked` — mirrors the old 409's Retry-After: 900. */
      retryAfterSeconds?: number;
    };

export interface UpdateDispatchEnv extends SourceLockEnv {
  // Structural (SpendCapKv) rather than KVNamespace so both the worker env and
  // the narrowed LatestCacheBinding flowing through FetchOneEnv satisfy it.
  LATEST_CACHE?: SpendCapKv;
  FLAGS?: FlagshipBinding;
  MA_SESSIONS_DISABLED?: string;
  MA_DAILY_SPEND_CAP_ORG_CENTS?: string;
  MA_DAILY_SPEND_CAP_GLOBAL_CENTS?: string;
  STATUS_HUB?: DurableObjectNamespace;
  DETERMINISTIC_UPDATE_WORKFLOW?: Workflow;
}

/**
 * Warn once per isolate when LATEST_CACHE is unbound — the spend cap silently
 * not running is exactly the kind of misconfig that should leave a log trail
 * (mirrors source-lock.ts's warnMissingBinding pattern).
 */
let warnedMissingSpendCapKv = false;
function warnMissingSpendCapKv(): void {
  if (warnedMissingSpendCapKv) return;
  warnedMissingSpendCapKv = true;
  logEvent("warn", {
    component: "update-dispatch",
    event: "spend-cap-binding-missing",
    detail: "LATEST_CACHE unbound — daily spend cap not enforced on update dispatch",
  });
}

/**
 * Kill-switch check, relocated from discovery's `maSessionsDisabled`. KV is
 * checked first — fastest lever in an incident, no redeploy — then the
 * Flagship flag / wrangler var. The switch predates #1946 as the "managed-agent
 * sessions" kill; it stays the one lever that also halts deterministic update
 * dispatch (the runs still bill extraction AI), and discovery still honors it
 * for onboarding.
 */
async function updatesDisabled(
  env: UpdateDispatchEnv,
): Promise<{ disabled: false } | { disabled: true; via: "kv" | "env" }> {
  try {
    if (env.LATEST_CACHE) {
      const kvFlag = await env.LATEST_CACHE.get("ma:sessions:disabled");
      if (kvFlag) return { disabled: true, via: "kv" };
    }
  } catch {
    // KV unreachable — fall through to the flag fallback.
  }
  if (await flag(env.FLAGS, env.MA_SESSIONS_DISABLED, FLAGS.maSessionsDisabled))
    return { disabled: true, via: "env" };
  return { disabled: false };
}

/** Shared shape validation (formerly `validateUpdateParams` in discovery). */
export function validateUpdateParams(company: unknown, sourceIdentifiers: unknown): string | null {
  if (!company || typeof company !== "string") {
    return "Missing required field: company";
  }
  if (!Array.isArray(sourceIdentifiers) || sourceIdentifiers.length === 0) {
    return "sourceIdentifiers must be a non-empty array";
  }
  if (sourceIdentifiers.length > MAX_UPDATE_SOURCES) {
    return `Too many sources (${sourceIdentifiers.length}/${MAX_UPDATE_SOURCES} max). Split into multiple requests.`;
  }
  return null;
}

/**
 * Best-effort StatusHub notify. Mirrors what POST /v1/status/event does with
 * the same payload — the hub is local to this worker, so no HTTP hop. Shared
 * with the workflow's terminal session:complete / session:error notifies.
 */
export async function notifyUpdateStatusHub(
  env: { STATUS_HUB?: DurableObjectNamespace },
  event: Record<string, unknown>,
): Promise<void> {
  if (!env.STATUS_HUB) return;
  try {
    const hub = env.STATUS_HUB.get(env.STATUS_HUB.idFromName("global"));
    await hub.fetch(
      new Request("https://do/event", {
        method: "POST",
        body: JSON.stringify(event),
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (err) {
    logEvent("error", {
      component: "update-dispatch",
      event: "status-hub-notify-failed",
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Run the dispatch gates and start a `DeterministicUpdateWorkflow` instance.
 * On success the run is already registered with StatusHub (session:start with
 * agent "deterministic", same wire shape as before), so `/v1/sessions/:id`
 * polling works unchanged. A refusal releases anything it acquired.
 */
export async function startDeterministicUpdate(
  env: UpdateDispatchEnv,
  params: StartUpdateParams,
): Promise<StartUpdateResult> {
  const validationError = validateUpdateParams(params.company, params.sourceIdentifiers);
  if (validationError) {
    return { ok: false, reason: "invalid", message: validationError };
  }

  const killSwitch = await updatesDisabled(env);
  if (killSwitch.disabled) {
    logEvent("warn", {
      component: "update-dispatch",
      event: "update-blocked-kill-switch",
      via: killSwitch.via,
      company: params.company,
      sourceIds: params.sourceIdentifiers,
    });
    return {
      ok: false,
      reason: "kill_switch",
      message: "Managed-agent sessions temporarily disabled (kill switch)",
    };
  }

  if (!env.LATEST_CACHE) {
    warnMissingSpendCapKv();
  } else {
    const spendCheck = await checkSpendCap(env.LATEST_CACHE, params.orgId, env);
    if (spendCheck.blocked) {
      logEvent("warn", {
        component: "update-dispatch",
        event: "update-blocked-spend-cap",
        scope: spendCheck.scope,
        currentCents: spendCheck.currentCents,
        capCents: spendCheck.capCents,
        orgId: params.orgId,
        company: params.company,
      });
      return {
        ok: false,
        reason: "spend_cap",
        message: `Daily ${spendCheck.scope} spend cap reached ($${(spendCheck.currentCents / 100).toFixed(2)} of $${(spendCheck.capCents / 100).toFixed(2)})`,
      };
    }
  }

  if (!env.DETERMINISTIC_UPDATE_WORKFLOW) {
    return {
      ok: false,
      reason: "unavailable",
      message: "DETERMINISTIC_UPDATE_WORKFLOW binding not configured",
    };
  }

  // Per-source dedup lock (#1814/#1815): atomically claim the lease for every
  // source BEFORE creating the workflow so a losing race never starts a
  // duplicate run. The sessionId is minted here and threaded into the workflow
  // so the lease owner matches; the workflow releases in its finally.
  const sessionId = `det-${crypto.randomUUID()}`;
  const lockedSources = await tryAcquireSourceLocks(env, params.sourceIdentifiers, sessionId);
  if (lockedSources.length > 0) {
    const detail = lockedSources
      .map((s) => `Source ${s.id} has an active update session (${s.sessionId})`)
      .join("; ");
    logEvent("info", {
      component: "update-dispatch",
      event: "update-blocked-source-dedup",
      company: params.company,
      lockedSources: lockedSources.map((s) => s.id),
    });
    return { ok: false, reason: "locked", message: detail, retryAfterSeconds: 900 };
  }

  try {
    await env.DETERMINISTIC_UPDATE_WORKFLOW.create({
      id: sessionId,
      params: {
        sessionId,
        company: params.company,
        sourceIdentifiers: params.sourceIdentifiers,
        orgId: params.orgId,
        correlationId: params.correlationId,
      },
    });
  } catch (err) {
    // Create failed — release the leases we took so the sources aren't wedged
    // until the 15-min lease expires.
    await releaseSourceLocks(env, params.sourceIdentifiers, sessionId);
    const message = err instanceof Error ? err.message : String(err);
    logEvent("error", {
      component: "update-dispatch",
      event: "update-workflow-create-failed",
      company: params.company,
      sourceIds: params.sourceIdentifiers,
      err: message,
    });
    return {
      ok: false,
      reason: "unavailable",
      message: `Failed to start update workflow: ${message}`,
    };
  }

  // Register with StatusHub immediately (parity with the retired discovery
  // path, which registered before doing any work) so /v1/sessions shows the
  // run as soon as the caller has its sessionId. Best-effort — the workflow's
  // own complete/error notify is what settles the terminal state.
  await notifyUpdateStatusHub(env, {
    type: "session:start",
    sessionId,
    company: params.company,
    sessionType: "update",
    agent: "deterministic",
    ...(params.orgId ? { orgId: params.orgId } : {}),
    ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    activeSources: params.sourceIdentifiers,
  });

  logEvent("info", {
    component: "update-dispatch",
    event: "update-workflow-dispatched",
    sessionId,
    company: params.company,
    sourceIds: params.sourceIdentifiers,
    correlationId: params.correlationId,
  });

  return { ok: true, sessionId };
}
