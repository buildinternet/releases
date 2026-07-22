import { describe, expect, it } from "bun:test";
import { inlineMarkdownToHtml, stripMarkdown } from "./strip-markdown.js";

describe("stripMarkdown", () => {
  it("unwraps inline code instead of deleting it", () => {
    expect(stripMarkdown("bump (`none`/`minor`/`major`)")).toBe("bump (none/minor/major)");
  });

  it("leaves underscores alone — they are identifier characters in changelogs", () => {
    expect(stripMarkdown("the `whats_changed` tool")).toBe("the whats_changed tool");
  });

  it("keeps link text and drops the target", () => {
    expect(stripMarkdown("see [the docs](https://x.test/a)")).toBe("see the docs");
  });

  it("flattens headings and collapses whitespace", () => {
    expect(stripMarkdown("## Shipped\n\n**Fast** now")).toBe("Shipped Fast now");
  });
});

describe("inlineMarkdownToHtml", () => {
  it("promotes emphasis to tags", () => {
    expect(inlineMarkdownToHtml("**Fast** and *loose*")).toBe(
      "<strong>Fast</strong> and <em>loose</em>",
    );
  });

  it("escapes HTML in the source before anything else", () => {
    expect(inlineMarkdownToHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  it("renders links and carries the caller's inline style", () => {
    expect(inlineMarkdownToHtml("[docs](https://x.test/a)", { link: "color:#000;" })).toBe(
      '<a href="https://x.test/a" style="color:#000;">docs</a>',
    );
  });

  it("refuses a non-http(s) link target, keeping the source visible", () => {
    const out = inlineMarkdownToHtml("[click](javascript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).toContain("click");
  });

  it("does not treat emphasis markers inside a code span as syntax", () => {
    expect(inlineMarkdownToHtml("pass `**kwargs` through")).toBe(
      "pass <code>**kwargs</code> through",
    );
  });

  it("does not mistake a bare number for a stashed code span", () => {
    // The placeholder is NUL-delimited precisely so this stays literal.
    expect(inlineMarkdownToHtml("retries after 3 seconds")).toBe("retries after 3 seconds");
  });

  it("agrees with stripMarkdown on what the reader sees", () => {
    const src = "Adds `--dry-run` and **fixes** [#12](https://x.test/12)";
    const html = inlineMarkdownToHtml(src).replace(/<[^>]+>/g, "");
    expect(html).toBe(stripMarkdown(src));
  });
});
