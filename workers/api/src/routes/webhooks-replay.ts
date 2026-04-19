import type { Hono } from "hono";
import { getReleaseHub } from "../utils.js";

export function mountWebhooksReplay(app: Hono<any, any, any>, getEnv: (c: any) => { RELEASE_HUB: DurableObjectNamespace }) {
  app.get("/webhooks/events", async (c) => {
    const sinceRaw = c.req.query("since");
    const limitRaw = c.req.query("limit");
    const sinceParsed = sinceRaw === undefined ? 0 : parseInt(sinceRaw, 10);
    if (!Number.isFinite(sinceParsed) || sinceParsed < 0) {
      return c.json({ error: "since must be a non-negative integer" }, 400);
    }
    const env = getEnv(c);
    const u = new URL("https://do/replay");
    u.searchParams.set("since", String(sinceParsed));
    if (limitRaw) u.searchParams.set("limit", limitRaw);
    const res = await getReleaseHub(env).fetch(new Request(u.toString()));
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}
