import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeSlug from "rehype-slug";
import { remarkPlugins } from "@/lib/markdown-plugins";
import { docMarkdownComponents } from "./markdown-components";

// Mirrors the exact stack MarkdownDoc drives for docs pages (#1912): the shared
// remark plugins + rehype-slug + the docs component overrides. Shiki is omitted
// (async, code-only) — it's irrelevant to heading ids and link handling.
function renderDoc(md: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={[rehypeSlug]}
      components={docMarkdownComponents}
    >
      {md}
    </ReactMarkdown>,
  );
}

describe("docs markdown pipeline", () => {
  it("stamps GitHub-style ids on headings", () => {
    const html = renderDoc("## Pinning your listing\n\nBody.");
    expect(html).toContain('id="pinning-your-listing"');
  });

  it("renders a hover anchor affordance linking to the heading id", () => {
    const html = renderDoc("## Pinning your listing");
    // The affordance is an <a href="#slug"> beside the heading (icon inside).
    expect(html).toContain('href="#pinning-your-listing"');
    expect(html).toContain('aria-label="Link to this section"');
    expect(html).toContain("<svg");
  });

  it("keeps authored fragment links as in-document anchors", () => {
    const html = renderDoc("See [the section](#pinning-your-listing).");
    expect(html).toContain('href="#pinning-your-listing"');
    // In-document — not a new-tab external link.
    expect(html).not.toContain('target="_blank"');
  });

  it("keeps same-origin app paths as in-document links (e.g. /submit)", () => {
    const html = renderDoc("Then [check and activate](/submit) your listing.");
    expect(html).toContain('href="/submit"');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("nofollow");
  });

  it("still opens external https links in a new tab", () => {
    const html = renderDoc("See [the schema](https://releases.sh/schemas/releases.json).");
    expect(html).toContain('href="https://releases.sh/schemas/releases.json"');
    expect(html).toContain('target="_blank"');
  });

  it("dedupes repeated heading text into distinct ids", () => {
    const html = renderDoc("## Setup\n\ntext\n\n## Setup\n\nmore");
    expect(html).toContain('id="setup"');
    expect(html).toContain('id="setup-1"');
  });
});
