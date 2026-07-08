import { afterEach, describe, expect, it, mock } from "bun:test";
import type { LanguageModel } from "ai";

const fakeModel = {} as LanguageModel;

type GenerateTextResult = {
  text: string;
  usage: Record<string, unknown>;
  finalStep?: { providerMetadata?: Record<string, unknown> };
};

async function withMockedGenerateText(
  impl: (opts: Record<string, unknown>) => Promise<GenerateTextResult>,
  run: (
    aisdkTextModel: typeof import("./aisdk-text-model").aisdkTextModel,
    getOpts: () => Record<string, unknown> | undefined,
  ) => Promise<void>,
) {
  let captured: Record<string, unknown> | undefined;
  mock.module("ai", () => ({
    generateText: async (opts: Record<string, unknown>) => {
      captured = opts;
      return impl(opts);
    },
  }));
  const { aisdkTextModel } = await import("./aisdk-text-model");
  await run(aisdkTextModel, () => captured);
}

describe("aisdkTextModel", () => {
  afterEach(() => {
    mock.restore();
  });

  it("maps AI SDK usage fields and OpenRouter cost metadata", async () => {
    await withMockedGenerateText(
      async () => ({
        text: "HELLO",
        usage: {
          inputTokens: 100,
          outputTokens: 2,
          inputTokenDetails: { noCacheTokens: 10, cacheWriteTokens: 7, cacheReadTokens: 3 },
        },
        finalStep: { providerMetadata: { openrouter: { usage: { cost: 0.0002 } } } },
      }),
      async (aisdkTextModel) => {
        const model = aisdkTextModel(fakeModel, "openrouter:google/gemini-2.5-flash");
        const res = await model.complete({ system: "SYS", user: "U", maxTokens: 40 });
        expect(model.id).toBe("openrouter:google/gemini-2.5-flash");
        expect(res).toEqual({
          text: "HELLO",
          usage: { input: 10, output: 2, cacheCreate: 7, cacheRead: 3, costUsd: 0.0002 },
        });
      },
    );
  });

  it("passes ephemeral cache control when cacheSystem is true", async () => {
    await withMockedGenerateText(
      async () => ({ text: "x", usage: { inputTokens: 1, outputTokens: 1 } }),
      async (aisdkTextModel, getOpts) => {
        const model = aisdkTextModel(fakeModel, "anthropic:claude-haiku-4-5");
        await model.complete({ system: "SYS", user: "U", maxTokens: 40, cacheSystem: true });
        expect(getOpts()?.instructions).toEqual([
          {
            role: "system",
            content: "SYS",
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
          },
        ]);
        expect(getOpts()?.maxRetries).toBe(0);
      },
    );
  });

  it("uses a plain string system prompt when cacheSystem is falsy", async () => {
    await withMockedGenerateText(
      async () => ({ text: "x", usage: { inputTokens: 1, outputTokens: 1 } }),
      async (aisdkTextModel, getOpts) => {
        const model = aisdkTextModel(fakeModel, "anthropic:m");
        await model.complete({ system: "SYS", user: "U", maxTokens: 5 });
        expect(getOpts()?.instructions).toBe("SYS");
      },
    );
  });

  it("forwards timeoutMs as an abort signal", async () => {
    await withMockedGenerateText(
      async () => ({ text: "x", usage: { inputTokens: 1, outputTokens: 1 } }),
      async (aisdkTextModel, getOpts) => {
        const model = aisdkTextModel(fakeModel, "anthropic:m", { timeoutMs: 12_000 });
        await model.complete({ system: "s", user: "u", maxTokens: 1 });
        expect(getOpts()?.abortSignal).toBeInstanceOf(AbortSignal);
      },
    );
  });
});
