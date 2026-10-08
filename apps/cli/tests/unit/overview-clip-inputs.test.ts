import { describe, it, expect } from "bun:test";
import { clipInputsContent } from "../../src/cli/commands/admin/overview.js";
import { type OverviewInputs, type OverviewInputRelease } from "../../src/api/sources.js";

function release(overrides: Partial<OverviewInputRelease> = {}): OverviewInputRelease {
  return {
    id: "rel_1",
    version: "1.0.0",
    title: "Example release",
    content: "x".repeat(5000),
    publishedAt: "2026-05-25T00:00:00Z",
    url: "https://example.com/r/1",
    media: [],
    ...overrides,
  };
}

function inputs(selected: OverviewInputRelease[]): OverviewInputs {
  return {
    org: { id: "org_1", slug: "example", name: "Example", description: null },
    sources: [],
    existingContent: "Prior overview body that should never be clipped.",
    selected,
    totalAvailable: selected.length,
    windowDays: 90,
  };
}

describe("clipInputsContent", () => {
  it("returns the input unchanged (same reference) when maxContentChars is undefined", () => {
    const original = inputs([release()]);
    expect(clipInputsContent(original, undefined)).toBe(original);
  });

  it("clips each selected[].content to at most n characters", () => {
    const result = clipInputsContent(inputs([release(), release({ id: "rel_2" })]), 1000);
    expect(result.selected).toHaveLength(2);
    for (const r of result.selected) {
      expect(r.content.length).toBe(1000);
    }
  });

  it("leaves content shorter than n untouched", () => {
    const short = release({ content: "tiny" });
    const result = clipInputsContent(inputs([short]), 1000);
    expect(result.selected[0]?.content).toBe("tiny");
  });

  it("never drops a release — selected length is preserved", () => {
    const list = [release({ id: "a" }), release({ id: "b" }), release({ id: "c" })];
    const result = clipInputsContent(inputs(list), 100);
    expect(result.selected.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves every non-content field intact (url/title/version/publishedAt/media)", () => {
    const r = release({ media: [{ url: "https://example.com/a.png", type: "image" }] as never });
    const [out] = clipInputsContent(inputs([r]), 10).selected;
    expect(out?.url).toBe(r.url);
    expect(out?.title).toBe(r.title);
    expect(out?.version).toBe(r.version);
    expect(out?.publishedAt).toBe(r.publishedAt);
    expect(out?.media).toEqual(r.media);
  });

  it("leaves existingContent (the prior overview) untouched", () => {
    const original = inputs([release()]);
    const result = clipInputsContent(original, 5);
    expect(result.existingContent).toBe(original.existingContent);
  });

  it("does not mutate the input payload", () => {
    const original = inputs([release()]);
    clipInputsContent(original, 10);
    expect(original.selected[0]?.content.length).toBe(5000);
  });
});
