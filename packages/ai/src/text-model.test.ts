import { describe, expect, it } from "bun:test";
import { anthropicTextModel, openRouterTextModel } from "./text-model";

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
