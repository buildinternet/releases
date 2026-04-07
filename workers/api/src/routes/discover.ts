import { Hono } from "hono";
import type { Env } from "../index.js";

export const discoverRoutes = new Hono<Env>();

function proxyToDiscovery(env: Env["Bindings"], path: string, init: RequestInit): Promise<Response> {
  if (!env.DISCOVERY_WORKER) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: "Discovery worker not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  // Service bindings require a full URL but the host is ignored
  return env.DISCOVERY_WORKER.fetch(new Request(`https://discovery${path}`, init));
}

// ── Start discovery ──

discoverRoutes.post("/discover", async (c) => {
  const body = await c.req.text();
  const res = await proxyToDiscovery(c.env, "/onboard", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: c.req.header("Authorization") ?? "",
    },
    body,
  });
  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
});

// ── Get discovery status ──

discoverRoutes.get("/discover/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const res = await proxyToDiscovery(c.env, `/onboard/${sessionId}/status`, {
    method: "GET",
    headers: {
      Authorization: c.req.header("Authorization") ?? "",
    },
  });
  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
});
