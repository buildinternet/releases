import { describe, it, expect } from "bun:test";
import { runIngestTimeGrouping } from "../../src/lib/ingest-grouping.js";
import type { GroupingResult, GroupingInputRow } from "../../src/ai/grouping.js";
import type { getRecentReleasesByOrg } from "../../src/db/queries.js";

const ORG_ID = "org_test";

type CandidateRow = Awaited<ReturnType<typeof getRecentReleasesByOrg>>[number];

function row(id: string): CandidateRow {
  const base: GroupingInputRow = {
    id,
    title: `Title ${id}`,
    version: null,
    publishedAt: "2026-04-16T12:00:00.000Z",
    sourceSlug: "src",
    content: `body ${id}`,
    contentSummary: null,
  };
  // The DB row carries a handful of extra columns the helper ignores —
  // filling them with plausible values keeps the fixture honest.
  return {
    ...base,
    sourceId: "src_test",
    type: "feature",
    url: null,
    contentHash: null,
    metadata: null,
    media: null,
    suppressed: false,
    suppressedReason: null,
    fetchedAt: "2026-04-16T12:00:00.000Z",
    embeddedAt: null,
    sourceName: "Source",
  } satisfies CandidateRow;
}

function fakeGrouping(clusters: GroupingResult["clusters"]): GroupingResult {
  return { clusters, model: "fake-model", rawResponse: "" };
}

describe("runIngestTimeGrouping", () => {
  it("skips when fewer than 2 candidates and never calls grouping or link", async () => {
    let groupingCalls = 0;
    let linkCalls = 0;
    const written = await runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a")],
      groupReleases: async () => { groupingCalls++; return fakeGrouping([]); },
      linkCoverage: async () => { linkCalls++; },
    });
    expect(written).toBe(0);
    expect(groupingCalls).toBe(0);
    expect(linkCalls).toBe(0);
  });

  it("writes coverage rows for non-singleton clusters and skips singletons", async () => {
    const linked: Array<{ canonicalId: string; coverageId: string }> = [];
    const written = await runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a"), row("rel_b"), row("rel_c"), row("rel_d")],
      groupReleases: async () => fakeGrouping([
        { canonicalId: "rel_a", coverageIds: ["rel_b", "rel_c"], reason: "bundle" },
        { canonicalId: "rel_d", coverageIds: [], reason: "" },
      ]),
      linkCoverage: async (r) => { linked.push({ canonicalId: r.canonicalId, coverageId: r.coverageId }); },
    });
    expect(written).toBe(2);
    expect(linked).toHaveLength(2);
    expect(linked[0]).toEqual({ canonicalId: "rel_a", coverageId: "rel_b" });
    expect(linked[1]).toEqual({ canonicalId: "rel_a", coverageId: "rel_c" });
  });

  it("propagates grouping errors to the caller (fail-open is the caller's job)", async () => {
    let linkCalls = 0;
    const promise = runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a"), row("rel_b")],
      groupReleases: async () => { throw new Error("haiku exploded"); },
      linkCoverage: async () => { linkCalls++; },
    });
    await expect(promise).rejects.toThrow(/haiku exploded/);
    expect(linkCalls).toBe(0);
  });

  it("propagates link errors to the caller", async () => {
    let linkAttempts = 0;
    const promise = runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a"), row("rel_b"), row("rel_c")],
      groupReleases: async () => fakeGrouping([
        { canonicalId: "rel_a", coverageIds: ["rel_b", "rel_c"], reason: "bundle" },
      ]),
      linkCoverage: async () => {
        linkAttempts++;
        if (linkAttempts === 2) throw new Error("d1 timeout");
      },
    });
    await expect(promise).rejects.toThrow(/d1 timeout/);
    expect(linkAttempts).toBe(2);
  });

  it("passes the canonical reason and decided_by tag through to linkCoverage", async () => {
    let captured: { reason?: string | null; decidedBy?: string } = {};
    await runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a"), row("rel_b")],
      groupReleases: async () => fakeGrouping([
        { canonicalId: "rel_a", coverageIds: ["rel_b"], reason: "blog mirrors changelog" },
      ]),
      linkCoverage: async (r) => { captured = { reason: r.reason, decidedBy: r.decidedBy }; },
    });
    expect(captured.reason).toBe("blog mirrors changelog");
    expect(captured.decidedBy).toBe("agent:fake-model");
  });

  it("returns zero written when grouping returns only singletons", async () => {
    let linkCalls = 0;
    const written = await runIngestTimeGrouping(ORG_ID, "ctx", {
      fetchCandidates: async () => [row("rel_a"), row("rel_b")],
      groupReleases: async () => fakeGrouping([
        { canonicalId: "rel_a", coverageIds: [], reason: "" },
        { canonicalId: "rel_b", coverageIds: [], reason: "" },
      ]),
      linkCoverage: async () => { linkCalls++; },
    });
    expect(written).toBe(0);
    expect(linkCalls).toBe(0);
  });
});
