import { describe, expect, it } from "bun:test";
import type { DecisionModel, DecisionModelRequest } from "./decision-model";
import { classifyMarketing } from "./marketing-classifier";

const input = {
  sourceName: "Acme Blog",
  title: "Customer story",
  content: "x".repeat(2001),
  url: "https://example.com/story",
  hint: "  Keep product launches  ",
  sourceId: "src_private",
};

function decision(choice: string, probability?: unknown, confidence = 1): DecisionModel {
  return {
    id: "openrouter:typesafe/jev-1.13",
    decide: async () =>
      ({
        choice,
        probabilities: { [choice]: probability },
        confidence,
        usage: { inputTokens: 12, outputTokens: 2, costUsd: 0.001 },
      }) as never,
  };
}

describe("marketing decisions", () => {
  it("sends all eight choices and the bounded existing input, without source ids", async () => {
    let payload: DecisionModelRequest<string> | undefined;
    const model: DecisionModel = {
      id: "test",
      decide: async (request) => {
        payload = request;
        return { choice: "real_product_news", usage: {} } as never;
      },
    };
    await classifyMarketing(model, input);
    expect(Object.keys(payload!.question.criteria).toSorted()).toEqual([
      "case_study",
      "event_recap",
      "localized_marketing",
      "newsletter",
      "partner_announcement",
      "positioning_piece",
      "real_product_news",
      "unclear_other",
    ]);
    expect(payload!.state).toBe(
      `Source: Acme Blog\nTitle: Customer story\nURL: https://example.com/story\n\nSource hint: Keep product launches\n\nContent:\n${"x".repeat(2000)}\n\n[truncated]`,
    );
    expect(payload!.state).not.toContain("src_private");
  });

  for (const reason of [
    "case_study",
    "newsletter",
    "event_recap",
    "partner_announcement",
    "positioning_piece",
    "localized_marketing",
  ]) {
    it(`suppresses ${reason} at exactly the default threshold (0.65) even with low provider confidence`, async () => {
      expect(await classifyMarketing(decision(reason, 0.65, 0.1), input)).toEqual({
        isMarketing: true,
        reason,
        decision: { choice: reason, selectedChoiceProbability: 0.65, providerConfidence: 0.1 },
        usage: { input: 12, output: 2, cacheCreate: 0, cacheRead: 0, costUsd: 0.001 },
      });
    });
  }

  for (const [choice, probability, confidence] of [
    ["case_study", 0.64, 0.98],
    ["unclear_other", 0.95, 0.12],
  ] as const) {
    it(`retains the selected choice and distinct diagnostics when keeping ${choice}`, async () => {
      expect(
        await classifyMarketing(decision(choice, probability, confidence), input),
      ).toMatchObject({
        isMarketing: false,
        reason: "unspecified",
        decision: {
          choice,
          selectedChoiceProbability: probability,
          providerConfidence: confidence,
        },
      });
    });
  }

  it("uses opts.threshold instead of the default when provided", async () => {
    // 0.7 is below the legacy 0.80 threshold but at/above the new 0.65 default.
    expect(
      (await classifyMarketing(decision("case_study", 0.7, 1), input, { threshold: 0.65 }))
        .isMarketing,
    ).toBe(true);
    expect(
      (await classifyMarketing(decision("case_study", 0.7, 1), input, { threshold: 0.8 }))
        .isMarketing,
    ).toBe(false);
  });

  it("does not fabricate missing or nonfinite diagnostic scores", async () => {
    const model: DecisionModel = {
      id: "test",
      decide: async () => ({ choice: "unclear_other", usage: {} }) as never,
    };
    expect((await classifyMarketing(model, input)).decision).toEqual({ choice: "unclear_other" });
    expect(
      (await classifyMarketing(decision("case_study", NaN, Infinity), input)).decision,
    ).toEqual({ choice: "case_study" });
  });

  for (const [choice, probability] of [
    ["case_study", 0.649999],
    ["case_study", undefined],
    ["case_study", NaN],
    ["case_study", Infinity],
    ["case_study", -1],
    ["case_study", 1.01],
    ["case_study", "0.99"],
    ["real_product_news", 1],
    ["unclear_other", 1],
    ["unspecified", 1],
    ["invented", 1],
  ] as const) {
    it(`keeps ${choice} with probability ${String(probability)}`, async () => {
      expect((await classifyMarketing(decision(choice, probability), input)).isMarketing).toBe(
        false,
      );
    });
  }

  it("does not substitute another option's probability or provider confidence", async () => {
    const model: DecisionModel = {
      id: "test",
      decide: async () =>
        ({
          choice: "case_study",
          probabilities: { newsletter: 0.99 },
          confidence: 1,
          usage: {},
        }) as never,
    };
    expect((await classifyMarketing(model, input)).isMarketing).toBe(false);
  });

  it("propagates provider errors for callers to keep visible without writing a verdict", async () => {
    const model: DecisionModel = {
      id: "test",
      decide: async () => {
        throw new Error("decision unavailable");
      },
    };
    await expect(classifyMarketing(model, input)).rejects.toThrow("decision unavailable");
  });
});
