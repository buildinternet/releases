import { describe, expect, it } from "bun:test";
import type { MarketingClassifierResult } from "@releases/ai-internal/marketing-classifier";
import { ABSENT_DOUBLE, encodeClassificationPoint } from "./classification-schema.js";
import {
  marketingClassificationInput,
  pointsForInserted,
  type MarketingClassificationRecord,
} from "./classification-points.js";

function record(
  overrides: Partial<MarketingClassificationRecord> & Pick<MarketingClassificationRecord, "index">,
): MarketingClassificationRecord {
  return {
    disposition: "kept",
    failureCategory: null,
    verdict: null,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    durationMs: 10,
    ...overrides,
  };
}

function verdict(
  overrides: Partial<MarketingClassifierResult> & Pick<MarketingClassifierResult, "isMarketing">,
): MarketingClassifierResult {
  return {
    reason: "unspecified",
    usage: { input: 12, output: 2, cacheCreate: 0, cacheRead: 0 },
    ...overrides,
  };
}

describe("pointsForInserted", () => {
  const records = [
    record({ index: 0, disposition: "kept" }),
    record({ index: 1, disposition: "suppressed" }),
    record({
      index: 2,
      disposition: "skipped",
      failureCategory: "cap_tripped",
      provider: null,
      model: null,
      durationMs: null,
      verdict: null,
    }),
    record({
      index: 3,
      disposition: "failed",
      failureCategory: "classify_error",
      verdict: null,
    }),
  ];
  const idByIndex = new Map([
    [0, "rel_kept"],
    [1, "rel_suppressed"],
    [2, "rel_skipped"],
    [3, "rel_conflict"],
  ]);

  it("includes suppressed and inserted skipped rows, and drops conflict ids", () => {
    const returned = new Set(["rel_kept", "rel_suppressed", "rel_skipped"]);
    const points = pointsForInserted(records, idByIndex, returned);
    expect(points.map((point) => point.releaseId)).toEqual([
      "rel_kept",
      "rel_suppressed",
      "rel_skipped",
    ]);
    expect(points.map((point) => point.disposition)).toEqual(["kept", "suppressed", "skipped"]);
  });

  it("drops a cap-skipped record whose row did not insert", () => {
    const returned = new Set(["rel_kept"]);
    const points = pointsForInserted(records, idByIndex, returned);
    expect(points.map((point) => point.releaseId)).toEqual(["rel_kept"]);
  });
});

describe("marketingClassificationInput", () => {
  it("uses the decision choice and leaves an undefined cost null", () => {
    const input = marketingClassificationInput(
      record({
        index: 0,
        disposition: "kept",
        provider: "openrouter",
        model: "typesafe/jev-1.13",
        verdict: verdict({
          isMarketing: false,
          decision: { choice: "real_product_news", selectedChoiceProbability: 0.4 },
        }),
      }),
      { origin: "ingest", releaseId: "rel_abc", sourceId: "src_abc" },
    );
    expect(input.choice).toBe("real_product_news");
    expect(input.reason).toBe("unspecified");
    expect(input.selectedChoiceProbability).toBe(0.4);
    expect(input.providerConfidence).toBeNull();
    expect(input.costUsd).toBeNull();
    expect(encodeClassificationPoint("production", input).doubles[3]).toBe(ABSENT_DOUBLE);
  });

  it("maps a text-model marketing hit to the reason slug", () => {
    const input = marketingClassificationInput(
      record({
        index: 0,
        disposition: "suppressed",
        verdict: verdict({
          isMarketing: true,
          reason: "case_study",
          usage: { input: 3, output: 1, cacheCreate: 0, cacheRead: 0, costUsd: 0 },
        }),
      }),
      { origin: "manual", releaseId: "rel_abc", sourceId: "src_abc" },
    );
    expect(input.choice).toBe("case_study");
    expect(input.reason).toBe("case_study");
    expect(input.costUsd).toBe(0);
    expect(input.selectedChoiceProbability).toBeNull();
  });

  it("stamps the caller-supplied effective threshold, falling back to the default", () => {
    const withThreshold = marketingClassificationInput(
      record({ index: 0, disposition: "kept", verdict: verdict({ isMarketing: false }) }),
      { origin: "ingest", threshold: 0.72 },
    );
    expect(withThreshold.threshold).toBe(0.72);

    const withoutThreshold = marketingClassificationInput(
      record({ index: 0, disposition: "kept", verdict: verdict({ isMarketing: false }) }),
      { origin: "ingest" },
    );
    expect(withoutThreshold.threshold).toBe(0.65);
  });

  it("maps a text-model keep to not_marketing", () => {
    const input = marketingClassificationInput(
      record({
        index: 0,
        disposition: "kept",
        verdict: verdict({ isMarketing: false, reason: "unspecified" }),
      }),
      { origin: "eval" },
    );
    expect(input.choice).toBe("not_marketing");
    expect(input.reason).toBe("unspecified");
  });

  it("emits an empty choice and no usage when classify fails", () => {
    const input = marketingClassificationInput(
      record({
        index: 0,
        disposition: "failed",
        failureCategory: "classify_error",
        verdict: null,
        durationMs: 40,
      }),
      { origin: "ingest" },
    );
    expect(input.choice).toBe("");
    expect(input.reason).toBe("");
    expect(input.failureCategory).toBe("classify_error");
    expect(input.costUsd).toBeNull();
    expect(input.inputTokens).toBeNull();
    expect(input.outputTokens).toBeNull();
    expect(input.durationMs).toBe(40);
    expect(input.selectedChoiceProbability).toBeNull();
  });

  it("leaves provider and model empty when no model was resolved", () => {
    const input = marketingClassificationInput(
      record({
        index: 0,
        disposition: "skipped",
        failureCategory: "no_provider",
        provider: null,
        model: null,
        verdict: null,
        durationMs: null,
      }),
      { origin: "manual" },
    );
    const point = encodeClassificationPoint("production", input);
    expect(point.blobs[6]).toBe("unknown");
    expect(point.blobs[7]).toBe("unknown");
    expect(point.blobs[12]).toBe("no_provider");
    expect(point.doubles[6]).toBe(ABSENT_DOUBLE);
  });
});
