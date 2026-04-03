import { Hono } from "hono";
import type { Env } from "../index.js";
import { getStatusHub } from "../utils.js";

export const sessionRoutes = new Hono<Env>();

// ── List all sessions ──

sessionRoutes.get("/sessions", async (c) => {
  const query = new URL(c.req.url).search;
  const res = await getStatusHub(c.env).fetch(new Request(`https://do/sessions${query}`));
  const sessions = await res.json();
  return c.json(sessions);
});

// ── Active source slugs (must be before :sessionId to avoid param matching) ──

sessionRoutes.get("/sessions/active-sources", async (c) => {
  const res = await getStatusHub(c.env).fetch(new Request("https://do/active-sources"));
  const data = await res.json();
  return c.json(data);
});

// ── Single session ──

sessionRoutes.get("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const res = await getStatusHub(c.env).fetch(new Request(`https://do/sessions/${sessionId}`));
  if (res.status === 404) return c.json({ error: "not_found" }, 404);
  const session = await res.json();
  return c.json(session);
});

// ── Session logs ──

sessionRoutes.get("/sessions/:sessionId/logs", async (c) => {
  const sessionId = c.req.param("sessionId");
  const res = await getStatusHub(c.env).fetch(new Request(`https://do/sessions/${sessionId}/logs`));
  const logs = await res.json();
  return c.json(logs);
});

// ── Session stdout ──

sessionRoutes.get("/sessions/:sessionId/stdout", async (c) => {
  const sessionId = c.req.param("sessionId");
  const res = await getStatusHub(c.env).fetch(new Request(`https://do/sessions/${sessionId}/stdout`));
  const lines = await res.json();
  return c.json(lines);
});

// ── Cancel a running session ──

sessionRoutes.post("/sessions/:sessionId/cancel", async (c) => {
  const sessionId = c.req.param("sessionId");
  const res = await getStatusHub(c.env).fetch(
    new Request(`https://do/sessions/${sessionId}/cancel`, { method: "POST" }),
  );
  const data = await res.json();
  return c.json(data, res.status as 200 | 404 | 409);
});

// ── Dismiss a terminal session ──

sessionRoutes.delete("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  await getStatusHub(c.env).fetch(new Request(`https://do/sessions/${sessionId}`, { method: "DELETE" }));
  return c.json({ ok: true });
});
