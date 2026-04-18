import { describe, it, expect } from "bun:test";
import { runIngestTimeGrouping } from "../../src/lib/ingest-grouping.js";
import type { GroupingResult } from "../../src/ai/grouping.js";

const ORG_ID = "org_test";

interface FakeRow {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  sourceSlug: string;
  content: string;
  contentSummary: string | null;
}

function row(id: string): FakeRow {
  return {
    id,
    title: `Title ${id}`,
    version: null,
    publishedAt: "2026-04-16T12:00:00.000Z",
    sourceSlug: "src",
    content: `body ${id}`,
    contentSummary: null,
  };
}

function fakeGrouping(clusters: GroupingResult["clusters"]): GroupingResult {
  return { clusters, model: "fake-model", rawResponse: "" };
}

describe("runIngestTimeGrouping", () => {
  it("skips when fewer than 2 candidates and never calls grouping or link", async () => {
    let groupingCalls = 0;
    let linkCalls = 0;
    const result = await runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a")] as never,
      groupReleases: async () => { groupingCalls++; return fakeGrouping([]); },
      linkCoverage: async () => { linkCalls++; },
    });
    expect(result.written).toBe(0);
    expect(groupingCalls).toBe(0);
    expect(linkCalls).toBe(0);
    expect(result.skipped).toMatch(/candidates < 2|too few/i);
  });

  it("writes coverage rows for non-singleton clusters and skips singletons", async () => {
    const linked: Array<{ canonicalId: string; coverageId: string }> = [];
    const result = await runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a"), row("rel_b"), row("rel_c"), row("rel_d")] as never,
      groupReleases: async () => fakeGrouping([
        { canonicalId: "rel_a", coverageIds: ["rel_b", "rel_c"], reason: "bundle" },
        { canonicalId: "rel_d", coverageIds: [], reason: "" },
      ]),
      linkCoverage: async (row) => { linked.push({ canonicalId: row.canonicalId, coverageId: row.coverageId }); },
    });
    expect(result.written).toBe(2);
    expect(linked).toHaveLength(2);
    expect(linked[0]).toEqual({ canonicalId: "rel_a", coverageId: "rel_b" });
    expect(linked[1]).toEqual({ canonicalId: "rel_a", coverageId: "rel_c" });
  });

  it("fails open when grouping throws — no link calls, no rethrow", async () => {
    let linkCalls = 0;
    const result = await runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a"), row("rel_b")] as never,
      groupReleases: async () => { throw new Error("haiku exploded"); },
      linkCoverage: async () => { linkCalls++; },
    });
    expect(result.written).toBe(0);
    expect(linkCalls).toBe(0);
    expect(result.skipped).toContain("haiku exploded");
  });

  it("fails open when linkCoverage throws — captures error, returns partial count", async () => {
    let linkAttempts = 0;
    const result = await runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a"), row("rel_b"), row("rel_c")] as never,
      groupReleases: async () => fakeGrouping([
        { canonicalId: "rel_a", coverageIds: ["rel_b", "rel_c"], reason: "bundle" },
      ]),
      linkCoverage: async () => {
        linkAttempts++;
        if (linkAttempts === 2) throw new Error("d1 timeout");
      },
    });
    expect(result.written).toBe(1);
    expect(result.skipped).toContain("d1 timeout");
    expect(linkAttempts).toBe(2);
  });

  it("passes the canonical reason and decided_by tag through to linkCoverage", async () => {
    let captured: { reason?: string | null; decidedBy?: string } = {};
    await runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a"), row("rel_b")] as never,
      groupReleases: async () => fakeGrouping([
        { canonicalId: "rel_a", coverageIds: ["rel_b"], reason: "blog mirrors changelog" },
      ]),
      linkCoverage: async (row) => { captured = { reason: row.reason, decidedBy: row.decidedBy }; },
    });
    expect(captured.reason).toBe("blog mirrors changelog");
    expect(captured.decidedBy).toBe("agent:fake-model");
  });

  it("returns zero written when grouping returns only singletons", async () => {
    let linkCalls = 0;
    const result = await runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a"), row("rel_b")] as never,
      groupReleases: async () => fakeGrouping([
        { canonicalId: "rel_a", coverageIds: [], reason: "" },
        { canonicalId: "rel_b", coverageIds: [], reason: "" },
      ]),
      linkCoverage: async () => { linkCalls++; },
    });
    expect(result.written).toBe(0);
    expect(linkCalls).toBe(0);
  });
});
