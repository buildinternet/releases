import { describe, it, expect, afterEach, mock } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";

mock.module("../../src/lib/mode.js", () => ({
  getApiUrl: () => "https://test.example.com",
  getApiKey: () => "test-key",
  isRemoteMode: () => true,
  isAdminMode: () => true,
}));

const client = await import("../../src/api/client.js");

const realFetch = globalThis.fetch;

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

function captureFetch(response: unknown, status = 200): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    return new Response(JSON.stringify(response), { status });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const fakeSource = { slug: "acme-changelog" } as Source;

describe("checkContentHash (peek)", () => {
  // Read-only contract: this is the "should I bother extracting?" check.
  // It must NOT commit, otherwise a failed extraction locks out retries
  // (the whole point of #350).

  it("includes ?peek=true in the URL", () => {
    const captured = captureFetch({ unchanged: true });
    return client.checkContentHash(fakeSource, "abc123").then(() => {
      expect(captured[0].url).toContain("peek=true");
    });
  });

  it("returns true when the server says unchanged", async () => {
    captureFetch({ unchanged: true });
    expect(await client.checkContentHash(fakeSource, "abc123")).toBe(true);
  });

  it("returns false when the server says changed", async () => {
    captureFetch({ unchanged: false });
    expect(await client.checkContentHash(fakeSource, "abc123")).toBe(false);
  });

  it("posts the contentHash in the body", () => {
    const captured = captureFetch({ unchanged: false });
    return client.checkContentHash(fakeSource, "deadbeef").then(() => {
      expect(captured[0].body).toEqual({ contentHash: "deadbeef" });
    });
  });
});

describe("recordContentHash (commit)", () => {
  it("does NOT include peek=true in the URL", () => {
    const captured = captureFetch({ unchanged: false });
    return client.recordContentHash(fakeSource, "abc123").then(() => {
      expect(captured[0].url).not.toContain("peek=true");
    });
  });

  it("posts the contentHash in the body", () => {
    const captured = captureFetch({ unchanged: false });
    return client.recordContentHash(fakeSource, "deadbeef").then(() => {
      expect(captured[0].body).toEqual({ contentHash: "deadbeef" });
    });
  });
});
