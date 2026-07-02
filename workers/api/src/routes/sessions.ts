import { Hono } from "hono";
import type { Session, SessionListResponse } from "@buildinternet/releases-api-types";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { getStatusHub } from "../utils.js";
import {
  applyFetchLogOverlay,
  applyFetchLogOverlaySingle,
} from "../lib/session-fetch-log-overlay.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError } from "@releases/lib/releases-error";

export const sessionRoutes = new Hono<Env>();

// ── List all sessions ──

sessionRoutes.get("/sessions", async (c) => {
  const query = new URL(c.req.url).search;
  const res = await getStatusHub(c.env).fetch(new Request(`https://do/sessions${query}`));
  const sessions = (await res.json()) as SessionListResponse;
  // Issue #948: the session DO's terminal state can disagree with fetch_log
  // when a long fetch outlives its SSE subscriber. Overlay the persisted
  // fetch outcome onto the response so `task list` shows the truth. The
  // overlay is presentation-only — if the D1 lookup fails, return the raw
  // DO payload rather than 500'ing the operator's debugging surface.
  if (Array.isArray(sessions?.items)) {
    try {
      sessions.items = await applyFetchLogOverlay(createDb(c.env.DB), sessions.items);
    } catch (err) {
      logEvent("warn", {
        component: "sessions-route",
        event: "fetch-log-overlay-failed",
        scope: "list",
        err: err instanceof Error ? err : String(err),
      });
    }
  }
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
  if (res.status === 404) return respondError(c, new NotFoundError());
  let session = (await res.json()) as Session;
  // See #948 — same overlay as the list endpoint, applied to a single row.
  // Fail-open on D1 errors so the operator still sees the raw DO payload.
  try {
    session = await applyFetchLogOverlaySingle(createDb(c.env.DB), session);
  } catch (err) {
    logEvent("warn", {
      component: "sessions-route",
      event: "fetch-log-overlay-failed",
      scope: "detail",
      sessionId,
      err: err instanceof Error ? err : String(err),
    });
  }
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
  const res = await getStatusHub(c.env).fetch(
    new Request(`https://do/sessions/${sessionId}/stdout`),
  );
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
  await getStatusHub(c.env).fetch(
    new Request(`https://do/sessions/${sessionId}`, { method: "DELETE" }),
  );
  return c.json({ ok: true });
});
