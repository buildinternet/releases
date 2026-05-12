import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
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
streamRoutes.get(
  "/releases/stream",
  describeRoute({
    tags: ["Releases"],
    summary: "Stream release events (WebSocket)",
    description:
      'Upgrades to a WebSocket connection and streams `release.created` events in real time as new releases are indexed. The connection is routed through the `ReleaseHub` Durable Object which maintains a shared broadcaster.\n\nQuery parameters:\n- `since=<seq>` — replay buffered events with sequence number greater than `since` immediately on connect. If `since` falls behind the oldest buffered event the server sends a `{ type: "snapshot_gap" }` message; callers must REST-backfill via `GET /v1/orgs/:slug/releases` and re-subscribe.\n\nMessage shapes (JSON over WebSocket frames):\n- `{ type: "ready", seq: number }` — sent on connect with the current head sequence number.\n- `{ type: "release.created", seq: number, release: object }` — a new release was indexed.\n- `{ type: "snapshot_gap" }` — client\'s `since` value is too old; REST-backfill required.\n\nNon-WebSocket requests (missing `Upgrade: websocket`) receive `426 Upgrade Required`.',
    responses: {
      101: {
        description:
          "Switching Protocols — WebSocket upgrade accepted. The connection carries JSON-framed release event messages for the lifetime of the socket.",
      },
      426: {
        description: "Upgrade Required — request must include `Upgrade: websocket`",
      },
    },
  }),
  async (c) => {
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
  },
);
