import type { Hono } from "hono";
import { getReleaseHub } from "../utils.js";
import { respondError } from "../lib/error-response.js";
import { ValidationError } from "@releases/lib/releases-error";

export function mountWebhooksReplay(
  app: Hono<any, any, any>,
  getEnv: (c: any) => { RELEASE_HUB: DurableObjectNamespace },
) {
  app.get("/webhooks/events", async (c) => {
    const sinceRaw = c.req.query("since");
    const limitRaw = c.req.query("limit");
    const sinceParsed = sinceRaw === undefined ? 0 : parseInt(sinceRaw, 10);
    if (!Number.isFinite(sinceParsed) || sinceParsed < 0) {
      return respondError(
        c,
        new ValidationError("since must be a non-negative integer", { code: "bad_request" }),
      );
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
