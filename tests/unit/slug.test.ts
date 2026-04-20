import { describe, it, expect } from "bun:test";
import { toSlug } from "@buildinternet/releases-core/slug";

describe("toSlug", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(toSlug("Hello World")).toBe("hello-world");
  });

  it("strips non-alphanumeric characters", () => {
    expect(toSlug("Foo's Bar! (v2)")).toBe("foo-s-bar-v2");
  });

  it("strips leading and trailing hyphens", () => {
    expect(toSlug("---hello---")).toBe("hello");
  });

  it("collapses consecutive special chars into single hyphen", () => {
    expect(toSlug("one   two---three")).toBe("one-two-three");
  });

  it("handles already-slugified input", () => {
    expect(toSlug("already-a-slug")).toBe("already-a-slug");
  });

  it("handles empty string", () => {
    expect(toSlug("")).toBe("");
  });

  it("handles numeric input", () => {
    expect(toSlug("123 456")).toBe("123-456");
  });
});
