import type {
  Env,
  OnboardRequest,
  OnboardResponse,
  StatusResponse,
  UpdateRequest,
} from "./types.js";
import { discoveryIdentityHeaders } from "./identity.js";
import { directApiFetcher, withDiscoveryIdentity, withStagingHeader } from "./fetch-wrappers.js";
import { scrapeFetch, type ScrapeEnv } from "./scrape-fetch.js";
import { logEvent } from "@releases/lib/log-event.js";
import { getSecret } from "@releases/lib/secrets";
import type { ErrorCategory } from "@releases/lib/errors";
import { WorkerEntrypoint } from "cloudflare:workers";

export { Sandbox } from "@cloudflare/sandbox";
export { ManagedAgentsSession } from "./managed-agents-session.js";

export interface FetchSourceResult {
  ok: boolean;
  releasesFound: number;
  releasesInserted: number;
  errorCategory?: ErrorCategory;
  error?: string;
}

const MAX_UPDATE_SOURCES = 20;

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

async function checkAuth(request: Request, env: Env): Promise<Response | null> {
  const apiKey = await getSecret(env.RELEASED_API_KEY);
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

/**
 * Build a {@link ScrapeEnv} for synchronous (non-managed-agent) scrape runs
 * triggered by the poll-and-fetch workflow's "summary-only feed → crawl
 * enrichment" path. Mirrors the construction in `managed-agents-session.ts`
 * — same secrets, same fetcher wrappers — but does not require a live MA
 * session. Returns an error Response when the Cloudflare browser-rendering
 * credentials aren't configured (crawl is impossible without them).
 */
async function buildScrapeEnv(
  env: Env,
  sessionId: string | undefined,
): Promise<ScrapeEnv | Response> {
  const [anthropicApiKey, cfAccountId, cfApiToken, releasesApiKey, gatewayToken, stagingKey] =
    await Promise.all([
      getSecret(env.ANTHROPIC_API_KEY).catch(() => null),
      getSecret(env.CLOUDFLARE_ACCOUNT_ID).catch(() => null),
      getSecret(env.CLOUDFLARE_API_TOKEN).catch(() => null),
      getSecret(env.RELEASED_API_KEY).catch(() => null),
      getSecret(env.AI_GATEWAY_TOKEN).catch(() => null),
      getSecret(env.STAGING_ACCESS_KEY).catch(() => null),
    ]);

  if (!anthropicApiKey) {
    return errorResponse("ANTHROPIC_API_KEY not configured", 500);
  }
  if (!cfAccountId || !cfApiToken) {
    return errorResponse(
      "Cloudflare account/token not configured — crawl-based scrape is unavailable",
      500,
    );
  }

  const baseFetcher = env.API_WORKER ?? directApiFetcher(env.RELEASED_API_URL);
  const fetcher = withDiscoveryIdentity(withStagingHeader(baseFetcher, stagingKey ?? ""));

  return {
    cloudflareAccountId: cfAccountId,
    cloudflareApiToken: cfApiToken,
    anthropicApiKey,
    anthropicBaseURL: env.ANTHROPIC_BASE_URL,
    aiGatewayToken: gatewayToken || undefined,
    apiFetcher: fetcher,
    apiKey: releasesApiKey ?? "",
    sessionId,
    extractToolLoopEnabled: env.EXTRACT_TOOLLOOP_ENABLED,
  };
}

/**
 * Named entrypoint for typed RPC calls from the API worker.
 * Exposes `fetchSource` as a direct method — no HTTP serialization, no auth
 * overhead. The `fetch` handler below stays in place for external HTTP callers
 * (CLI, /onboard, /update, /onboard/:id/status).
 *
 * Binding declaration in the API worker's wrangler.jsonc must include
 * `"entrypoint": "DiscoveryEntrypoint"` on the service binding object.
 */
export class DiscoveryEntrypoint extends WorkerEntrypoint<Env> {
  /**
   * Synchronously fetch and extract releases for one source, delegating to
   * the discovery worker's crawl pipeline. Discovery owns its own `fetch_log`
   * and source-counter bookkeeping — callers must NOT also bump those counters.
   *
   * Throws if the ScrapeEnv cannot be constructed (missing secrets), so the
   * caller's workflow step can treat it as a retryable infrastructure error
   * rather than a logic-level "scrape failed" result.
   */
  async fetchSource(sourceIdentifier: string, sessionId?: string): Promise<FetchSourceResult> {
    const scrapeEnv = await buildScrapeEnv(this.env, sessionId);
    if (scrapeEnv instanceof Response) {
      // buildScrapeEnv returns a Response only when secrets are missing.
      // Throw so the workflow step retries rather than treating it as a
      // source-level failure.
      let errBody: { error?: string } = {};
      try {
        errBody = (await scrapeEnv.clone().json()) as typeof errBody;
      } catch {
        /* ignore parse failure */
      }
      throw new Error(errBody.error ?? "Discovery: failed to build scrape environment");
    }

    const result = await scrapeFetch(scrapeEnv, sourceIdentifier);
    const isError = result.startsWith("Error");
    const categoryMatch = isError ? result.match(/^Error \[([a-z]+)\]:/) : null;
    const errorCategory = categoryMatch ? (categoryMatch[1] as ErrorCategory) : undefined;

    logEvent(isError ? "warn" : "info", {
      component: "discovery",
      event: "source-fetch-completed",
      sourceIdentifier,
      sessionId,
      ok: !isError,
      errorCategory,
    });

    if (isError) {
      // Strip the `Error [<category>]: ` prefix to surface just the message.
      const message = result.replace(/^Error \[[a-z]+\]:\s*/, "");
      return { ok: false, releasesFound: 0, releasesInserted: 0, errorCategory, error: message };
    }

    // `scrapeFetch` returns `Error [<category>]: …` on failure (handled above)
    // or `JSON.stringify({ fetched, status, releasesFound, releasesInserted, … })`
    // on success. A parse failure here means scrapeFetch is buggy — don't
    // swallow it: let the throw propagate so the caller's catch records an
    // error row instead of marking the fetch as a silent `no_change`.
    const parsed = JSON.parse(result) as { releasesFound?: number; releasesInserted?: number };
    return {
      ok: true,
      releasesFound: parsed.releasesFound ?? 0,
      releasesInserted: parsed.releasesInserted ?? 0,
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const authError = await checkAuth(request, env);
    if (authError) return authError;

    if (request.method === "POST" && url.pathname === "/onboard") {
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
        const apiKey = await getSecret(env.RELEASED_API_KEY);
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
          : await fetch(`${env.RELEASED_API_URL.replace(/\/+$/, "")}${guardPath}`, {
              headers: guardHeaders,
            });
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
      let body: UpdateRequest;
      try {
        body = await request.json();
      } catch {
        return errorResponse("Invalid JSON body", 400);
      }

      if (!body.company || typeof body.company !== "string") {
        return errorResponse("Missing required field: company", 400);
      }
      // Accept sourceIdentifiers (preferred) or legacy sourceSlugs
      const identifiers = body.sourceIdentifiers ?? body.sourceSlugs;
      if (!Array.isArray(identifiers) || identifiers.length === 0) {
        return errorResponse("sourceIdentifiers must be a non-empty array", 400);
      }
      if (identifiers.length > MAX_UPDATE_SOURCES) {
        return errorResponse(
          `Too many sources (${identifiers.length}/${MAX_UPDATE_SOURCES} max). Split into multiple requests.`,
          400,
        );
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
