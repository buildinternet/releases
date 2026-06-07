import { describe, expect, it } from "bun:test";
import {
  anthropicTextModel,
  openRouterTextModel,
  withUsageLogging,
  type UsageRecord,
} from "./text-model";

describe("anthropicTextModel", () => {
  it("sends a cache_control system block when cacheSystem is true and maps usage", async () => {
    let received: Record<string, unknown> | undefined;
    const fakeClient = {
      messages: {
        create: async (args: Record<string, unknown>) => {
          received = args;
          return {
            content: [{ type: "text", text: "HELLO" }],
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              cache_creation_input_tokens: 7,
              cache_read_input_tokens: 3,
            },
          };
        },
      },
    };
    const model = anthropicTextModel(fakeClient as never, "claude-haiku-4-5");
    const res = await model.complete({
      system: "SYS",
      user: "U",
      maxTokens: 40,
      cacheSystem: true,
    });
    expect(model.id).toBe("anthropic:claude-haiku-4-5");
    expect(res.text).toBe("HELLO");
    expect(res.usage).toEqual({ input: 10, output: 2, cacheCreate: 7, cacheRead: 3 });
    expect(received).toMatchObject({
      model: "claude-haiku-4-5",
      max_tokens: 40,
      system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "U" }],
    });
  });

  it("sends a plain string system prompt when cacheSystem is falsy", async () => {
    let received: Record<string, unknown> | undefined;
    const fakeClient = {
      messages: {
        create: async (args: Record<string, unknown>) => {
          received = args;
          return {
            content: [{ type: "text", text: "x" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    };
    const model = anthropicTextModel(fakeClient as never, "m");
    const res = await model.complete({ system: "SYS", user: "U", maxTokens: 5 });
    expect(received?.system).toBe("SYS");
    // Missing cache fields default to 0.
    expect(res.usage).toEqual({ input: 1, output: 1, cacheCreate: 0, cacheRead: 0 });
  });
});

describe("openRouterTextModel", () => {
  it("delegates to the transport, exposes a provider id, and drops cacheSystem", async () => {
    let sentReq: unknown;
    const model = openRouterTextModel(
      { apiKey: "k", model: "google/gemini-2.5-flash-lite" },
      async (_opts, req) => {
        sentReq = req;
        return {
          text: "OUT",
          usage: { input: 5, output: 1, cacheCreate: 0, cacheRead: 0, costUsd: 0.0001 },
        };
      },
    );
    const res = await model.complete({ system: "s", user: "u", maxTokens: 40, cacheSystem: true });
    expect(model.id).toBe("openrouter:google/gemini-2.5-flash-lite");
    expect(res).toEqual({
      text: "OUT",
      usage: { input: 5, output: 1, cacheCreate: 0, cacheRead: 0, costUsd: 0.0001 },
    });
    // cacheSystem is not forwarded to the OpenRouter transport.
    expect(sentReq).toEqual({ system: "s", user: "u", maxTokens: 40 });
  });
});

function fakeModel(id: string, usage: import("./text-model").TextModelUsage) {
  return { id, complete: async () => ({ text: "OUT", usage }) };
}
const ZERO = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };

describe("withUsageLogging", () => {
  it("preserves id and returns the inner result unchanged", async () => {
    const inner = fakeModel("anthropic:claude-haiku-4-5", { ...ZERO, input: 5, output: 2 });
    const wrapped = withUsageLogging(inner, { lane: "x", sink: () => {} });
    expect(wrapped.id).toBe("anthropic:claude-haiku-4-5");
    const res = await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(res).toEqual({ text: "OUT", usage: { ...ZERO, input: 5, output: 2 } });
  });

  it("emits a record with provider/model split from the id, lane, env, and tokens", async () => {
    let rec: UsageRecord | undefined;
    const inner = fakeModel("openrouter:google/gemini-2.5-flash-lite", {
      input: 10,
      output: 3,
      cacheCreate: 1,
      cacheRead: 4,
      costUsd: 0.0002,
    });
    const wrapped = withUsageLogging(inner, {
      lane: "marketing-classifier",
      environment: "production",
      sink: (r) => {
        rec = r;
      },
    });
    await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(rec).toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
      lane: "marketing-classifier",
      environment: "production",
      input: 10,
      output: 3,
      cacheCreate: 1,
      cacheRead: 4,
      costUsd: 0.0002,
    });
  });

  it("derives cost via deriveCost when the provider reports none", async () => {
    let rec: UsageRecord | undefined;
    const inner = fakeModel("anthropic:claude-haiku-4-5", { ...ZERO, input: 100, output: 20 });
    const wrapped = withUsageLogging(inner, {
      lane: "summarize-release",
      sink: (r) => {
        rec = r;
      },
      deriveCost: (provider, model) => (provider === "anthropic" ? 0.005 : undefined),
    });
    await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(rec?.costUsd).toBe(0.005);
  });

  it("preserves costUsd: 0 rather than falling through to deriveCost", async () => {
    let rec: UsageRecord | undefined;
    const inner = fakeModel("openrouter:m", { ...ZERO, costUsd: 0 });
    const wrapped = withUsageLogging(inner, {
      lane: "x",
      sink: (r) => {
        rec = r;
      },
      deriveCost: () => 99,
    });
    await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(rec?.costUsd).toBe(0);
  });

  it("does not break the call when the sink throws", async () => {
    const inner = fakeModel("anthropic:m", { ...ZERO });
    const wrapped = withUsageLogging(inner, {
      lane: "x",
      sink: () => {
        throw new Error("axiom down");
      },
    });
    const res = await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(res.text).toBe("OUT");
  });

  it("does not break the call when deriveCost throws", async () => {
    const inner = fakeModel("anthropic:m", { ...ZERO });
    const wrapped = withUsageLogging(inner, {
      lane: "x",
      sink: () => {},
      deriveCost: () => {
        throw new Error("pricing boom");
      },
    });
    const res = await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(res.text).toBe("OUT");
  });
});
