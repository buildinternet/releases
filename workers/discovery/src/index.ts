import { getSandbox } from "@cloudflare/sandbox";
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

      if (body.dbSnapshot && typeof body.dbSnapshot !== "string") {
        return errorResponse("dbSnapshot must be a base64 string", 400);
      }

      const sessionId = crypto.randomUUID();
      const doId = env.DISCOVERY_SESSION.idFromName(sessionId);
      const stub = env.DISCOVERY_SESSION.get(doId);

      try {
        await (stub as any).startDiscovery({
          company: body.company,
          domain: body.domain,
          githubOrg: body.githubOrg,
          dbSnapshot: body.dbSnapshot,
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

    // Diagnostic endpoint — accepts optional {"cmd": "..."} body
    if (request.method === "POST" && url.pathname === "/test") {
      let cmd = "echo ok && bun --version";
      try {
        const body: Record<string, unknown> = await request.json();
        if (body.cmd && typeof body.cmd === "string") cmd = body.cmd;
      } catch { /* no body — use default */ }

      const sandbox = getSandbox(env.Sandbox, "smoke-test", { sleepAfter: "1m" });
      try {
        const result = await sandbox.exec(cmd, { timeout: 30_000 });
        return jsonResponse({
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout?.trim(),
          stderr: result.stderr?.trim(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Sandbox test failed: ${message}`, 500);
      } finally {
        await sandbox.destroy();
      }
    }

    return errorResponse("Not found", 404);
  },
};
