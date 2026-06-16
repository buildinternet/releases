import { describe, expect, it } from "bun:test";
import { releaseExcerpt, stripLeadingTitle, EXCERPT_MAX_CHARS } from "./release-excerpt";

describe("stripLeadingTitle", () => {
  it("drops a leading heading that duplicates the title", () => {
    expect(stripLeadingTitle("# v1.2.0\nFixed a bug", "v1.2.0")).toBe("Fixed a bug");
  });
  it("returns content unchanged when no leading title", () => {
    expect(stripLeadingTitle("Fixed a bug", "v1.2.0")).toBe("Fixed a bug");
  });
});

describe("releaseExcerpt", () => {
  it("prefers the AI summary when present", () => {
    const out = releaseExcerpt({
      content: "FULL VERBATIM BODY ".repeat(50),
      summary: "A crisp summary.",
      title: "v1",
    });
    expect(out).toBe("A crisp summary.");
  });

  it("falls back to the body when there is no summary, and returns it whole when short", () => {
    expect(releaseExcerpt({ content: "Short note.", summary: "", title: "v1" })).toBe(
      "Short note.",
    );
  });

  it("never returns the full body when it exceeds the cap (SEO invariant)", () => {
    const body = "word ".repeat(400); // ~2000 chars
    const out = releaseExcerpt({ content: body, summary: null, title: "v1" });
    expect(out.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1); // +1 for the ellipsis
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(body.length);
  });

  it("cuts at the first paragraph break within the cap", () => {
    const body = "First paragraph.\n\n" + "x".repeat(500);
    expect(releaseExcerpt({ content: body, summary: null, title: "v1" })).toBe("First paragraph.");
  });

  it("returns empty string for empty content + empty summary", () => {
    expect(releaseExcerpt({ content: "", summary: "", title: "v1" })).toBe("");
    expect(releaseExcerpt({ content: null, summary: null, title: null })).toBe("");
  });
});
