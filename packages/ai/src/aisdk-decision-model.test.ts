import { describe, expect, it } from "bun:test";
import {
  aisdkDecisionModel,
  type AisdkDecisionEvaluate,
  type AisdkDecisionEvaluateRequest,
} from "./aisdk-decision-model";

describe("aisdkDecisionModel", () => {
  it("bounds a stalled decision call by the configured deadline", async () => {
    const evaluate: AisdkDecisionEvaluate = async (request) => {
      expect(request.abortSignal).toBeInstanceOf(AbortSignal);
      return await new Promise((_resolve, reject) => {
        request.abortSignal.addEventListener("abort", () => reject(request.abortSignal.reason), {
          once: true,
        });
      });
    };
    const model = aisdkDecisionModel({} as never, "test", { evaluate, timeoutMs: 5 });
    await expect(
      model.decide({
        state: "test",
        question: { instructions: "Choose", criteria: { safe: "Keep" } },
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("returns a typed choice with probabilities and OpenRouter decision metadata", async () => {
    let request: unknown;
    const evaluate: AisdkDecisionEvaluate = async <OPTION extends string>(
      input: AisdkDecisionEvaluateRequest<OPTION>,
    ) => {
      request = input;
      return {
        answers: {
          decision: {
            type: "choice",
            choice: "newsletter" as OPTION,
            probabilities: { product: 0.07, newsletter: 0.93 } as Record<OPTION, number>,
          },
        },
        usage: { inputTokens: 17, outputTokens: 3, totalTokens: 20 },
        providerMetadata: {
          openrouter: {
            answers: { decision: { confidence: 0.88 } },
            usage: { cost: 0.0000123 },
          },
        },
      };
    };
    const model = aisdkDecisionModel({} as never, "openrouter:typesafe/jev-1.13", { evaluate });

    const result = await model.decide({
      state: "A weekly product update.",
      question: {
        instructions: "Classify this item.",
        criteria: {
          product: "A real product update.",
          newsletter: "A marketing newsletter.",
        },
      },
    });

    const typedChoice: "product" | "newsletter" = result.choice;
    expect(typedChoice).toBe("newsletter");
    expect(result).toEqual({
      choice: "newsletter",
      probabilities: { product: 0.07, newsletter: 0.93 },
      confidence: 0.88,
      usage: { inputTokens: 17, outputTokens: 3, totalTokens: 20, costUsd: 0.0000123 },
    });
    expect(request).toEqual({
      model: expect.anything(),
      state: "A weekly product update.",
      questions: {
        decision: {
          type: "choice",
          instructions: "Classify this item.",
          criteria: {
            product: "A real product update.",
            newsletter: "A marketing newsletter.",
          },
        },
      },
      maxRetries: 0,
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("preserves a choice when the provider omits optional metadata", async () => {
    const evaluate: AisdkDecisionEvaluate = async <OPTION extends string>() => ({
      answers: { decision: { type: "choice", choice: "product" as OPTION } },
      usage: {},
    });
    const model = aisdkDecisionModel({} as never, "openrouter:typesafe/jev-1.13", { evaluate });

    const result = await model.decide({
      state: "A release note.",
      question: {
        instructions: "Classify this item.",
        criteria: { product: "A real product update.", newsletter: "A marketing newsletter." },
      },
    });

    expect(result).toEqual({ choice: "product", usage: {} });
  });
});
