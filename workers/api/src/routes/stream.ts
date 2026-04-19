import { Hono } from "hono";
import type { Env } from "../index.js";
import { getReleaseHub } from "../utils.js";

export const streamRoutes = new Hono<Env>();

/**
 * GET /v1/releases/stream — public WebSocket that streams `release.created`
 * events as they are published to the release hub.
 *
 * Query params:
 *   - `since=<seq>`  — replay any buffered events with seq > since on connect.
 *                       If since < oldestSeq the server emits a `snapshot_gap`
 *                       message; clients must REST-backfill and re-subscribe.
 *
 * On connect the server sends `{ "type": "ready", "seq": <head> }` so callers
 * that don't pass `?since` still learn the current sequence for later resume.
 */
streamRoutes.get("/releases/stream", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  const url = new URL(c.req.raw.url);
  const since = url.searchParams.get("since");
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  return getReleaseHub(c.env).fetch(
    new Request(`https://do/subscribe${qs}`, {
      headers: c.req.raw.headers,
    }),
  );
});
