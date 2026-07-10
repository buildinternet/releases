import { describe, expect, it } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { aisdkTextModel } from "./aisdk-text-model";

// Deliberately no `mock.module("ai", …)` here: bun's module mocks are process-global
// and cannot be undone (see AGENTS.md), so stubbing `ai` from this file leaks into
// sibling suites that use the real `generateText` / `Output` (overview-content.test.ts).
// Instead we drive the real `generateText` with a fake `LanguageModelV3`.

type DoGenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

function textModel(
  result: Partial<DoGenerateResult> = {},
  onCall?: () => void,
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      onCall?.();
      return {
        content: [{ type: "text", text: "x" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
        ...result,
      } as DoGenerateResult;
    },
  });
}

/** The system message the SDK forwarded to the provider, if any. */
function systemMessage(model: MockLanguageModelV3) {
  const prompt = model.doGenerateCalls[0]?.prompt ?? [];
  return prompt.find((m) => m.role === "system");
}

describe("aisdkTextModel", () => {
  it("maps AI SDK usage fields and OpenRouter cost metadata", async () => {
    const mock = textModel({
      content: [{ type: "text", text: "HELLO" }],
      usage: {
        inputTokens: { total: 20, noCache: 10, cacheRead: 3, cacheWrite: 7 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      },
      providerMetadata: { openrouter: { usage: { cost: 0.0002 } } },
    });

    const model = aisdkTextModel(mock, "openrouter:google/gemini-2.5-flash");
    const res = await model.complete({ system: "SYS", user: "U", maxTokens: 40 });

    expect(model.id).toBe("openrouter:google/gemini-2.5-flash");
    expect(res).toEqual({
      text: "HELLO",
      usage: { input: 10, output: 2, cacheCreate: 7, cacheRead: 3, costUsd: 0.0002 },
    });
  });

  it("passes ephemeral cache control when cacheSystem is true", async () => {
    const mock = textModel();
    const model = aisdkTextModel(mock, "anthropic:claude-haiku-4-5");

    await model.complete({ system: "SYS", user: "U", maxTokens: 40, cacheSystem: true });

    expect(systemMessage(mock)).toEqual({
      role: "system",
      content: "SYS",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("uses a plain system prompt with no provider options when cacheSystem is falsy", async () => {
    const mock = textModel();
    const model = aisdkTextModel(mock, "anthropic:m");

    await model.complete({ system: "SYS", user: "U", maxTokens: 5 });

    expect(systemMessage(mock)).toEqual({ role: "system", content: "SYS" });
  });

  it("forwards timeoutMs as an abort signal", async () => {
    const mock = textModel();
    const model = aisdkTextModel(mock, "anthropic:m", { timeoutMs: 12_000 });

    await model.complete({ system: "s", user: "u", maxTokens: 1 });

    expect(mock.doGenerateCalls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("does not retry internally (maxRetries: 0) — callers own retry/fail-open", async () => {
    let calls = 0;
    const mock = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        throw new Error("provider down");
      },
    });
    const model = aisdkTextModel(mock, "anthropic:m");

    await expect(model.complete({ system: "s", user: "u", maxTokens: 1 })).rejects.toThrow(
      "provider down",
    );
    expect(calls).toBe(1);
  });
});
