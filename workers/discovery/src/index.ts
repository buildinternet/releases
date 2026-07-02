import type {
  Env,
  OnboardRequest,
  OnboardResponse,
  StatusResponse,
  UpdateRequest,
} from "./types.js";
import { discoveryIdentityHeaders } from "./identity.js";
import { logEvent } from "@releases/lib/log-event.js";
import { getSecret, getSecretWithFallback } from "@releases/lib/secrets";
import { errorResponse } from "./error-response.js";
import { checkSpendCap } from "./spend-cap.js";
import { tryAcquireSourceLocks, releaseSourceLocks } from "./source-lock.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import { FLAGS, flag } from "@releases/lib/flags";

export { Sandbox } from "@cloudflare/sandbox";
export { ManagedAgentsSession } from "./managed-agents-session.js";

const MAX_UPDATE_SOURCES = 20;

/**
 * Check whether MA session creation is globally disabled.
 *
 * KV is checked first — fastest path to kill sessions in an incident, no
 * redeploy needed (sub-second propagation). Falls through to the env-flag
 * check when KV is absent or throws.
 *
 * Returns `{ disabled: true, via: "kv" | "env" }` when blocked, or
 * `{ disabled: false }` when clear.
 */
async function maSessionsDisabled(
  env: Env,
): Promise<{ disabled: false } | { disabled: true; via: "kv" | "env" }> {
  try {
    if (env.LATEST_CACHE) {
      const kvFlag = await env.LATEST_CACHE.get("ma:sessions:disabled");
      if (kvFlag) return { disabled: true, via: "kv" };
    }
  } catch {
    // KV unreachable — fall through to env-flag fallback.
  }
  if (await flag(env.FLAGS, env.MA_SESSIONS_DISABLED, FLAGS.maSessionsDisabled))
    return { disabled: true, via: "env" };
  return { disabled: false };
}

/**
 * Shared shape validation for the two entrypoints that launch an update-mode
 * MA session: the `/update` HTTP route (request body comes in as `unknown`)
 * and the typed `startManagedFetchSession` RPC. Returns an error message
 * string when something is wrong, or `null` when the inputs are valid. Keeps
 * the source-cap error text identical across both surfaces so a change to
 * `MAX_UPDATE_SOURCES` doesn't accidentally drift one wording and not the
 * other.
 */
function validateUpdateParams(company: unknown, sourceIdentifiers: unknown): string | null {
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

interface AnthropicConfig {
  agentId: string;
  agentVersion?: number;
  environmentId: string;
}

function getAnthropicConfig(env: Env): AnthropicConfig | Response {
  const agentId = env.ANTHROPIC_AGENT_ID;
  const environmentId = env.ANTHROPIC_ENVIRONMENT_ID;
  if (!agentId || !environmentId) {
    return errorResponse("ANTHROPIC_AGENT_ID and ANTHROPIC_ENVIRONMENT_ID must be configured", 500);
  }
  const agentVersion = env.ANTHROPIC_AGENT_VERSION
    ? parseInt(env.ANTHROPIC_AGENT_VERSION, 10)
    : undefined;
  return { agentId, agentVersion, environmentId };
}

function jsonResponse(data: object, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function checkAuth(request: Request, env: Env): Promise<Response | null> {
  const apiKey = await getSecretWithFallback(env.RELEASES_API_KEY, env.RELEASED_API_KEY);
  if (!apiKey) return null;
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== apiKey) {
    return errorResponse("Unauthorized", 401);
  }
  return null;
}

/**
 * Guard the API key, resolve the agent config, mint a session ID, and kick the
 * managed-agents DO alarm. Returns the new sessionId or an error Response.
 */
async function startManagedSession(
  env: Env,
  errorLabel: string,
  buildParams: (ctx: {
    sessionId: string;
    agentId: string;
    agentVersion?: number;
    environmentId: string;
  }) => Record<string, unknown>,
  // #1814: callers that hold a per-source lease pass the sessionId they reserved
  // it under (acquired before this mint) so the lease owner matches the session.
  providedSessionId?: string,
): Promise<{ sessionId: string } | Response> {
  const anthropicKey = await getSecret(env.ANTHROPIC_API_KEY);
  if (!anthropicKey) {
    return errorResponse("ANTHROPIC_API_KEY not configured", 500);
  }

  const config = getAnthropicConfig(env);
  if (config instanceof Response) return config;
  const { agentId, agentVersion, environmentId } = config;

  const sessionId = providedSessionId ?? `ma-${crypto.randomUUID()}`;
  const maDoId = env.MANAGED_AGENTS_SESSION.idFromName(sessionId);
  const maStub = env.MANAGED_AGENTS_SESSION.get(maDoId);

  try {
    await (maStub as any).startSession(
      buildParams({ sessionId, agentId, agentVersion, environmentId }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(`${errorLabel}: ${message}`, 500);
  }

  return { sessionId };
}

export interface StartManagedFetchSessionParams {
  /**
   * Sources to hand to the MA worker session. Currently always single-source
   * from the poll-fetch delegation path. Multi-source batching (one MA session
   * per org with several sourceIdentifiers) is left for a future change once
   * the caller learns to group by org.
   */
  sourceIds: string[];
  /** Human-readable org name. Used as the MA session `company` key for dedup. */
  company: string;
  /** Optional org ID, mirrors the `/update` HTTP shape. */
  orgId?: string;
  /** Optional trace tag — surfaces in the Anthropic MA dashboard. */
  correlationId?: string;
}

export type StartManagedFetchSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

/**
 * Named entrypoint for typed RPC calls from the API worker.
 *
 * Exposes `startManagedFetchSession` so the poll-and-fetch workflow can hand
 * summary-only feeds with `crawlEnabled: true` off to the same MA worker
 * pipeline used by `/update`. The MA session writes its own `fetch_log` rows
 * and source-counter updates when it completes — callers must not double-bump
 * those counters.
 *
 * Binding declaration in the API worker's wrangler.jsonc must include
 * `"entrypoint": "DiscoveryEntrypoint"` on the service binding object.
 */
export class DiscoveryEntrypoint extends WorkerEntrypoint<Env> {
  // A service binding with `entrypoint: "DiscoveryEntrypoint"` only exposes
  // this class's named methods, so the default-export `fetch` isn't reachable
  // through the binding. This shim makes HTTP routing work alongside RPC.
  async fetch(request: Request): Promise<Response> {
    return httpHandler.fetch(request, this.env);
  }

  /**
   * Kick off a managed-agent update session for one or more sources and
   * return immediately with the new sessionId. The session runs async on the
   * MA platform; its completion writes `fetch_log` rows + source counters via
   * the existing managed-agent bookkeeping.
   *
   * Concurrent sessions for the same source are serialized by the per-source
   * SourceActor lease acquired below (#1814) — the atomic mutex that replaced
   * the org-level StatusHub dedup window (#1816).
   */
  async startManagedFetchSession(
    params: StartManagedFetchSessionParams,
  ): Promise<StartManagedFetchSessionResult> {
    const killSwitch = await maSessionsDisabled(this.env);
    if (killSwitch.disabled) {
      logEvent("warn", {
        component: "discovery",
        event: "ma-session-blocked-kill-switch",
        entry: "startManagedFetchSession",
        via: killSwitch.via,
        company: params.company,
        sourceIds: params.sourceIds,
      });
      return { ok: false, error: "Managed-agent sessions temporarily disabled (kill switch)" };
    }
    const validationError = validateUpdateParams(params.company, params.sourceIds);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    // Daily spend cap: reject if global or per-org spend already hit the
    // ceiling. Checked before the per-source lock because spend is the
    // wider-reaching gate — a cap hit blocks ALL sources, so failing fast
    // here saves a KV round-trip.
    if (this.env.LATEST_CACHE) {
      const spendCheck = await checkSpendCap(this.env.LATEST_CACHE, params.orgId, this.env);
      if (spendCheck.blocked) {
        logEvent("warn", {
          component: "discovery",
          event: "ma-session-blocked-spend-cap",
          entry: "startManagedFetchSession",
          scope: spendCheck.scope,
          currentCents: spendCheck.currentCents,
          capCents: spendCheck.capCents,
          orgId: params.orgId,
          company: params.company,
        });
        return {
          ok: false,
          error: `Daily ${spendCheck.scope} spend cap reached ($${(spendCheck.currentCents / 100).toFixed(2)} of $${(spendCheck.capCents / 100).toFixed(2)})`,
        };
      }
    }

    // Per-source dedup lock (#1814): atomically claim the lease for every source
    // BEFORE minting, so a losing race never starts a duplicate session. Backed
    // by the SourceActor DO (replaced the KV ma:active:src lock). The sessionId is
    // minted here and threaded into the session so the lease owner matches.
    const sessionId = `ma-${crypto.randomUUID()}`;
    {
      const lockedSources = await tryAcquireSourceLocks(this.env, params.sourceIds, sessionId);
      if (lockedSources.length > 0) {
        const detail = lockedSources
          .map((s) => `Source ${s.id} has an active MA session (${s.sessionId})`)
          .join("; ");
        logEvent("info", {
          component: "discovery",
          event: "ma-session-blocked-source-dedup",
          entry: "startManagedFetchSession",
          company: params.company,
          lockedSources: lockedSources.map((s) => s.id),
        });
        return { ok: false, error: detail };
      }
    }

    const result = await startManagedSession(
      this.env,
      "Failed to start managed fetch session",
      (ctx) => ({
        company: params.company,
        mode: "update" as const,
        sourceIdentifiers: params.sourceIds,
        orgId: params.orgId,
        correlationId: params.correlationId,
        ...ctx,
      }),
      sessionId,
    );
    if (result instanceof Response) {
      // Mint failed — release the leases we took so the source isn't wedged
      // until the 15-min lease expires.
      await releaseSourceLocks(this.env, params.sourceIds, sessionId);
      // The mint-failure Response now carries the nested error envelope
      // `{ error: { code, type, message } }` (see ./error-response), so read the
      // human string from `.error.message`.
      let errBody: { error?: { message?: string } } = {};
      try {
        errBody = (await result.clone().json()) as typeof errBody;
      } catch {
        /* ignore parse failure */
      }
      return {
        ok: false,
        error: errBody.error?.message ?? `Discovery returned ${result.status}`,
      };
    }

    logEvent("info", {
      component: "discovery",
      event: "managed-fetch-session-started",
      sessionId: result.sessionId,
      sourceIds: params.sourceIds,
      company: params.company,
      correlationId: params.correlationId,
    });

    return { ok: true, sessionId: result.sessionId };
  }
}

const httpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const authError = await checkAuth(request, env);
    if (authError) return authError;

    if (request.method === "POST" && url.pathname === "/onboard") {
      const killSwitch = await maSessionsDisabled(env);
      if (killSwitch.disabled) {
        logEvent("warn", {
          component: "discovery",
          event: "ma-session-blocked-kill-switch",
          entry: "/onboard",
          via: killSwitch.via,
        });
        return errorResponse("Managed-agent sessions temporarily disabled (kill switch)", 503);
      }
      let body: OnboardRequest;
      try {
        body = await request.json();
      } catch {
        return errorResponse("Invalid JSON body", 400, { code: "invalid_json" });
      }

      if (!body.company || typeof body.company !== "string") {
        return errorResponse("Missing required field: company", 400);
      }

      // ── Discovery guardrails: check for duplicates and count cap ──
      // The dedup window covers both still-running sessions AND sessions that
      // finished within the last DEDUP_WINDOW_MINUTES — this is what catches
      // CLI retries that fire after the original session has already
      // transitioned to complete/error (the May 1 case, see #656).
      // The 5-session cap still keys off `status=running` so a recently
      // finished session doesn't count against the live concurrency budget.
      const DEDUP_WINDOW_MINUTES = 10;
      try {
        const guardPath = `/v1/sessions?type=onboard&recent_minutes=${DEDUP_WINDOW_MINUTES}`;
        const apiKey = await getSecretWithFallback(env.RELEASES_API_KEY, env.RELEASED_API_KEY);
        const stagingKey = (await getSecret(env.STAGING_ACCESS_KEY).catch(() => null)) ?? "";
        const guardHeaders: Record<string, string> = {
          ...discoveryIdentityHeaders(),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(stagingKey ? { "X-Releases-Staging-Key": stagingKey } : {}),
        };
        // Use service binding (Worker-to-Worker) when available, public URL as fallback
        const guardRes = env.API_WORKER
          ? await env.API_WORKER.fetch(
              new Request(`https://api${guardPath}`, { headers: guardHeaders }),
            )
          : await fetch(
              `${(env.RELEASES_API_URL ?? env.RELEASED_API_URL).replace(/\/+$/, "")}${guardPath}`,
              {
                headers: guardHeaders,
              },
            );
        if (guardRes.ok) {
          const sessionsBody = (await guardRes.json()) as
            | {
                sessionId: string;
                company: string;
                status: "running" | "complete" | "error" | "cancelled";
                lastUpdatedAt?: number;
              }[]
            | {
                items: {
                  sessionId: string;
                  company: string;
                  status: "running" | "complete" | "error" | "cancelled";
                  lastUpdatedAt?: number;
                }[];
              };
          const sessions = Array.isArray(sessionsBody) ? sessionsBody : sessionsBody.items;
          const companyLower = body.company.toLowerCase();
          const existing = sessions.find((s) => s.company.toLowerCase() === companyLower);
          if (existing) {
            const minutesAgo =
              existing.lastUpdatedAt !== undefined
                ? Math.max(0, Math.round((Date.now() - existing.lastUpdatedAt) / 60_000))
                : undefined;
            const ageDescriptor =
              existing.status === "running"
                ? "still running"
                : minutesAgo !== undefined
                  ? `${existing.status} ${minutesAgo}m ago`
                  : existing.status;
            // Compute the precise unblock time (#794, item 6). Without this,
            // the agent has to grep DEDUP_WINDOW_MINUTES out of the source
            // code to know when to retry. We expose it three ways:
            //   - `Retry-After: <seconds>` header (HTTP-standard)
            //   - `retryAfter` ISO-8601 timestamp on the JSON body
            //   - the same timestamp interpolated into the human message
            // Running sessions don't have a deterministic unblock time —
            // they unblock when the session resolves, not at a fixed offset.
            // For those we still emit a header pointing at the dedup-window
            // upper bound (worst case) so callers always have something to
            // back off against.
            const dedupWindowMs = DEDUP_WINDOW_MINUTES * 60_000;
            const baseTime = existing.lastUpdatedAt ?? Date.now();
            const unblockAt = baseTime + dedupWindowMs;
            const retryAfterSeconds = Math.max(1, Math.ceil((unblockAt - Date.now()) / 1000));
            const unblockIso = new Date(unblockAt).toISOString();
            const retrySuffix =
              existing.status === "running"
                ? " Wait until the running session resolves before retrying."
                : ` Retry after ${unblockIso}.`;
            return errorResponse(
              `Discovery for "${body.company}" was ${ageDescriptor} (session ${existing.sessionId.slice(0, 8)}) — within the ${DEDUP_WINDOW_MINUTES}m dedup window.${retrySuffix}`,
              409,
              {
                headers: { "Retry-After": String(retryAfterSeconds) },
                details: {
                  retryAfter: unblockIso,
                  retryAfterSeconds,
                  dedupWindowMinutes: DEDUP_WINDOW_MINUTES,
                  existingSessionId: existing.sessionId,
                  existingStatus: existing.status,
                },
              },
            );
          }
          const runningCount = sessions.filter((s) => s.status === "running").length;
          if (runningCount >= 5) {
            return errorResponse(
              `Maximum concurrent discovery sessions reached (${runningCount}/5). Try again later.`,
              429,
            );
          }
        }
      } catch {
        // Non-critical — proceed if StatusHub is unreachable
        logEvent("warn", {
          component: "discovery",
          event: "onboard-guard-skipped",
          reason: "StatusHub unreachable",
        });
      }

      // Daily spend cap: reject if the global daily ceiling has been reached.
      // Onboard sessions don't carry orgId (the org doesn't exist yet), so only
      // the global cap is checked here. Once the session completes and an org is
      // created, subsequent update sessions will also enforce the per-org cap.
      // LATEST_CACHE is added by #1052+#1053; when missing, the check is skipped.
      if (env.LATEST_CACHE) {
        const spendCheck = await checkSpendCap(env.LATEST_CACHE, undefined, env);
        if (spendCheck.blocked) {
          logEvent("warn", {
            component: "discovery",
            event: "ma-session-blocked-spend-cap",
            entry: "/onboard",
            scope: spendCheck.scope,
            currentCents: spendCheck.currentCents,
            capCents: spendCheck.capCents,
            company: body.company,
          });
          return errorResponse(
            `Daily ${spendCheck.scope} spend cap reached ($${(spendCheck.currentCents / 100).toFixed(2)} of $${(spendCheck.capCents / 100).toFixed(2)})`,
            429,
          );
        }
      }

      const result = await startManagedSession(
        env,
        "Failed to start managed agents discovery",
        (ctx) => ({
          company: body.company,
          domain: body.domain,
          githubOrg: body.githubOrg,
          intoOrgSlug: body.intoOrgSlug,
          intoProductSlug: body.intoProductSlug,
          mode: "onboard",
          ...ctx,
        }),
      );
      if (result instanceof Response) return result;

      const response: OnboardResponse = { sessionId: result.sessionId, status: "running" };
      return jsonResponse(response, 202);
    }

    if (request.method === "POST" && url.pathname === "/update") {
      const killSwitch = await maSessionsDisabled(env);
      if (killSwitch.disabled) {
        logEvent("warn", {
          component: "discovery",
          event: "ma-session-blocked-kill-switch",
          entry: "/update",
          via: killSwitch.via,
        });
        return errorResponse("Managed-agent sessions temporarily disabled (kill switch)", 503);
      }
      let body: UpdateRequest;
      try {
        body = await request.json();
      } catch {
        return errorResponse("Invalid JSON body", 400, { code: "invalid_json" });
      }

      // Accept sourceIdentifiers (preferred) or legacy sourceSlugs
      const identifiers = body.sourceIdentifiers ?? body.sourceSlugs;
      const validationError = validateUpdateParams(body.company, identifiers);
      if (validationError) {
        return errorResponse(validationError, 400);
      }

      // Daily spend cap: reject if global or per-org spend already hit the
      // ceiling. Checked before the per-source lock — cap hits block all
      // sources, so failing fast here saves a KV round-trip.
      if (env.LATEST_CACHE) {
        const spendCheck = await checkSpendCap(env.LATEST_CACHE, body.orgId, env);
        if (spendCheck.blocked) {
          logEvent("warn", {
            component: "discovery",
            event: "ma-session-blocked-spend-cap",
            entry: "/update",
            scope: spendCheck.scope,
            currentCents: spendCheck.currentCents,
            capCents: spendCheck.capCents,
            orgId: body.orgId,
            company: body.company,
          });
          return errorResponse(
            `Daily ${spendCheck.scope} spend cap reached ($${(spendCheck.currentCents / 100).toFixed(2)} of $${(spendCheck.capCents / 100).toFixed(2)})`,
            429,
          );
        }
      }

      // Per-source dedup lock (#1814): atomically claim the lease for every
      // source BEFORE minting so a losing race never starts a duplicate session.
      // Backed by the SourceActor DO (replaced the KV ma:active:src lock). The
      // sessionId is minted here and threaded in so the lease owner matches.
      const sessionId = `ma-${crypto.randomUUID()}`;
      if (identifiers) {
        const lockedSources = await tryAcquireSourceLocks(env, identifiers as string[], sessionId);
        if (lockedSources.length > 0) {
          const detail = lockedSources
            .map((s) => `Source ${s.id} has an active MA session (${s.sessionId})`)
            .join("; ");
          logEvent("info", {
            component: "discovery",
            event: "ma-session-blocked-source-dedup",
            entry: "/update",
            company: body.company,
            lockedSources: lockedSources.map((s) => s.id),
          });
          return errorResponse(detail, 409, {
            headers: { "Retry-After": "900" },
          });
        }
      }

      const result = await startManagedSession(
        env,
        "Failed to start update session",
        (ctx) => ({
          company: body.company,
          mode: "update",
          sourceIdentifiers: identifiers,
          orgId: body.orgId,
          correlationId: body.correlationId,
          ...ctx,
        }),
        sessionId,
      );
      if (result instanceof Response) {
        // Mint failed — release the leases we took so the source isn't wedged.
        if (identifiers) {
          await releaseSourceLocks(env, identifiers as string[], sessionId);
        }
        return result;
      }

      return jsonResponse(
        { sessionId: result.sessionId, status: "running", sourceIdentifiers: identifiers },
        202,
      );
    }

    const statusMatch = url.pathname.match(/^\/onboard\/([\w-]+)\/status$/);
    if (request.method === "GET" && statusMatch) {
      const sessionId = statusMatch[1];

      try {
        const maDoId = env.MANAGED_AGENTS_SESSION.idFromName(sessionId);
        const maStub = env.MANAGED_AGENTS_SESSION.get(maDoId);
        const maStatus = (await (maStub as any).getStatus()) as Record<string, unknown>;
        if (maStatus.status && maStatus.status !== "idle") {
          return jsonResponse(maStatus as unknown as StatusResponse);
        }
      } catch {
        /* fall through */
      }

      return jsonResponse({ status: "running" } as StatusResponse);
    }

    return errorResponse("Not found", 404);
  },
};

export default httpHandler;
