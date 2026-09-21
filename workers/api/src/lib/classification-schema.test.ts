import { describe, expect, it } from "bun:test";
import {
  ABSENT_DOUBLE,
  MARKETING_POLICY_VERSION,
  MARKETING_SUPPRESSION_THRESHOLD,
  NO_SOURCE_INDEX,
  encodeClassificationPoint,
  writeClassificationPoint,
  type ClassificationDataPoint,
} from "./classification-schema.js";

const base = {
  origin: "ingest" as const,
  disposition: "kept" as const,
  policyVersion: MARKETING_POLICY_VERSION,
};

describe("encodeClassificationPoint", () => {
  it("writes the positional schema and a unit event count", () => {
    const point = encodeClassificationPoint("production", {
      ...base,
      releaseId: "rel_abcDEF123",
      sourceId: "src_abcDEF123",
      provider: "openrouter",
      model: "typesafe/jev-1.13",
      choice: "real_product_news",
      reason: "unspecified",
      selectedChoiceProbability: 1,
      providerConfidence: 0.42,
      costUsd: 0.001,
      inputTokens: 100,
      outputTokens: 8,
      durationMs: 320,
    });

    expect(point.indexes).toEqual(["src_abcDEF123"]);
    expect(point.blobs).toEqual([
      "1",
      "production",
      "ingest",
      "marketing",
      "rel_abcDEF123",
      "src_abcDEF123",
      "openrouter",
      "typesafe/jev-1.13",
      "real_product_news",
      "kept",
      "unspecified",
      MARKETING_POLICY_VERSION,
      "",
    ]);
    expect(point.doubles).toEqual([
      1,
      0.42,
      MARKETING_SUPPRESSION_THRESHOLD,
      0.001,
      100,
      8,
      320,
      1,
    ]);
  });

  it("uses a negative sentinel for absent or invalid probabilities", () => {
    const point = encodeClassificationPoint("staging", {
      ...base,
      origin: "manual",
      disposition: "suppressed",
      selectedChoiceProbability: Number.NaN,
      providerConfidence: 1.4,
      costUsd: -3,
      inputTokens: Number.POSITIVE_INFINITY,
    });

    expect(point.blobs[1]).toBe("staging");
    expect(point.blobs[2]).toBe("manual");
    expect(point.doubles[0]).toBe(ABSENT_DOUBLE);
    expect(point.doubles[1]).toBe(ABSENT_DOUBLE);
    expect(point.doubles[3]).toBe(ABSENT_DOUBLE);
    expect(point.doubles[4]).toBe(ABSENT_DOUBLE);
    expect(point.doubles[2]).toBe(MARKETING_SUPPRESSION_THRESHOLD);
  });

  it("keeps zero cost and a probability of zero", () => {
    const point = encodeClassificationPoint(undefined, {
      ...base,
      selectedChoiceProbability: 0,
      providerConfidence: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    });
    expect(point.blobs[1]).toBe("development");
    expect(point.doubles.slice(0, 7)).toEqual([0, 0, MARKETING_SUPPRESSION_THRESHOLD, 0, 0, 0, 0]);
  });

  it("drops ids, choices, and error text that are not safe tokens", () => {
    const point = encodeClassificationPoint("production", {
      ...base,
      origin: "eval",
      disposition: "failed",
      releaseId: "not-a-release",
      sourceId: "src_ok'; DROP TABLE",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      choice: "How Acme cut costs https://secret.example/post",
      reason: "provider said: billing hard limit reached",
      failureCategory: "rate limit: try again",
    });

    const flat = [...point.indexes, ...point.blobs].join("\n");
    expect(point.indexes).toEqual([NO_SOURCE_INDEX]);
    expect(point.blobs[4]).toBe("");
    expect(point.blobs[5]).toBe("");
    expect(point.blobs[8]).toBe("");
    expect(point.blobs[10]).toBe("");
    expect(point.blobs[12]).toBe("");
    expect(flat).not.toContain("http");
    expect(flat).not.toContain("Acme");
    expect(flat).not.toContain("billing");
    expect(flat).not.toContain("DROP");
    expect(flat).not.toContain("'");
  });

  it("separates origins", () => {
    const origins = ["ingest", "manual", "eval"] as const;
    for (const origin of origins) {
      const point = encodeClassificationPoint("production", { ...base, origin });
      expect(point.blobs[2]).toBe(origin);
    }
  });
});

describe("writeClassificationPoint", () => {
  it("no-ops when the dataset binding is absent", () => {
    expect(() => writeClassificationPoint(undefined, "production", base)).not.toThrow();
  });

  it("swallows a thrown write", () => {
    const dataset = {
      writeDataPoint(): void {
        throw new Error("analytics engine unavailable: secret title https://example.com");
      },
    };
    expect(() => writeClassificationPoint(dataset, "production", base)).not.toThrow();
  });

  it("forwards the encoded point", () => {
    const points: ClassificationDataPoint[] = [];
    writeClassificationPoint({ writeDataPoint: (point) => points.push(point) }, "production", {
      ...base,
      sourceId: "src_abc",
      choice: "case_study",
      disposition: "suppressed",
    });
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs[9]).toBe("suppressed");
    expect(points[0]?.blobs[8]).toBe("case_study");
  });
});
