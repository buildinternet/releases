import { describe, it, expect } from "bun:test";
import { validateClusters, type GroupingCandidate, type GroupingCluster } from "../../src/ai/grouping.js";

function candidate(id: string): GroupingCandidate {
  return { id, title: id, version: null, publishedAt: "2026-04-16", sourceSlug: "s", content: "" };
}

const candidates: GroupingCandidate[] = ["rel_a", "rel_b", "rel_c"].map(candidate);

describe("validateClusters", () => {
  it("accepts a valid cluster with canonical + coverage", () => {
    const clusters: GroupingCluster[] = [
      { canonicalId: "rel_a", coverageIds: ["rel_b"], reason: "ok" },
      { canonicalId: "rel_c", coverageIds: [], reason: "standalone" },
    ];
    expect(() => validateClusters(clusters, candidates)).not.toThrow();
  });

  it("accepts all-singletons output", () => {
    const clusters: GroupingCluster[] = [
      { canonicalId: "rel_a", coverageIds: [], reason: "" },
      { canonicalId: "rel_b", coverageIds: [], reason: "" },
      { canonicalId: "rel_c", coverageIds: [], reason: "" },
    ];
    expect(() => validateClusters(clusters, candidates)).not.toThrow();
  });

  it("rejects a hallucinated canonical_id", () => {
    const clusters: GroupingCluster[] = [
      { canonicalId: "rel_missing", coverageIds: [], reason: "" },
    ];
    expect(() => validateClusters(clusters, candidates)).toThrow(/not in input set/);
  });

  it("rejects a hallucinated coverage_id", () => {
    const clusters: GroupingCluster[] = [
      { canonicalId: "rel_a", coverageIds: ["rel_missing"], reason: "" },
      { canonicalId: "rel_b", coverageIds: [], reason: "" },
      { canonicalId: "rel_c", coverageIds: [], reason: "" },
    ];
    expect(() => validateClusters(clusters, candidates)).toThrow(/not in input set/);
  });

  it("rejects an input ID missing from every cluster", () => {
    const clusters: GroupingCluster[] = [
      { canonicalId: "rel_a", coverageIds: [], reason: "" },
      { canonicalId: "rel_b", coverageIds: [], reason: "" },
    ];
    expect(() => validateClusters(clusters, candidates)).toThrow(/missing from output/);
  });

  it("rejects a release appearing in two clusters", () => {
    const clusters: GroupingCluster[] = [
      { canonicalId: "rel_a", coverageIds: ["rel_b"], reason: "" },
      { canonicalId: "rel_b", coverageIds: [], reason: "" },
      { canonicalId: "rel_c", coverageIds: [], reason: "" },
    ];
    expect(() => validateClusters(clusters, candidates)).toThrow(/multiple clusters/);
  });

  it("rejects a release listed as both canonical and coverage in the same cluster", () => {
    const clusters: GroupingCluster[] = [
      { canonicalId: "rel_a", coverageIds: ["rel_a", "rel_b"], reason: "" },
      { canonicalId: "rel_c", coverageIds: [], reason: "" },
    ];
    expect(() => validateClusters(clusters, candidates)).toThrow();
  });

  it("rejects a cluster with an empty canonical_id", () => {
    const clusters: GroupingCluster[] = [
      { canonicalId: "", coverageIds: [], reason: "" },
    ];
    expect(() => validateClusters(clusters, candidates)).toThrow(/missing canonical_id/);
  });
});
