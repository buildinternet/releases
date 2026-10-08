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

const client = await import("../../src/api/workspaces.js");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const WORKSPACES = [
  {
    id: "ws_1",
    name: "Acme",
    slug: "acme",
    logo: null,
    role: "owner",
    active: true,
    createdAt: "",
  },
  {
    id: "ws_2",
    name: "Beta Co",
    slug: "beta-co",
    logo: null,
    role: "member",
    active: false,
    createdAt: "",
  },
];

describe("workspaces client", () => {
  let originalFetch: typeof globalThis.fetch;
  let calls: Array<{ url: string; method: string }> = [];
  let responder: () => Response;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    responder = () => json({ workspaces: WORKSPACES });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return responder();
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("listMyWorkspaces GETs /v1/me/workspaces and unwraps { workspaces }", async () => {
    const workspaces = await client.listMyWorkspaces();
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.endsWith("/v1/me/workspaces")).toBe(true);
    expect(workspaces).toHaveLength(2);
  });

  it("resolveWorkspace matches by exact id", async () => {
    const { match, all } = await client.resolveWorkspace("ws_2");
    expect(match?.slug).toBe("beta-co");
    expect(all).toHaveLength(2);
  });

  it("resolveWorkspace matches by exact slug", async () => {
    const { match } = await client.resolveWorkspace("acme");
    expect(match?.id).toBe("ws_1");
  });

  it("resolveWorkspace returns null with the full list on no match", async () => {
    const { match, all } = await client.resolveWorkspace("nope");
    expect(match).toBeNull();
    expect(all.map((w) => w.slug)).toEqual(["acme", "beta-co"]);
  });
});
