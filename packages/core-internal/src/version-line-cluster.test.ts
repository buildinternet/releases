import { describe, expect, it } from "bun:test";
import { clusterVersionLines, type VersionLineInput } from "./version-line-cluster.js";

const NOTES = `Fixed the worker retry loop when a poll overlaps a deployment.

- The scheduler now waits for in-flight activities before swapping versions.
- Added a metric for skipped heartbeats so a quiet worker is visible.
`;

function row(partial: Partial<VersionLineInput> & Pick<VersionLineInput, "id">): VersionLineInput {
  return {
    sourceId: "src_main",
    version: null,
    title: partial.id,
    content: NOTES,
    publishedAt: "2026-10-14T00:00:00.000Z",
    bodyHash: "hash-notes",
    ...partial,
  };
}

describe("clusterVersionLines", () => {
  it("links a release candidate to the stable release on the same source", () => {
    const clusters = clusterVersionLines([
      row({
        id: "rel_rc",
        version: "1.2.0-rc.1",
        title: "1.2.0-rc.1",
        publishedAt: "2026-10-01T00:00:00.000Z",
      }),
      row({
        id: "rel_stable",
        version: "1.2.0",
        title: "1.2.0",
        publishedAt: "2026-10-14T00:00:00.000Z",
      }),
    ]);
    expect(clusters).toEqual([
      {
        canonicalId: "rel_stable",
        coverageIds: ["rel_rc"],
        reason: "version-line:rc:1.2.0",
      },
    ]);
  });

  it("does not link unrelated releases that share a day", () => {
    const clusters = clusterVersionLines([
      row({
        id: "rel_a",
        version: "1.2.0",
        title: "Scheduler",
        content: NOTES,
        bodyHash: "hash-a",
      }),
      row({
        id: "rel_b",
        version: "2.0.0",
        title: "Pricing",
        content:
          "Pricing moved to usage-based billing for the enterprise plan and the self-serve tier.",
        bodyHash: "hash-b",
      }),
    ]);
    expect(clusters).toEqual([]);
  });

  it("links a backport of the same notes onto the higher version line", () => {
    const clusters = clusterVersionLines([
      row({
        id: "rel_old",
        version: "1.26.3",
        title: "1.26.3",
        publishedAt: "2026-10-12T00:00:00.000Z",
      }),
      row({
        id: "rel_new",
        version: "1.27.2",
        title: "1.27.2",
        publishedAt: "2026-10-14T00:00:00.000Z",
      }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.canonicalId).toBe("rel_new");
    expect(clusters[0]!.coverageIds).toEqual(["rel_old"]);
    expect(clusters[0]!.reason).toBe("version-line:backport:1.26.3+1.27.2");
  });

  it("leaves the same notes alone when the versions are months apart", () => {
    const clusters = clusterVersionLines([
      row({
        id: "rel_old",
        version: "1.26.3",
        title: "1.26.3",
        publishedAt: "2026-01-01T00:00:00.000Z",
      }),
      row({
        id: "rel_new",
        version: "1.27.2",
        title: "1.27.2",
        publishedAt: "2026-10-14T00:00:00.000Z",
      }),
    ]);
    expect(clusters).toEqual([]);
  });

  it("links sibling packages that ship the same notes on the same day", () => {
    const clusters = clusterVersionLines([
      row({
        id: "rel_go",
        sourceId: "src_go",
        version: "1.27.2",
        title: "go-sdk 1.27.2",
        content: NOTES + "\nGo client extras.",
      }),
      row({
        id: "rel_py",
        sourceId: "src_py",
        version: "1.27.2",
        title: "python-sdk 1.27.2",
        content: NOTES,
      }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.canonicalId).toBe("rel_go");
    expect(clusters[0]!.coverageIds).toEqual(["rel_py"]);
    expect(clusters[0]!.reason).toBe("version-line:sibling:1.27.2");
  });

  it("links same-source sibling packages without dropping either from the cluster", () => {
    const clusters = clusterVersionLines([
      row({ id: "rel_ollama", version: null, title: "ollama 0.12.0" }),
      row({ id: "rel_py", version: null, title: "ollama-python 0.12.0" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(new Set([clusters[0]!.canonicalId, ...clusters[0]!.coverageIds])).toEqual(
      new Set(["rel_ollama", "rel_py"]),
    );
    expect(clusters[0]!.reason).toBe("version-line:sibling:0.12.0");
  });
});
