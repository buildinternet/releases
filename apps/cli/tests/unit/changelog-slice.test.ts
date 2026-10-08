import { describe, it, expect } from "bun:test";
import {
  sliceChangelog,
  hasRangeParams,
  parseRangeParam,
  DEFAULT_CHANGELOG_SLICE_LIMIT,
  buildChangelogResponse,
} from "@buildinternet/releases-core/changelog-slice";

const sample = [
  "# CHANGELOG",
  "",
  "Some preamble describing the project.",
  "",
  "## v1.0.0",
  "",
  "- first release",
  "- another bullet",
  "",
  "## v0.9.0",
  "",
  "- beta",
  "- notes that go on for a while to make the section bigger",
  "",
  "### Sub-section",
  "",
  "- nested item",
  "",
  "## v0.8.0",
  "",
  "- older stuff",
  "",
].join("\n");

describe("sliceChangelog", () => {
  it("returns the full file when offset=0 and limit exceeds totalChars", () => {
    const result = sliceChangelog(sample, { offset: 0, limit: 10_000 });
    expect(result.content).toBe(sample);
    expect(result.offset).toBe(0);
    expect(result.nextOffset).toBeNull();
    expect(result.totalChars).toBe(sample.length);
  });

  it("snaps the end to the next heading boundary", () => {
    const result = sliceChangelog(sample, { offset: 0, limit: 50 });
    expect(result.content.endsWith("\n")).toBe(true);
    expect(sample.slice(result.nextOffset ?? 0).startsWith("## ")).toBe(true);
  });

  it("preserves offset=0 so preamble is returned", () => {
    const result = sliceChangelog(sample, { offset: 0, limit: 80 });
    expect(result.content.startsWith("# CHANGELOG")).toBe(true);
  });

  it("snaps a non-zero offset forward to the next heading", () => {
    const result = sliceChangelog(sample, { offset: 3, limit: 50 });
    expect(result.content.startsWith("## ")).toBe(true);
    expect(result.offset).toBeGreaterThan(3);
  });

  it("round-trips: concatenating successive slices reconstructs the file", () => {
    const slices: string[] = [];
    let offset = 0;
    let iterations = 0;
    while (offset < sample.length && iterations < 20) {
      const r = sliceChangelog(sample, { offset, limit: 30 });
      slices.push(r.content);
      if (r.nextOffset == null) break;
      offset = r.nextOffset;
      iterations++;
    }
    expect(slices.join("")).toBe(sample);
  });

  it("returns an empty-ish tail when offset >= totalChars", () => {
    const r = sliceChangelog(sample, { offset: sample.length + 10, limit: 50 });
    expect(r.content).toBe("");
    expect(r.nextOffset).toBeNull();
  });

  it("defaults offset to 0 and applies default limit", () => {
    const r = sliceChangelog(sample, {});
    expect(r.offset).toBe(0);
    expect(r.limit).toBe(DEFAULT_CHANGELOG_SLICE_LIMIT);
  });

  it("makes forward progress even when there are no headings", () => {
    const flat = "plain text with no markdown headings at all ".repeat(200);
    const r = sliceChangelog(flat, { offset: 0, limit: 100 });
    expect(r.content.length).toBeGreaterThan(0);
    expect(r.nextOffset).not.toBeNull();
    expect(r.nextOffset).toBeGreaterThan(0);
  });
});

describe("hasRangeParams", () => {
  it("is false when neither offset nor limit is present", () => {
    expect(hasRangeParams({ offset: null, limit: null })).toBe(false);
    expect(hasRangeParams({})).toBe(false);
  });
  it("is true when either is present", () => {
    expect(hasRangeParams({ offset: "0", limit: null })).toBe(true);
    expect(hasRangeParams({ offset: null, limit: "100" })).toBe(true);
  });
});

describe("parseRangeParam", () => {
  it("returns undefined for null/empty/non-numeric", () => {
    expect(parseRangeParam(null)).toBeUndefined();
    expect(parseRangeParam("")).toBeUndefined();
    expect(parseRangeParam("abc")).toBeUndefined();
  });
  it("parses valid numbers", () => {
    expect(parseRangeParam("42")).toBe(42);
    expect(parseRangeParam("0")).toBe(0);
  });
});

describe("buildChangelogResponse truncation + files", () => {
  const row = {
    path: "CHANGELOG.md",
    filename: "CHANGELOG.md",
    url: "https://github.com/acme/repo/blob/HEAD/CHANGELOG.md",
    rawUrl: "https://raw/CHANGELOG.md",
    content: "# CHANGELOG\n\nhello",
    bytes: 18,
    fetchedAt: "2026-04-14T00:00:00.000Z",
  };

  it("flags truncated=false by default and includes files index", () => {
    const res = buildChangelogResponse(row, { offset: null, limit: null }, [
      {
        path: "CHANGELOG.md",
        filename: "CHANGELOG.md",
        url: row.url,
        bytes: 18,
        fetchedAt: row.fetchedAt,
      },
      {
        path: "packages/a/CHANGELOG.md",
        filename: "CHANGELOG.md",
        url: row.url,
        bytes: 9,
        fetchedAt: row.fetchedAt,
      },
    ]);
    expect(res.truncated).toBe(false);
    expect(res.truncatedAt).toBeNull();
    expect(res.files).toHaveLength(2);
  });

  it("flags truncated=true when bytes >= 1MB and carries truncatedAt", () => {
    const res = buildChangelogResponse(
      { ...row, bytes: 1024 * 1024 },
      { offset: null, limit: null },
      [],
    );
    expect(res.truncated).toBe(true);
    expect(res.truncatedAt).toBe(1024 * 1024);
  });
});
