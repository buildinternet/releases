import type { Env, OnboardRequest, OnboardResponse, StatusResponse, UpdateRequest } from "./types.js";

export { Sandbox } from "@cloudflare/sandbox";
export { DiscoverySession } from "./discovery-session.js";
export { ManagedAgentsSession } from "./managed-agents-session.js";

type DiscoveryEngine = "managed-agents" | "sandbox";

function resolveEngine(env: Env, body?: { engine?: string }): DiscoveryEngine {
  // Request-level override > env var > default
  if (body?.engine === "sandbox") return "sandbox";
  if (body?.engine === "managed-agents") return "managed-agents";
  if (env.RELEASED_DISCOVERY_ENGINE?.toLowerCase() === "sandbox") return "sandbox";
  return "managed-agents";
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
    return jsonResponse({ error: "ANTHROPIC_AGENT_ID and ANTHROPIC_ENVIRONMENT_ID must be configured" }, 500);
  }
  const agentVersion = env.ANTHROPIC_AGENT_VERSION ? parseInt(env.ANTHROPIC_AGENT_VERSION, 10) : undefined;
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
      try {
        const guardPath = "/v1/sessions?status=running&type=onboard";
        const apiKey = await env.RELEASED_API_KEY?.get();
        const guardHeaders: Record<string, string> = apiKey
          ? { Authorization: `Bearer ${apiKey}` }
          : {};
        // Use service binding (Worker-to-Worker) when available, public URL as fallback
        const guardRes = env.API_WORKER
          ? await env.API_WORKER.fetch(new Request(`https://api${guardPath}`, { headers: guardHeaders }))
          : await fetch(`${env.RELEASED_API_URL.replace(/\/+$/, "")}${guardPath}`, { headers: guardHeaders });
        if (guardRes.ok) {
          const sessions = (await guardRes.json()) as {
            sessionId: string;
            company: string;
          }[];
          const companyLower = body.company.toLowerCase();
          const existing = sessions.find(
            (s) => s.company.toLowerCase() === companyLower
          );
          if (existing) {
            return errorResponse(
              `Discovery already running for "${body.company}" (session ${existing.sessionId.slice(0, 8)})`,
              409
            );
          }
          if (sessions.length >= 5) {
            return errorResponse(
              `Maximum concurrent discovery sessions reached (${sessions.length}/5). Try again later.`,
              429
            );
          }
        }
      } catch {
        // Non-critical — proceed if StatusHub is unreachable
        console.warn("[discovery] Could not check active onboards — proceeding anyway");
      }

      const engine = resolveEngine(env, body as OnboardRequest & { engine?: string });
      const sessionId = `${engine === "managed-agents" ? "ma" : "sb"}-${crypto.randomUUID()}`;

      if (engine === "managed-agents") {
        const anthropicKey = await env.ANTHROPIC_API_KEY?.get();
        if (!anthropicKey) {
          return errorResponse("ANTHROPIC_API_KEY not configured — cannot use managed-agents engine", 500);
        }

        const config = getAnthropicConfig(env);
        if (config instanceof Response) return config;
        const { agentId, agentVersion, environmentId } = config;

        const maDoId = env.MANAGED_AGENTS_SESSION.idFromName(sessionId);
        const maStub = env.MANAGED_AGENTS_SESSION.get(maDoId);

        try {
          await (maStub as any).startSession({
            company: body.company,
            domain: body.domain,
            githubOrg: body.githubOrg,
            sessionId,
            agentId,
            agentVersion,
            environmentId,
            mode: "onboard",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResponse(`Failed to start managed agents discovery: ${message}`, 500);
        }

        const response: OnboardResponse = { sessionId, status: "running" };
        return jsonResponse(response, 202);
      }

      // ── Sandbox path (legacy) ──
      const doId = env.DISCOVERY_SESSION.idFromName(sessionId);
      const stub = env.DISCOVERY_SESSION.get(doId);

      try {
        await (stub as any).startDiscovery({
          company: body.company,
          domain: body.domain,
          githubOrg: body.githubOrg,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Failed to start discovery: ${message}`, 500);
      }

      const response: OnboardResponse = { sessionId, status: "running" };
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
        return errorResponse(`Too many sources (${identifiers.length}/${MAX_UPDATE_SOURCES} max). Split into multiple requests.`, 400);
      }

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
        await (maStub as any).startSession({
          company: body.company,
          sessionId,
          agentId,
          agentVersion,
          environmentId,
          mode: "update",
          sourceIdentifiers: identifiers,
          orgId: body.orgId,
          correlationId: body.correlationId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Failed to start update session: ${message}`, 500);
      }

      return jsonResponse({ sessionId, status: "running", sourceIdentifiers: identifiers }, 202);
    }

    const statusMatch = url.pathname.match(/^\/onboard\/([\w-]+)\/status$/);
    if (request.method === "GET" && statusMatch) {
      const sessionId = statusMatch[1];

      // Route to the correct DO based on session ID prefix
      if (sessionId.startsWith("ma-")) {
        try {
          const maDoId = env.MANAGED_AGENTS_SESSION.idFromName(sessionId);
          const maStub = env.MANAGED_AGENTS_SESSION.get(maDoId);
          const maStatus = await (maStub as any).getStatus() as Record<string, unknown>;
          if (maStatus.status && maStatus.status !== "idle") {
            return jsonResponse(maStatus as unknown as StatusResponse);
          }
        } catch { /* fall through */ }
      } else {
        try {
          const doId = env.DISCOVERY_SESSION.idFromName(sessionId);
          const stub = env.DISCOVERY_SESSION.get(doId);
          const status: StatusResponse = await (stub as any).getStatus();
          if (status.status !== "idle") {
            return jsonResponse(status);
          }
        } catch { /* fall through */ }
      }

      return jsonResponse({ status: "running" } as StatusResponse);
    }

    return errorResponse("Not found", 404);
  },
};
