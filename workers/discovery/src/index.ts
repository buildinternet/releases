import type {
  Env,
  OnboardRequest,
  OnboardResponse,
  StatusResponse,
  UpdateRequest,
} from "./types.js";
import { discoveryIdentityHeaders } from "./identity.js";
import { logEvent } from "@releases/lib/log-event.js";
import { getSecret } from "@releases/lib/secrets";
import { checkSpendCap } from "./spend-cap.js";
import { WorkerEntrypoint } from "cloudflare:workers";

export { Sandbox } from "@cloudflare/sandbox";
export { ManagedAgentsSession } from "./managed-agents-session.js";

const MAX_UPDATE_SOURCES = 20;

// Update-mode dedup window for the typed RPC + the /update HTTP route.
// Mirrors the 10-min window /onboard uses but tighter, because update
// sessions complete in ~2 min and a recently-completed session is signal
// that this source was just processed — not an excuse to immediately
// reprocess it. Set to 5 min: long enough to span the entire MA session
// runtime, short enough not to block legitimate "I want to recheck after
// fixing the source config" CLI workflows.
const UPDATE_DEDUP_WINDOW_MINUTES = 5;

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
      const flag = await env.LATEST_CACHE.get("ma:sessions:disabled");
      if (flag) return { disabled: true, via: "kv" };
    }
  } catch {
    // KV unreachable — fall through to env-flag fallback.
  }
  if (env.MA_SESSIONS_DISABLED === "true") return { disabled: true, via: "env" };
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
    return jsonResponse(
      { error: "ANTHROPIC_AGENT_ID and ANTHROPIC_ENVIRONMENT_ID must be configured" },
      500,
    );
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

function errorResponse(
  message: string,
  status: number,
  extra?: { headers?: Record<string, string>; body?: Record<string, unknown> },
): Response {
  return jsonResponse({ error: message, ...extra?.body }, status, extra?.headers);
}

/**
 * Pre-flight dedup for update-mode sessions. Queries the StatusHub via the
 * API worker for any session (running or recently completed within the
 * window). Prefers `orgId` matching (stable identity) over `company`
 * (free-form label) when the caller provides it — falls back to a
 * case-insensitive company comparison only when orgId is unavailable, which
 * keeps legacy callers working. Returns `null` when clear, or a structured
 * block result when a duplicate is found.
 *
 * Mirrors the /onboard guard in the same file but for update-mode sessions.
 * Critical to call from BOTH /update HTTP route and `startManagedFetchSession`
 * RPC — the runaway on 2026-05-18 was triggered through the RPC path because
 * the original `startManagedFetchSession` comment ("fine for the internal
 * poll-fetch caller") explicitly skipped this check.
 *
 * Fail-open: if StatusHub is unreachable we log and let the call through,
 * matching the /onboard pattern. A transient lookup failure shouldn't
 * deadlock all updates.
 */
async function checkUpdateSessionDedup(
  env: Env,
  company: string,
  orgId?: string,
): Promise<{
  existingSessionId: string;
  existingStatus: string;
  ageDescriptor: string;
  retryAfterSeconds: number;
  retryAfterIso: string;
} | null> {
  try {
    const guardPath = `/v1/sessions?type=update&recent_minutes=${UPDATE_DEDUP_WINDOW_MINUTES}`;
    const apiKey = await getSecret(env.RELEASES_API_KEY ?? env.RELEASED_API_KEY);
    const stagingKey = (await getSecret(env.STAGING_ACCESS_KEY).catch(() => null)) ?? "";
    const guardHeaders: Record<string, string> = {
      ...discoveryIdentityHeaders(),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(stagingKey ? { "X-Releases-Staging-Key": stagingKey } : {}),
    };
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
    if (!guardRes.ok) return null;
    type SessionSummary = {
      sessionId: string;
      company: string;
      orgId?: string;
      status: "running" | "complete" | "error" | "cancelled";
      lastUpdatedAt?: number;
    };
    const sessionsBody = (await guardRes.json()) as SessionSummary[] | { items: SessionSummary[] };
    const sessions = Array.isArray(sessionsBody) ? sessionsBody : sessionsBody.items;
    const companyLower = company.toLowerCase();
    // Prefer orgId match (stable identity) when both sides have it. Fall
    // back to company-name match when either side is missing orgId — pre-
    // existing sessions may not carry orgId until they restart under the
    // new SessionState shape.
    const existing = sessions.find((s) =>
      orgId && s.orgId ? s.orgId === orgId : s.company.toLowerCase() === companyLower,
    );
    if (!existing) return null;

    const dedupWindowMs = UPDATE_DEDUP_WINDOW_MINUTES * 60_000;
    const baseTime = existing.lastUpdatedAt ?? Date.now();
    const unblockAt = baseTime + dedupWindowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((unblockAt - Date.now()) / 1000));
    const retryAfterIso = new Date(unblockAt).toISOString();
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
    return {
      existingSessionId: existing.sessionId,
      existingStatus: existing.status,
      ageDescriptor,
      retryAfterSeconds,
      retryAfterIso,
    };
  } catch {
    logEvent("warn", {
      component: "discovery",
      event: "update-dedup-guard-skipped",
      reason: "StatusHub unreachable",
      company,
    });
    return null;
  }
}

async function checkAuth(request: Request, env: Env): Promise<Response | null> {
  const apiKey = await getSecret(env.RELEASES_API_KEY ?? env.RELEASED_API_KEY);
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
): Promise<{ sessionId: string } | Response> {
  const anthropicKey = await getSecret(env.ANTHROPIC_API_KEY);
  if (!anthropicKey) {
    return errorResponse("ANTHROPIC_API_KEY not configured", 500);
  }

  const config = getAnthropicConfig(env);
  if (config instanceof Response) return config;
  const { agentId, agentVersion, environmentId } = config;

  const sessionId = `ma-${crypto.randomUUID()}`;
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
   * Skips the StatusHub dedup pre-check that `/update`'s HTTP handler runs —
   * fine for the internal poll-fetch caller (worst case: a redundant session
   * that the MA platform deduplicates).
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

    // Dedup against any running/recent update session for the same company.
    // The original comment here said skipping was "fine for the internal
    // poll-fetch caller" — the 2026-05-18 runaway proved otherwise: a
    // missed-bookkeeping bug upstream meant the same source was being
    // re-delegated every 2-3 seconds. Block at the gate so a future
    // upstream bug can't burn through Anthropic credits while a human
    // sleeps.
    const blocked = await checkUpdateSessionDedup(this.env, params.company, params.orgId);
    if (blocked) {
      logEvent("info", {
        component: "discovery",
        event: "update-session-deduped",
        entry: "startManagedFetchSession",
        company: params.company,
        orgId: params.orgId,
        existingSessionId: blocked.existingSessionId,
        existingStatus: blocked.existingStatus,
      });
      return {
        ok: false,
        error: `Update for "${params.company}" was ${blocked.ageDescriptor} (session ${blocked.existingSessionId.slice(0, 8)}). Retry after ${blocked.retryAfterIso}.`,
      };
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

    // Per-source dedup lock: reject if any source already has an active MA session.
    if (this.env.LATEST_CACHE) {
      const lockKeys = params.sourceIds.map((id) => `ma:active:src:${id}`);
      const existing = await Promise.all(lockKeys.map((k) => this.env.LATEST_CACHE!.get(k)));
      const lockedSources = existing
        .map((v, i) => (v ? { id: params.sourceIds[i], sessionId: v } : null))
        .filter((x): x is { id: string; sessionId: string } => x !== null);
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
    );
    if (result instanceof Response) {
      let errBody: { error?: string } = {};
      try {
        errBody = (await result.clone().json()) as typeof errBody;
      } catch {
        /* ignore parse failure */
      }
      return {
        ok: false,
        error: errBody.error ?? `Discovery returned ${result.status}`,
      };
    }

    // Acquire per-source locks immediately after the session ID is minted,
    // before returning success. 15-min TTL ensures cleanup even if the DO
    // crashes before its finally block runs.
    if (this.env.LATEST_CACHE) {
      const lockKeys = params.sourceIds.map((id) => `ma:active:src:${id}`);
      await Promise.all(
        lockKeys.map((k) =>
          this.env.LATEST_CACHE!.put(k, result.sessionId, { expirationTtl: 15 * 60 }),
        ),
      );
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
        return errorResponse("Invalid JSON body", 400);
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
        const apiKey = await getSecret(env.RELEASES_API_KEY ?? env.RELEASED_API_KEY);
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
                body: {
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
        return errorResponse("Invalid JSON body", 400);
      }

      // Accept sourceIdentifiers (preferred) or legacy sourceSlugs
      const identifiers = body.sourceIdentifiers ?? body.sourceSlugs;
      const validationError = validateUpdateParams(body.company, identifiers);
      if (validationError) {
        return errorResponse(validationError, 400);
      }

      // Dedup against running/recent update sessions for the same org (or
      // company, when orgId is unavailable) — see comment on the matching
      // call in `startManagedFetchSession` below.
      const blocked = await checkUpdateSessionDedup(env, body.company, body.orgId);
      if (blocked) {
        logEvent("info", {
          component: "discovery",
          event: "update-session-deduped",
          entry: "/update",
          company: body.company,
          existingSessionId: blocked.existingSessionId,
          existingStatus: blocked.existingStatus,
        });
        return errorResponse(
          `Update for "${body.company}" was ${blocked.ageDescriptor} (session ${blocked.existingSessionId.slice(0, 8)}) — within the ${UPDATE_DEDUP_WINDOW_MINUTES}m dedup window. Retry after ${blocked.retryAfterIso}.`,
          409,
          {
            headers: { "Retry-After": String(blocked.retryAfterSeconds) },
            body: {
              retryAfter: blocked.retryAfterIso,
              retryAfterSeconds: blocked.retryAfterSeconds,
              dedupWindowMinutes: UPDATE_DEDUP_WINDOW_MINUTES,
              existingSessionId: blocked.existingSessionId,
              existingStatus: blocked.existingStatus,
            },
          },
        );
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

      // Per-source dedup lock: reject if any source already has an active MA session.
      if (env.LATEST_CACHE && identifiers) {
        const sourceIds = identifiers as string[];
        const lockKeys = sourceIds.map((id) => `ma:active:src:${id}`);
        const existing = await Promise.all(lockKeys.map((k) => env.LATEST_CACHE!.get(k)));
        const lockedSources = existing
          .map((v, i) => (v ? { id: sourceIds[i], sessionId: v } : null))
          .filter((x): x is { id: string; sessionId: string } => x !== null);
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

      const result = await startManagedSession(env, "Failed to start update session", (ctx) => ({
        company: body.company,
        mode: "update",
        sourceIdentifiers: identifiers,
        orgId: body.orgId,
        correlationId: body.correlationId,
        ...ctx,
      }));
      if (result instanceof Response) return result;

      // Acquire per-source locks immediately after the session ID is minted.
      if (env.LATEST_CACHE && identifiers) {
        const sourceIds = identifiers as string[];
        const lockKeys = sourceIds.map((id) => `ma:active:src:${id}`);
        await Promise.all(
          lockKeys.map((k) =>
            env.LATEST_CACHE!.put(k, result.sessionId, { expirationTtl: 15 * 60 }),
          ),
        );
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
