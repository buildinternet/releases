import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const ORIG = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";

const { completeUploadsCallback, disconnectUploads, fetchUploadsIntegration, startUploadsConnect } =
  await import("./uploads-oauth.js");

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
function mockFetch(response: unknown, ok = true, status = 200) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
      json: async () => response,
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  else process.env.NEXT_PUBLIC_BETTER_AUTH_URL = ORIG;
});

describe("uploads-oauth client", () => {
  it("GETs workspace uploads status", async () => {
    mockFetch({
      provider: "uploads",
      connected: false,
      configured: true,
      connectedAt: null,
      scope: null,
      uploadsWorkspace: null,
    });
    const status = await fetchUploadsIntegration("ws_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/workspaces/ws_1/integrations/uploads");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(status.connected).toBe(false);
  });

  it("POSTs connect and returns authorizeUrl", async () => {
    mockFetch({
      authorizeUrl: "https://uploads.sh/api/auth/oauth2/authorize?x=1",
      redirectUri: "https://releases.sh/integrations/uploads/callback",
    });
    const res = await startUploadsConnect("ws_1");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(res.authorizeUrl).toContain("oauth2/authorize");
  });

  it("POSTs callback code+state", async () => {
    mockFetch({
      provider: "uploads",
      connected: true,
      configured: true,
      connectedAt: "2026-09-15T00:00:00.000Z",
      scope: "files:read",
      uploadsWorkspace: "acme",
      workspaceId: "ws_1",
    });
    const res = await completeUploadsCallback("code", "state");
    expect(calls[0]!.url).toBe("https://api.test/v1/integrations/uploads/callback");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ code: "code", state: "state" });
    expect(res.connected).toBe(true);
    expect(res.uploadsWorkspace).toBe("acme");
  });

  it("DELETEs to disconnect", async () => {
    mockFetch({ provider: "uploads", connected: false, configured: true });
    await disconnectUploads("ws_1");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });
});
