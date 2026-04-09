import type { Env, OnboardRequest, OnboardResponse, StatusResponse } from "./types.js";
import { runManagedAgentsDiscovery } from "./managed-agents-handler.js";

export { Sandbox } from "@cloudflare/sandbox";
export { DiscoverySession } from "./discovery-session.js";

type DiscoveryEngine = "managed-agents" | "sandbox";

function resolveEngine(env: Env, body?: { engine?: string }): DiscoveryEngine {
  // Request-level override > env var > default
  if (body?.engine === "sandbox") return "sandbox";
  if (body?.engine === "managed-agents") return "managed-agents";
  if (env.RELEASED_DISCOVERY_ENGINE?.toLowerCase() === "sandbox") return "sandbox";
  return "managed-agents";
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

      const sessionId = crypto.randomUUID();
      const engine = resolveEngine(env, body as OnboardRequest & { engine?: string });

      if (engine === "managed-agents") {
        // Preflight: validate Anthropic API key before committing to async work
        const anthropicKey = await env.ANTHROPIC_API_KEY?.get();
        if (!anthropicKey) {
          return errorResponse("ANTHROPIC_API_KEY not configured — cannot use managed-agents engine", 500);
        }

        // Run discovery in the background — return 202 immediately
        // StatusHub receives events as discovery progresses; CLI polls for status
        ctx.waitUntil(
          runManagedAgentsDiscovery(body, env, sessionId).catch((err) => {
            console.error(`[managed-agents] Background discovery failed: ${err}`);
          }),
        );

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

    const statusMatch = url.pathname.match(/^\/onboard\/([\w-]+)\/status$/);
    if (request.method === "GET" && statusMatch) {
      const sessionId = statusMatch[1];

      // Try DiscoverySession DO first (sandbox path)
      try {
        const doId = env.DISCOVERY_SESSION.idFromName(sessionId);
        const stub = env.DISCOVERY_SESSION.get(doId);
        const status: StatusResponse = await (stub as any).getStatus();
        // If the DO has real data (not idle/empty), return it
        if (status.status !== "idle") {
          return jsonResponse(status);
        }
      } catch {
        // DO may not exist for managed agents sessions — fall through
      }

      // Fall back to StatusHub (managed agents path posts events there)
      try {
        const apiKey = await env.RELEASED_API_KEY?.get();
        const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        const hubFetcher = env.API_WORKER ?? globalThis;
        const hubRes = await hubFetcher.fetch(
          new Request(`https://api/v1/sessions/${sessionId}`, { headers }),
        );
        if (hubRes.ok) {
          const session = await hubRes.json() as Record<string, unknown>;
          const status = session.status as string;
          const result: StatusResponse = {
            status: status === "complete" ? "complete" : status === "error" ? "error" : "running",
            progress: {
              step: (session.step as string) ?? "discovery",
              sourcesFound: (session.sourcesFound as number) ?? 0,
              sourcesValidated: (session.sourcesValidated as number) ?? 0,
              currentAction: (session.currentAction as string) ?? "",
            },
          };
          // If complete, include the result from the last event
          if (status === "complete" && session.result) {
            result.result = session.result as object;
          }
          if (status === "error") {
            result.error = (session.error as string) ?? "Unknown error";
          }
          return jsonResponse(result);
        }
      } catch {
        // StatusHub also unavailable
      }

      return jsonResponse({ status: "running" } as StatusResponse);
    }

    return errorResponse("Not found", 404);
  },
};
