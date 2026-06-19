import { describe, it, expect, afterEach, beforeEach } from "bun:test";

const ORIG = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";

const {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  testWebhook,
} = await import("./webhooks.js");

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

describe("webhooks client", () => {
  it("lists with credentials", async () => {
    mockFetch({ subscriptions: [{ id: "whk_1", scope: "follows" }] });
    const subs = await listWebhooks();
    expect(subs).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.test/v1/me/webhooks");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("creates follows-scoped via POST", async () => {
    mockFetch({ id: "whk_2", signingKey: "abc", scope: "follows" });
    const created = await createWebhook({ url: "https://ex.com/h", scope: "follows" });
    expect(created.signingKey).toBe("abc");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      url: "https://ex.com/h",
      scope: "follows",
    });
  });

  it("patches enabled state", async () => {
    mockFetch({ id: "whk_3", enabled: false });
    await updateWebhook("whk_3", { enabled: false });
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ enabled: false });
  });

  it("deletes via DELETE", async () => {
    mockFetch(null, true, 204);
    await deleteWebhook("whk_4");
    expect(calls[0]!.url).toBe("https://api.test/v1/me/webhooks/whk_4");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("rotates secret via POST", async () => {
    mockFetch({ signingKey: "newkey", secretVersion: 2 });
    const out = await rotateWebhookSecret("whk_5");
    expect(out.signingKey).toBe("newkey");
    expect(calls[0]!.url).toContain("/rotate-secret");
  });

  it("test enqueues via POST", async () => {
    mockFetch({ enqueued: true, eventId: "evt_1" });
    const out = await testWebhook("whk_6");
    expect(out.eventId).toBe("evt_1");
    expect(calls[0]!.url).toContain("/test");
  });
});
