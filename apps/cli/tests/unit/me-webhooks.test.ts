import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = "https://test.example.com";
  process.env.RELEASES_API_KEY = "test-key";
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

const client = await import("../../src/api/me-webhooks.js");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("me-webhooks client wire contract", () => {
  let originalFetch: typeof globalThis.fetch;
  let calls: Array<{ url: string; method: string; body: unknown }> = [];
  let responder: (url: string) => Response;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    responder = () => json({});
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return responder(u);
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("listMyWebhooks GETs /v1/me/webhooks", async () => {
    responder = () => json({ subscriptions: [{ id: "whk_1", scope: "follows" }] });
    const subs = await client.listMyWebhooks();
    expect(subs).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.endsWith("/v1/me/webhooks")).toBe(true);
  });

  it("createMyWebhook POSTs follows scope", async () => {
    responder = () => json({ id: "whk_2", signingKey: "abc", scope: "follows" }, 201);
    const created = await client.createMyWebhook({
      url: "https://ex.com/h",
      scope: "follows",
    });
    expect(created.signingKey).toBe("abc");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ url: "https://ex.com/h", scope: "follows" });
  });

  it("createMyWebhook POSTs org scope with orgSlug", async () => {
    responder = () => json({ id: "whk_3", signingKey: "def", scope: "org" });
    await client.createMyWebhook({ url: "https://ex.com/o", orgSlug: "vercel" });
    expect(calls[0]!.body).toEqual({ url: "https://ex.com/o", orgSlug: "vercel" });
  });

  it("createMyWebhook POSTs format discord", async () => {
    responder = () => json({ id: "whk_d", format: "discord", scope: "org" }, 201);
    await client.createMyWebhook({
      url: "https://discord.com/api/webhooks/1/token",
      orgSlug: "acme",
      format: "discord",
    });
    expect(calls[0]!.body).toEqual({
      url: "https://discord.com/api/webhooks/1/token",
      orgSlug: "acme",
      format: "discord",
    });
  });

  it("createMyWebhook POSTs org filters and releaseType", async () => {
    responder = () => json({ id: "whk_7", signingKey: "ghi", scope: "org" });
    await client.createMyWebhook({
      url: "https://ex.com/f",
      orgSlug: "vercel",
      productSlug: "next-js",
      sourceSlug: "changelog",
      releaseType: "feature",
    });
    expect(calls[0]!.body).toEqual({
      url: "https://ex.com/f",
      orgSlug: "vercel",
      productSlug: "next-js",
      sourceSlug: "changelog",
      releaseType: "feature",
    });
  });

  it("updateMyWebhook PATCHes filter fields", async () => {
    responder = () => json({ id: "whk_8", releaseType: "rollup" });
    await client.updateMyWebhook("whk_8", {
      productSlug: "next-js",
      releaseType: "rollup",
      sourceId: null,
    });
    expect(calls[0]!.body).toEqual({
      productSlug: "next-js",
      releaseType: "rollup",
      sourceId: null,
    });
  });

  it("updateMyWebhook PATCHes format discord", async () => {
    responder = () => json({ id: "whk_d2", format: "discord" });
    await client.updateMyWebhook("whk_d2", {
      format: "discord",
      url: "https://discord.com/api/webhooks/2/token",
    });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({
      format: "discord",
      url: "https://discord.com/api/webhooks/2/token",
    });
  });

  it("updateMyWebhook PATCHes enabled", async () => {
    responder = () => json({ id: "whk_4", enabled: false });
    await client.updateMyWebhook("whk_4", { enabled: false });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.endsWith("/v1/me/webhooks/whk_4")).toBe(true);
    expect(calls[0]!.body).toEqual({ enabled: false });
  });

  it("deleteMyWebhook DELETEs by id", async () => {
    responder = () => new Response(null, { status: 204 });
    await client.deleteMyWebhook("whk_5");
    expect(calls[0]!.method).toBe("DELETE");
  });

  it("testMyWebhook POSTs /test", async () => {
    responder = () => json({ enqueued: true, eventId: "evt_1" });
    const out = await client.testMyWebhook("whk_6");
    expect(out.eventId).toBe("evt_1");
    expect(calls[0]!.url.endsWith("/test")).toBe(true);
  });
});

describe("workspace-owned webhooks share the same functions via a parameterized base path", () => {
  let originalFetch: typeof globalThis.fetch;
  let calls: Array<{ url: string; method: string; body: unknown }> = [];
  let responder: (url: string) => Response;
  const owner = { kind: "workspace" as const, id: "ws_abc123" };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    responder = () => json({});
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return responder(u);
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("listWebhooks GETs /v1/workspaces/:id/webhooks and surfaces role + canManage", async () => {
    responder = () =>
      json({ subscriptions: [{ id: "whk_1", scope: "org" }], role: "member", canManage: false });
    const res = await client.listWebhooks(owner);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.endsWith("/v1/workspaces/ws_abc123/webhooks")).toBe(true);
    expect(res.subscriptions).toHaveLength(1);
    expect(res.role).toBe("member");
    expect(res.canManage).toBe(false);
  });

  it("listWebhooks passes the enabled filter through", async () => {
    responder = () => json({ subscriptions: [], role: "owner", canManage: true });
    await client.listWebhooks(owner, { enabled: true });
    expect(calls[0]!.url).toContain("/v1/workspaces/ws_abc123/webhooks?enabled=true");
  });

  it("createWebhook POSTs /v1/workspaces/:id/webhooks", async () => {
    responder = () => json({ id: "whk_w1", scope: "org", signingKey: "wsecret" }, 201);
    const res = await client.createWebhook(owner, { url: "https://ex.com/w", orgSlug: "acme" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.endsWith("/v1/workspaces/ws_abc123/webhooks")).toBe(true);
    expect(res.signingKey).toBe("wsecret");
  });

  it("getWebhook GETs /v1/workspaces/:id/webhooks/:whid", async () => {
    responder = () => json({ id: "whk_w2", scope: "org" });
    await client.getWebhook(owner, "whk_w2");
    expect(calls[0]!.url.endsWith("/v1/workspaces/ws_abc123/webhooks/whk_w2")).toBe(true);
  });

  it("updateWebhook PATCHes /v1/workspaces/:id/webhooks/:whid", async () => {
    responder = () => json({ id: "whk_w3", enabled: false });
    await client.updateWebhook(owner, "whk_w3", { enabled: false });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.endsWith("/v1/workspaces/ws_abc123/webhooks/whk_w3")).toBe(true);
  });

  it("deleteWebhook DELETEs /v1/workspaces/:id/webhooks/:whid", async () => {
    responder = () => new Response(null, { status: 204 });
    await client.deleteWebhook(owner, "whk_w4");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.endsWith("/v1/workspaces/ws_abc123/webhooks/whk_w4")).toBe(true);
  });

  it("rotateWebhookSecret POSTs the workspace rotate-secret route", async () => {
    responder = () => json({ secretVersion: 2, signingKey: "newkey" });
    await client.rotateWebhookSecret(owner, "whk_w5");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.endsWith("/v1/workspaces/ws_abc123/webhooks/whk_w5/rotate-secret")).toBe(
      true,
    );
  });

  it("testWebhook POSTs the workspace test route", async () => {
    responder = () => json({ enqueued: true, eventId: "evt_w1" });
    await client.testWebhook(owner, "whk_w6");
    expect(calls[0]!.url.endsWith("/v1/workspaces/ws_abc123/webhooks/whk_w6/test")).toBe(true);
  });

  it("getWebhookDeliveries GETs the workspace deliveries route", async () => {
    responder = () => json({ data: [{ event_id: "evt_1" }] });
    const rows = await client.getWebhookDeliveries(owner, "whk_w7", { limit: 5 });
    expect(rows).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1/workspaces/ws_abc123/webhooks/whk_w7/deliveries");
    expect(calls[0]!.url).toContain("limit=5");
  });
});
