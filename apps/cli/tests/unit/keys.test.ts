import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { InvalidArgumentError } from "commander";
import { keysRequest, parseExpiresInDays } from "../../src/cli/commands/keys.js";

const BASE = "https://test.example.com";

// keysRequest routes through the shared apiFetch transport, which resolves
// its base URL from RELEASES_API_URL (see api/core.ts). Point the env at
// BASE so the mocked `fetch` below actually observes the requests. No admin
// credential is set, so apiFetch's own Authorization header stays out of the
// way of the session-token Bearer header keysRequest attaches itself.
const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = BASE;
  delete process.env.RELEASES_API_KEY;
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

describe("parseExpiresInDays", () => {
  it("parses a valid integer in range", () => {
    expect(parseExpiresInDays("30")).toBe(30);
    expect(parseExpiresInDays("1")).toBe(1);
    expect(parseExpiresInDays("365")).toBe(365);
  });

  it("rejects non-numeric input (never returns NaN)", () => {
    expect(() => parseExpiresInDays("abc")).toThrow(InvalidArgumentError);
    expect(() => parseExpiresInDays("30d")).toThrow(InvalidArgumentError);
    expect(() => parseExpiresInDays("")).toThrow(InvalidArgumentError);
  });

  it("rejects non-integers and out-of-range values", () => {
    expect(() => parseExpiresInDays("3.5")).toThrow(InvalidArgumentError);
    expect(() => parseExpiresInDays("0")).toThrow(InvalidArgumentError);
    expect(() => parseExpiresInDays("366")).toThrow(InvalidArgumentError);
    expect(() => parseExpiresInDays("-5")).toThrow(InvalidArgumentError);
  });
});

describe("keysRequest", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends the given session token as a Bearer credential", async () => {
    let seenAuth = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      return new Response(JSON.stringify({ apiKeys: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await keysRequest("/v1/api-keys", { method: "GET" }, "sess_tok");
    expect(seenAuth).toBe("Bearer sess_tok");
  });

  it("surfaces a non-ok response as an ApiError (no retry — there is no stale token to refresh)", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await expect(keysRequest("/v1/api-keys", { method: "GET" }, "sess_tok")).rejects.toThrow();
    expect(call).toBe(1);
  });

  it("attaches an Idempotency-Key on POST", async () => {
    let seenKey = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenKey = String((init?.headers as Record<string, string>)?.["Idempotency-Key"] ?? "");
      return new Response(JSON.stringify({ id: "key_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await keysRequest(
      "/v1/api-keys",
      { method: "POST", body: JSON.stringify({ name: "x" }) },
      "sess_tok",
    );
    expect(seenKey).not.toBe("");
  });

  it("does not attach an Idempotency-Key on GET", async () => {
    let seenKey: string | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenKey = (init?.headers as Record<string, string>)?.["Idempotency-Key"];
      return new Response(JSON.stringify({ apiKeys: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await keysRequest("/v1/api-keys", { method: "GET" }, "sess_tok");
    expect(seenKey).toBeUndefined();
  });
});
