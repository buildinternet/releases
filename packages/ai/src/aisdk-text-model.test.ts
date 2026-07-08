import { afterEach, describe, expect, it, mock } from "bun:test";
import type { LanguageModel } from "ai";

const fakeModel = {} as LanguageModel;

describe("aisdkTextModel", () => {
  afterEach(() => {
    mock.restore();
  });

  it("maps AI SDK usage fields and OpenRouter cost metadata", async () => {
    mock.module("ai", () => ({
      generateText: async () => ({
        text: "HELLO",
        usage: {
          inputTokens: 100,
          outputTokens: 2,
          inputTokenDetails: { noCacheTokens: 10, cacheWriteTokens: 7, cacheReadTokens: 3 },
        },
        finalStep: { providerMetadata: { openrouter: { usage: { cost: 0.0002 } } } },
      }),
    }));
    const { aisdkTextModel } = await import("./aisdk-text-model");
    const model = aisdkTextModel(fakeModel, "openrouter:google/gemini-2.5-flash");
    const res = await model.complete({ system: "SYS", user: "U", maxTokens: 40 });
    expect(model.id).toBe("openrouter:google/gemini-2.5-flash");
    expect(res).toEqual({
      text: "HELLO",
      usage: { input: 10, output: 2, cacheCreate: 7, cacheRead: 3, costUsd: 0.0002 },
    });
  });

  it("passes ephemeral cache control when cacheSystem is true", async () => {
    let captured: Record<string, unknown> | undefined;
    mock.module("ai", () => ({
      generateText: async (opts: Record<string, unknown>) => {
        captured = opts;
        return {
          text: "x",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    }));
    const { aisdkTextModel } = await import("./aisdk-text-model");
    const model = aisdkTextModel(fakeModel, "anthropic:claude-haiku-4-5");
    await model.complete({ system: "SYS", user: "U", maxTokens: 40, cacheSystem: true });
    expect(captured?.instructions).toEqual([
      {
        role: "system",
        content: "SYS",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ]);
    expect(captured?.maxRetries).toBe(0);
  });

  it("uses a plain string system prompt when cacheSystem is falsy", async () => {
    let captured: Record<string, unknown> | undefined;
    mock.module("ai", () => ({
      generateText: async (opts: Record<string, unknown>) => {
        captured = opts;
        return {
          text: "x",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    }));
    const { aisdkTextModel } = await import("./aisdk-text-model");
    const model = aisdkTextModel(fakeModel, "anthropic:m");
    await model.complete({ system: "SYS", user: "U", maxTokens: 5 });
    expect(captured?.instructions).toBe("SYS");
  });

  it("forwards timeoutMs as an abort signal", async () => {
    let captured: Record<string, unknown> | undefined;
    mock.module("ai", () => ({
      generateText: async (opts: Record<string, unknown>) => {
        captured = opts;
        return {
          text: "x",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    }));
    const { aisdkTextModel } = await import("./aisdk-text-model");
    const model = aisdkTextModel(fakeModel, "anthropic:m", { timeoutMs: 12_000 });
    await model.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(captured?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
