import type { Env, OnboardRequest, OnboardResponse, StatusResponse } from "./types.js";

export { Sandbox } from "@cloudflare/sandbox";
export { DiscoverySession } from "./discovery-session.js";

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

      const sessionId = crypto.randomUUID();
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
      const doId = env.DISCOVERY_SESSION.idFromName(sessionId);
      const stub = env.DISCOVERY_SESSION.get(doId);

      try {
        const status: StatusResponse = await (stub as any).getStatus();
        return jsonResponse(status);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Failed to get status: ${message}`, 500);
      }
    }

    return errorResponse("Not found", 404);
  },
};
