import { describe, it, expect, afterEach, beforeEach } from "bun:test";

const ORIG = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";

const { listApiKeys, createApiKey, revokeApiKey } = await import("./api-keys.js");

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

describe("api-keys client", () => {
  it("lists with credentials and returns the array", async () => {
    mockFetch({ apiKeys: [{ id: "ak_1", name: "k" }] });
    const keys = await listApiKeys();
    expect(keys).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.test/v1/api-keys");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("creates via POST with a JSON body and credentials", async () => {
    mockFetch({ id: "ak_2", key: "relu_secret", name: "ci", scope: "read" }, true, 201);
    const created = await createApiKey({ name: "ci", scope: "read" });
    expect(created.key).toBe("relu_secret");
    expect(calls[0]!.url).toBe("https://api.test/v1/api-keys");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("surfaces the server message on a failed create", async () => {
    mockFetch({ error: "bad_request", message: "scope must be 'read'" }, false, 400);
    await expect(createApiKey({ name: "x" })).rejects.toThrow(/scope must be/);
  });

  it("revokes via DELETE with credentials", async () => {
    mockFetch({ success: true });
    await revokeApiKey("ak_3");
    expect(calls[0]!.url).toBe("https://api.test/v1/api-keys/ak_3");
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(calls[0]!.init?.credentials).toBe("include");
  });
});
