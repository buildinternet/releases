import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

// Drive the real client via env (a top-level mock.module leaks across files —
// see api-client.test.ts). Match request paths by suffix, not full URL, so the
// process-wide getApiUrl() memoization can't poison assertions.
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

const client = {
  ...(await import("../../src/api/core.js")),
  ...(await import("../../src/api/admin.js")),
  ...(await import("../../src/api/collections.js")),
  ...(await import("../../src/api/follows.js")),
  ...(await import("../../src/api/orgs.js")),
  ...(await import("../../src/api/products.js")),
  ...(await import("../../src/api/releases.js")),
  ...(await import("../../src/api/sources.js")),
  ...(await import("../../src/api/webhooks.js")),
};

describe("webhook-subscription client wire contract", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody: Record<string, unknown> | null = null;
  let responder: () => Response;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = "";
    capturedMethod = "";
    capturedBody = null;
    responder = () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return responder();
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("createWebhookSubscription POSTs /v1/webhooks with the input and returns the signing key", async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          id: "whk_abc",
          orgId: "org_1",
          url: "https://x/cb",
          sourceId: null,
          enabled: true,
          secretVersion: 1,
          signingKey: "deadbeef",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    const res = await client.createWebhookSubscription({
      orgId: "org_1",
      url: "https://x/cb",
      description: "test sub",
    });
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl.endsWith("/v1/webhooks")).toBe(true);
    expect(capturedBody).toEqual({ orgId: "org_1", url: "https://x/cb", description: "test sub" });
    expect(res.signingKey).toBe("deadbeef");
  });

  it("listWebhookSubscriptions GETs /v1/webhooks?org= and unwraps { subscriptions }", async () => {
    responder = () =>
      new Response(JSON.stringify({ subscriptions: [{ id: "whk_a" }, { id: "whk_b" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const res = await client.listWebhookSubscriptions("org_1");
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toContain("/v1/webhooks?");
    expect(capturedUrl).toContain("org=org_1");
    expect(res).toHaveLength(2);
  });

  it("listWebhookSubscriptions passes enabled=true when filtered", async () => {
    responder = () =>
      new Response(JSON.stringify({ subscriptions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await client.listWebhookSubscriptions("org_1", { enabled: true });
    expect(capturedUrl).toContain("enabled=true");
  });

  it("getWebhookSubscription GETs the per-id route and returns null on 404", async () => {
    responder = () => new Response("", { status: 404 });
    const res = await client.getWebhookSubscription("whk_x");
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl.endsWith("/v1/webhooks/whk_x")).toBe(true);
    expect(res).toBeNull();
  });

  it("updateWebhookSubscription PATCHes only the fields provided", async () => {
    responder = () =>
      new Response(JSON.stringify({ id: "whk_1", url: "https://new/cb" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await client.updateWebhookSubscription("whk_1", { url: "https://new/cb" });
    expect(capturedMethod).toBe("PATCH");
    expect(capturedUrl.endsWith("/v1/webhooks/whk_1")).toBe(true);
    expect(capturedBody).toEqual({ url: "https://new/cb" });
  });

  it("deleteWebhookSubscription DELETEs the per-id route and tolerates a 204 body", async () => {
    responder = () => new Response(null, { status: 204 });
    await client.deleteWebhookSubscription("whk_1");
    expect(capturedMethod).toBe("DELETE");
    expect(capturedUrl.endsWith("/v1/webhooks/whk_1")).toBe(true);
  });

  it("rotateWebhookSecret POSTs the rotate-secret route and returns the new key", async () => {
    responder = () =>
      new Response(JSON.stringify({ secretVersion: 2, signingKey: "newkey" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const res = await client.rotateWebhookSecret("whk_1");
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl.endsWith("/v1/webhooks/whk_1/rotate-secret")).toBe(true);
    expect(res.secretVersion).toBe(2);
    expect(res.signingKey).toBe("newkey");
  });

  it("testWebhookSubscription POSTs the test route", async () => {
    responder = () =>
      new Response(JSON.stringify({ enqueued: true, eventId: "rel_evt_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const res = await client.testWebhookSubscription("whk_1");
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl.endsWith("/v1/webhooks/whk_1/test")).toBe(true);
    expect(res.enqueued).toBe(true);
  });

  it("getWebhookDeliveries GETs the deliveries route and unwraps AE { data }", async () => {
    responder = () =>
      new Response(
        JSON.stringify({ data: [{ event_id: "e1", outcome: "success", http_status: 200 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const res = await client.getWebhookDeliveries("whk_1", { failed: true, limit: 5 });
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toContain("/v1/webhooks/whk_1/deliveries?");
    expect(capturedUrl).toContain("failed=true");
    expect(capturedUrl).toContain("limit=5");
    expect(res).toHaveLength(1);
    expect(res[0].outcome).toBe("success");
  });
});
