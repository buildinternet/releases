import { describe, expect, it } from "bun:test";
import { shouldNoIndexRelease } from "./release-noindex";

const base = {
  content: "Real body with content.",
  summary: "",
  sourceIsHidden: false,
  org: { isHidden: false, discovery: "auto" },
};

describe("shouldNoIndexRelease", () => {
  it("indexes a normal release with a body", () => {
    expect(shouldNoIndexRelease(base)).toBe(false);
  });
  it("noindexes an empty-body, empty-summary release", () => {
    expect(shouldNoIndexRelease({ ...base, content: "", summary: "" })).toBe(true);
    expect(shouldNoIndexRelease({ ...base, content: "   \n  ", summary: null })).toBe(true);
  });
  it("still indexes an empty body when a summary exists", () => {
    expect(shouldNoIndexRelease({ ...base, content: "", summary: "Has a summary." })).toBe(false);
  });
  it("keeps existing hidden / on-demand rules", () => {
    expect(shouldNoIndexRelease({ ...base, sourceIsHidden: true })).toBe(true);
    expect(
      shouldNoIndexRelease({ ...base, org: { isHidden: false, discovery: "on_demand" } }),
    ).toBe(true);
    expect(shouldNoIndexRelease({ ...base, org: { isHidden: true, discovery: "auto" } })).toBe(
      true,
    );
  });
});
