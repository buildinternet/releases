import { describe, expect, it, mock } from "bun:test";
import { openRouterChat } from "./openrouter-client";

function fakeFetch(status: number, body: unknown) {
  return mock(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

describe("openRouterChat", () => {
  it("sends an OpenAI-shaped request and parses text + usage + cost", async () => {
    const f = fakeFetch(200, {
      choices: [{ message: { content: "<marketing>false</marketing>" } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 5,
        cost: 0.0000123,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
    const res = await openRouterChat(
      {
        apiKey: "k",
        model: "google/gemini-2.5-flash-lite",
        referer: "https://releases.sh",
        title: "Releases",
      },
      { system: "SYS", user: "USR", maxTokens: 40 },
      f as unknown as typeof fetch,
    );
    expect(res.text).toBe("<marketing>false</marketing>");
    expect(res.usage).toEqual({
      input: 120,
      output: 5,
      cacheCreate: 0,
      cacheRead: 0,
      costUsd: 0.0000123,
    });

    const call = f.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(headers["HTTP-Referer"]).toBe("https://releases.sh");
    expect(headers["X-Title"]).toBe("Releases");
    expect(headers["X-OpenRouter-Title"]).toBe("Releases");
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("google/gemini-2.5-flash-lite");
    expect(sent.max_tokens).toBe(40);
    expect(sent.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USR" },
    ]);
    expect(sent.usage).toEqual({ include: true });
  });

  it("maps finish_reason 'length' to truncated=true, else false", async () => {
    const cut = await openRouterChat(
      { apiKey: "k", model: "m" },
      { system: "s", user: "u", maxTokens: 1 },
      fakeFetch(200, {
        choices: [{ message: { content: "partial" }, finish_reason: "length" }],
        usage: {},
      }) as unknown as typeof fetch,
    );
    expect(cut.truncated).toBe(true);

    const done = await openRouterChat(
      { apiKey: "k", model: "m" },
      { system: "s", user: "u", maxTokens: 1 },
      fakeFetch(200, {
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: {},
      }) as unknown as typeof fetch,
    );
    expect(done.truncated).toBe(false);
  });

  it("omits cost when the provider does not report it", async () => {
    const f = fakeFetch(200, {
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    const res = await openRouterChat(
      { apiKey: "k", model: "m" },
      { system: "s", user: "u", maxTokens: 1 },
      f as unknown as typeof fetch,
    );
    expect(res.usage.costUsd).toBeUndefined();
    expect(res.usage).toEqual({ input: 10, output: 2, cacheCreate: 0, cacheRead: 0 });
  });

  it("serializes Broadcast trace tags to the snake_case `trace` body field", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "x" } }], usage: {} });
    await openRouterChat(
      {
        apiKey: "k",
        model: "m",
        trace: { generationName: "summarize-release", environment: "production" },
      },
      { system: "s", user: "u", maxTokens: 1 },
      f as unknown as typeof fetch,
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = JSON.parse(init.body as string);
    expect(sent.trace).toEqual({
      generation_name: "summarize-release",
      environment: "production",
    });
  });

  it("omits the `trace` field entirely when no trace tags are set", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "x" } }], usage: {} });
    await openRouterChat(
      { apiKey: "k", model: "m", trace: {} },
      { system: "s", user: "u", maxTokens: 1 },
      f as unknown as typeof fetch,
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = JSON.parse(init.body as string);
    expect(sent.trace).toBeUndefined();
  });

  it("sends session_id + user as top-level body fields and an x-session-id header when set", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "x" } }], usage: {} });
    await openRouterChat(
      {
        apiKey: "k",
        model: "m",
        sessionId: "fetch-src_abc123",
        user: "org:acme",
      },
      { system: "s", user: "u", maxTokens: 1 },
      f as unknown as typeof fetch,
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-session-id"]).toBe("fetch-src_abc123");
    const sent = JSON.parse(init.body as string);
    expect(sent.session_id).toBe("fetch-src_abc123");
    expect(sent.user).toBe("org:acme");
  });

  it("omits session_id/user (body + header) entirely when unset", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "x" } }], usage: {} });
    await openRouterChat(
      { apiKey: "k", model: "m" },
      { system: "s", user: "u", maxTokens: 1 },
      f as unknown as typeof fetch,
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-session-id"]).toBeUndefined();
    const sent = JSON.parse(init.body as string);
    expect("session_id" in sent).toBe(false);
    expect("user" in sent).toBe(false);
  });

  it("truncates session_id and user to 128 chars (body + header)", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "x" } }], usage: {} });
    const longSession = "s".repeat(200);
    const longUser = "u".repeat(200);
    await openRouterChat(
      { apiKey: "k", model: "m", sessionId: longSession, user: longUser },
      { system: "s", user: "u", maxTokens: 1 },
      f as unknown as typeof fetch,
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-session-id"]).toBe("s".repeat(128));
    const sent = JSON.parse(init.body as string);
    expect(sent.session_id).toBe("s".repeat(128));
    expect(sent.session_id.length).toBe(128);
    expect(sent.user).toBe("u".repeat(128));
    expect(sent.user.length).toBe(128);
  });

  it("sends `reasoning` and `provider` as top-level body fields when set", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "x" } }], usage: {} });
    await openRouterChat(
      {
        apiKey: "k",
        model: "deepseek/deepseek-v4-flash",
        reasoning: { enabled: false },
        provider: { ignore: ["gmicloud"] },
      },
      { system: "s", user: "u", maxTokens: 512 },
      f as unknown as typeof fetch,
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = JSON.parse(init.body as string);
    expect(sent.reasoning).toEqual({ enabled: false });
    expect(sent.provider).toEqual({ ignore: ["gmicloud"] });
  });

  it("omits `reasoning` and `provider` entirely when unset", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "x" } }], usage: {} });
    await openRouterChat(
      { apiKey: "k", model: "m" },
      { system: "s", user: "u", maxTokens: 1 },
      f as unknown as typeof fetch,
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = JSON.parse(init.body as string);
    expect("reasoning" in sent).toBe(false);
    expect("provider" in sent).toBe(false);
  });

  it("throws with status + truncated body on non-2xx", async () => {
    const f = fakeFetch(429, "rate limited");
    expect(
      openRouterChat(
        { apiKey: "k", model: "m" },
        { system: "s", user: "u", maxTokens: 1 },
        f as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/OpenRouter 429/);
  });

  it("honors a custom baseURL (AI Gateway sub-path) and strips a trailing slash", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "x" } }], usage: {} });
    await openRouterChat(
      {
        apiKey: "k",
        model: "m",
        baseURL: "https://gateway.ai.cloudflare.com/v1/acct/releases/openrouter/",
      },
      { system: "s", user: "u", maxTokens: 1 },
      f as unknown as typeof fetch,
    );
    const call = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/releases/openrouter/chat/completions",
    );
  });
});
