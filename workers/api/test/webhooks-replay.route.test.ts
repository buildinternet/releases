import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { mountWebhooksReplay } from "../src/routes/webhooks-replay.js";

function makeApp() {
  const app = new Hono();
  const fakeDoStub = {
    fetch: async (req: Request) => {
      const u = new URL(req.url);
      return new Response(JSON.stringify({ events: [{ seq: 1 }], head: 1, since: u.searchParams.get("since") }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  const env = {
    RELEASE_HUB: {
      idFromName: () => ({ toString: () => "id" }),
      get: () => fakeDoStub,
    },
  };
  mountWebhooksReplay(app, () => env as any);
  return app;
}

describe("GET /v1/webhooks/events", () => {
  it("proxies to the DO /replay path with since param", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("https://x.test/v1/webhooks/events?since=42"));
    expect(res.status).toBe(200);
    const body = await res.json() as { since?: string };
    expect(body.since).toBe("42");
  });

  it("returns 400 on a malformed since", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("https://x.test/v1/webhooks/events?since=foo"));
    expect(res.status).toBe(400);
  });
});
