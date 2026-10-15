import { describe, expect, it } from "bun:test";
import { isEmptyContent } from "./release-content.js";

// Pins the inputs that decide whether the ingest-time hook calls Anthropic.
// Anything that returns true skips the AI call and leaves the content_*
// columns NULL — read paths fall back to release.title cleanly.
describe("isEmptyContent", () => {
  it("returns true for empty / whitespace-only bodies", () => {
    expect(isEmptyContent("")).toBe(true);
    expect(isEmptyContent("   \n\t  ")).toBe(true);
  });

  it("returns true for canonical boilerplate phrases", () => {
    expect(isEmptyContent("Updated dependencies")).toBe(true);
    expect(isEmptyContent("dependency update")).toBe(true);
    expect(isEmptyContent("chore")).toBe(true);
    expect(isEmptyContent("Internal release")).toBe(true);
  });

  it("returns true when the body is just markdown chrome", () => {
    expect(isEmptyContent("<!-- placeholder -->")).toBe(true);
    expect(isEmptyContent("![badge](https://x/y.svg)")).toBe(true);
    expect(isEmptyContent("### v1.2.3")).toBe(true);
  });

  it("returns false for real content even when short", () => {
    expect(isEmptyContent("Fixed VSCode bug")).toBe(false);
    expect(isEmptyContent("Adds caching to the Messages API")).toBe(false);
    expect(
      isEmptyContent("Fixed the crash on launch and improved startup time for large workspaces."),
    ).toBe(false);
  });

  it("returns true for generic App Store and no-change filler", () => {
    expect(isEmptyContent("Bug fixes and performance improvements.")).toBe(true);
    expect(isEmptyContent("This update includes bug fixes and performance improvements.")).toBe(
      true,
    );
    expect(isEmptyContent("We've made some bug fixes and performance improvements.")).toBe(true);
    expect(isEmptyContent("No specific changes in this version.")).toBe(true);
    expect(isEmptyContent("Bug fixes.")).toBe(true);
    expect(isEmptyContent("Various bug fixes and stability improvements")).toBe(true);
  });

  it("preserves markdown link text when judging emptiness", () => {
    // The label carries the meaning; "[Vision support](url)" is not empty.
    expect(isEmptyContent("[Vision support](https://example.com/docs)")).toBe(false);
    // A bare badge (image syntax) carries no text and should still read as empty.
    expect(isEmptyContent("![CI](https://badge.example/ci.svg)")).toBe(true);
  });
});
