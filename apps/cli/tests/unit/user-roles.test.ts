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

describe("user-role client wire contract", () => {
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

  it("setUserRole PATCHes the role route with identifier + role", async () => {
    responder = () =>
      new Response(
        JSON.stringify({ userId: "u_1", email: "a@b.com", previousRole: null, role: "curator" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const res = await client.setUserRole({ email: "a@b.com" }, "curator");
    expect(capturedMethod).toBe("PATCH");
    expect(capturedUrl.endsWith("/v1/admin/users/role")).toBe(true);
    expect(capturedBody).toEqual({ email: "a@b.com", role: "curator" });
    expect(res).toMatchObject({ previousRole: null, role: "curator" });
  });

  it("getUserRole GETs by email and returns null on 404", async () => {
    responder = () =>
      new Response(JSON.stringify({ userId: "u_2", email: "c@d.com", role: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const found = await client.getUserRole({ email: "c@d.com" });
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toContain("/v1/admin/users/role?email=c%40d.com");
    expect(found).toMatchObject({ role: "admin" });

    responder = () =>
      new Response(JSON.stringify({ error: "user_not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    const missing = await client.getUserRole({ userId: "nope" });
    expect(capturedUrl).toContain("/v1/admin/users/role?userId=nope");
    expect(missing).toBeNull();
  });

  it("listUserRoles unwraps the users array", async () => {
    responder = () =>
      new Response(
        JSON.stringify({ users: [{ userId: "u_1", email: "a@b.com", role: "admin" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const users = await client.listUserRoles();
    expect(capturedUrl.endsWith("/v1/admin/users/roles")).toBe(true);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "a@b.com", role: "admin" });
  });

  it("listUserRoles throws on a 404 (route missing) instead of returning []", async () => {
    responder = () =>
      new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    await expect(client.listUserRoles()).rejects.toThrow(/admin users route|404/i);
  });
});
