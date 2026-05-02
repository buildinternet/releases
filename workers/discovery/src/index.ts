import type {
  Env,
  OnboardRequest,
  OnboardResponse,
  StatusResponse,
  UpdateRequest,
} from "./types.js";
import { discoveryIdentityHeaders } from "./identity.js";

export { Sandbox } from "@cloudflare/sandbox";
export { ManagedAgentsSession } from "./managed-agents-session.js";

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

function jsonResponse(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

async function checkAuth(request: Request, env: Env): Promise<Response | null> {
  const apiKey = await env.RELEASED_API_KEY?.get();
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
  const anthropicKey = await env.ANTHROPIC_API_KEY?.get();
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
        const apiKey = await env.RELEASED_API_KEY?.get();
        const stagingKey = (await env.STAGING_ACCESS_KEY?.get().catch(() => "")) ?? "";
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
          const sessions = (await guardRes.json()) as {
            sessionId: string;
            company: string;
            status: "running" | "complete" | "error" | "cancelled";
            lastUpdatedAt?: number;
          }[];
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
            return errorResponse(
              `Discovery for "${body.company}" was ${ageDescriptor} (session ${existing.sessionId.slice(0, 8)}) — within the ${DEDUP_WINDOW_MINUTES}m dedup window. Wait or reuse the existing session.`,
              409,
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
        console.warn("[discovery] Could not check active onboards — proceeding anyway");
      }

      const result = await startManagedSession(
        env,
        "Failed to start managed agents discovery",
        (ctx) => ({
          company: body.company,
          domain: body.domain,
          githubOrg: body.githubOrg,
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
