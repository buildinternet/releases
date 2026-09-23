import { beforeAll, describe, expect, mock, test } from "bun:test";

// `render-changelog-html.ts` (and the `render-release-body.ts` it delegates to)
// guard themselves with `import "server-only"`, which throws outside a server
// bundle. Neutralize it, then load the module via a dynamic import so the mock
// is in place before its module graph evaluates.
mock.module("server-only", () => ({}));

let renderChangelogHtml: typeof import("./render-changelog-html").renderChangelogHtml;
beforeAll(async () => {
  ({ renderChangelogHtml } = await import("./render-changelog-html"));
});

// The changelog viewer (`/[org]/[slug]/changelog`, `/sources/[id]/changelog`)
// now server-renders each slice through this shared pipeline so shiki +
// react-markdown stay off the client bundle (#1919). These assert the pipeline
// reproduces the `markdownComponents({ demoteHeadings: 2 })` behavior the old
// client-side `ReactMarkdown` path produced.
describe("renderChangelogHtml", () => {
  test("empty / whitespace content renders to empty string", () => {
    expect(renderChangelogHtml("")).toBe("");
    expect(renderChangelogHtml("   \n  ")).toBe("");
  });

  test("fenced code blocks are shiki-highlighted server-side (dual-theme CSS vars)", () => {
    const html = renderChangelogHtml("```ts\nconst x: number = 1;\n```");
    // Shiki writes both themes as CSS variables (defaultColor:false) — the
    // marker that the highlighter ran rather than a bare <pre><code>.
    expect(html).toContain("--shiki-light");
    expect(html).toContain("--shiki-dark");
    expect(html).toContain("shiki");
  });

  test("headings are demoted by 2 (h1 -> h3), matching the card body pipeline", () => {
    const html = renderChangelogHtml("# Release 1.0\n\n## Fixes");
    expect(html).toContain("<h3");
    expect(html).toContain("<h4");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<h2");
  });

  test("safe inline images are kept (full variant), unlike the collapsed excerpt", () => {
    const html = renderChangelogHtml("![shot](https://example.com/a.png)");
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain("<img");
  });

  test("external links open in a new tab with the external-UGC rel", () => {
    const html = renderChangelogHtml("See [the notes](https://example.com/notes).");
    expect(html).toContain('href="https://example.com/notes"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
  });

  test("dangerous link schemes are unwrapped to plain text", () => {
    const html = renderChangelogHtml("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });
});
