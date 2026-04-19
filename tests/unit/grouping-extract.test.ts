import { describe, it, expect } from "bun:test";
import { extractClustersFromResponse } from "../../src/ai/grouping.js";

describe("extractClustersFromResponse", () => {
  it("parses valid JSON and returns clusters", () => {
    const raw = JSON.stringify({
      clusters: [{ canonical_id: "rel_a", coverage_ids: ["rel_b"], reason: "ok" }],
    });
    const clusters = extractClustersFromResponse(raw, "end_turn");
    expect(clusters).toEqual([{ canonicalId: "rel_a", coverageIds: ["rel_b"], reason: "ok" }]);
  });

  it("throws a 'response truncated' error when stop_reason is max_tokens", () => {
    // Truncated mid-array — the body would otherwise look parseable to lastIndexOf("}")
    const raw = '{"clusters":[{"canonical_id":"rel_a","coverage_ids":["rel_b"],"reason":"o';
    expect(() => extractClustersFromResponse(raw, "max_tokens")).toThrow(/response truncated/i);
  });

  it("throws the truncation error before attempting to parse", () => {
    // Even if the JSON happens to be parseable, max_tokens means the model didn't
    // finish — we shouldn't trust the partial output.
    const raw = JSON.stringify({
      clusters: [{ canonical_id: "rel_a", coverage_ids: ["rel_b"], reason: "" }],
    });
    expect(() => extractClustersFromResponse(raw, "max_tokens")).toThrow(/response truncated/i);
  });

  it("throws a helpful parse error when JSON is malformed and not truncated", () => {
    const raw = "not valid json at all";
    expect(() => extractClustersFromResponse(raw, "end_turn")).toThrow();
  });

  it("strips markdown fences around JSON", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        clusters: [{ canonical_id: "rel_a", coverage_ids: ["rel_b"], reason: "" }],
      }) +
      "\n```";
    const clusters = extractClustersFromResponse(raw, "end_turn");
    expect(clusters).toHaveLength(1);
    expect(clusters[0].canonicalId).toBe("rel_a");
  });
});
