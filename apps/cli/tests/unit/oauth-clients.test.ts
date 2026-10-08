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

describe("oauth-client client wire contract", () => {
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

  it("createOAuthClient POSTs the create route with the full input", async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          clientId: "abc",
          name: "My App",
          redirectUris: ["https://app/cb"],
          scopes: ["read"],
          trusted: true,
          disabled: false,
          public: false,
          type: "web",
          tokenEndpointAuthMethod: "client_secret_basic",
          clientSecret: "reloc_secret",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    const res = await client.createOAuthClient({
      name: "My App",
      redirectUris: ["https://app/cb"],
      scopes: ["read"],
      trusted: true,
    });
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl.endsWith("/v1/admin/oauth/clients")).toBe(true);
    expect(capturedBody).toEqual({
      name: "My App",
      redirectUris: ["https://app/cb"],
      scopes: ["read"],
      trusted: true,
    });
    expect(res.clientSecret).toBe("reloc_secret");
  });

  it("createOAuthClient passes tokenEndpointAuthMethod=none for public clients", async () => {
    responder = () =>
      new Response(JSON.stringify({ clientId: "p", public: true, clientSecret: null }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    await client.createOAuthClient({
      redirectUris: ["myapp://cb"],
      scopes: ["read"],
      tokenEndpointAuthMethod: "none",
    });
    expect(capturedBody).toMatchObject({ tokenEndpointAuthMethod: "none" });
  });

  it("listOAuthClients GETs the clients route and unwraps { clients }", async () => {
    responder = () =>
      new Response(JSON.stringify({ clients: [{ clientId: "a" }, { clientId: "b" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const res = await client.listOAuthClients();
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl.endsWith("/v1/admin/oauth/clients")).toBe(true);
    expect(res).toHaveLength(2);
  });

  it("getOAuthClient GETs the per-client route and returns null on 404", async () => {
    responder = () => new Response("", { status: 404 });
    const res = await client.getOAuthClient("xyz");
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl.endsWith("/v1/admin/oauth/clients/xyz")).toBe(true);
    expect(res).toBeNull();
  });

  it("updateOAuthClient PATCHes only the flags provided", async () => {
    responder = () =>
      new Response(JSON.stringify({ clientId: "c1", disabled: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await client.updateOAuthClient("c1", { disabled: true });
    expect(capturedMethod).toBe("PATCH");
    expect(capturedUrl.endsWith("/v1/admin/oauth/clients/c1")).toBe(true);
    expect(capturedBody).toEqual({ disabled: true });
  });

  it("updateOAuthClient PATCHes official alone", async () => {
    responder = () =>
      new Response(JSON.stringify({ clientId: "c1", official: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const res = await client.updateOAuthClient("c1", { official: false });
    expect(capturedBody).toEqual({ official: false });
    expect(res.official).toBe(false);
  });

  it("createOAuthClient sends official only when set", async () => {
    responder = () =>
      new Response(JSON.stringify({ clientId: "c2", official: false, clientSecret: null }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    await client.createOAuthClient({ redirectUris: ["https://a/cb"], scopes: ["read"] });
    expect(capturedBody).not.toHaveProperty("official");
    await client.createOAuthClient({
      redirectUris: ["https://a/cb"],
      scopes: ["read"],
      official: false,
    });
    expect(capturedBody).toMatchObject({ official: false });
  });

  it("rotateOAuthClientSecret POSTs the rotate-secret route", async () => {
    responder = () =>
      new Response(JSON.stringify({ clientId: "c1", clientSecret: "reloc_new" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const res = await client.rotateOAuthClientSecret("c1");
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl.endsWith("/v1/admin/oauth/clients/c1/rotate-secret")).toBe(true);
    expect(res.clientSecret).toBe("reloc_new");
  });

  it("deleteOAuthClient DELETEs the per-client route", async () => {
    responder = () =>
      new Response(JSON.stringify({ clientId: "c1", deleted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const res = await client.deleteOAuthClient("c1");
    expect(capturedMethod).toBe("DELETE");
    expect(capturedUrl.endsWith("/v1/admin/oauth/clients/c1")).toBe(true);
    expect(res.deleted).toBe(true);
  });
});
