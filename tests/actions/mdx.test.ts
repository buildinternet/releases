import { describe, expect, test } from "bun:test";
import {
  extractTitleHeading,
  flattenMdxToMarkdown,
  parseFrontmatter,
} from "../../actions/publish-changelog/src/mdx.ts";

describe("parseFrontmatter", () => {
  test("splits the leading YAML block from the body", () => {
    const raw = [
      "---",
      "title: Hello",
      "date: 2026-06-01",
      "draft: false",
      "---",
      "",
      "Body text.",
      "",
    ].join("\n");
    const { data, body } = parseFrontmatter(raw);
    expect(data.title).toBe("Hello");
    expect(data.draft).toBe(false);
    expect(body.trim()).toBe("Body text.");
  });

  test("returns an empty frontmatter object when there is no leading block", () => {
    const { data, body } = parseFrontmatter("# Just markdown\n\nHello.\n");
    expect(data).toEqual({});
    expect(body).toBe("# Just markdown\n\nHello.\n");
  });

  test("keeps a plain YAML date as a string (no timezone shift)", () => {
    const { data } = parseFrontmatter("---\ndate: 2026-06-01\n---\nBody\n");
    expect(data.date).toBe("2026-06-01");
  });

  test("draft: true is readable from frontmatter", () => {
    const { data } = parseFrontmatter("---\ntitle: X\ndraft: true\n---\nBody\n");
    expect(data.draft).toBe(true);
  });
});

describe("flattenMdxToMarkdown", () => {
  test("strips import/export lines", () => {
    const body = [
      'import { Callout } from "@/components/callout"',
      "",
      "# Title",
      "",
      "Regular text.",
      "",
      "export const meta = { foo: 1 }",
      "",
    ].join("\n");
    const out = flattenMdxToMarkdown(body);
    expect(out).not.toContain("import ");
    expect(out).not.toContain("export ");
    expect(out).toContain("# Title");
    expect(out).toContain("Regular text.");
  });

  test("flattens a component to its text children", () => {
    const out = flattenMdxToMarkdown('<Callout type="info">Hi there</Callout>');
    expect(out).toBe("Hi there");
  });

  test("flattens nested components", () => {
    const out = flattenMdxToMarkdown("<Update>\n\n<Callout>Nested</Callout>\n\n</Update>");
    expect(out).toContain("Nested");
    expect(out).not.toContain("<Update>");
    expect(out).not.toContain("<Callout>");
  });

  test("drops self-closing components", () => {
    const out = flattenMdxToMarkdown(
      'Before\n\n<Video src="https://example.com/x.mp4" />\n\nAfter',
    );
    expect(out).not.toContain("<Video");
    expect(out).toContain("Before");
    expect(out).toContain("After");
  });

  test("converts img/Image tags to markdown images", () => {
    expect(flattenMdxToMarkdown('<img src="/a.png" alt="A" />')).toBe("![A](/a.png)");
    expect(flattenMdxToMarkdown('<Image src="/b.png" alt="B" />')).toBe("![B](/b.png)");
  });

  test("leaves fenced code blocks untouched", () => {
    const body = [
      "Some text with <Callout>should flatten</Callout>",
      "",
      "```jsx",
      '<Callout type="info">should NOT flatten</Callout>',
      "```",
      "",
      'More <Video src="x.mp4" />text',
    ].join("\n");
    const out = flattenMdxToMarkdown(body);
    expect(out).toContain("should flatten");
    expect(out).not.toContain("<Callout>should flatten");
    expect(out).toContain('<Callout type="info">should NOT flatten</Callout>');
    expect(out).toContain("```jsx");
  });

  test("leaves JSX-looking text inside inline code spans untouched", () => {
    const body = "Use `<Foo />` or `<Bar>x</Bar>` in `Map<K, V>`.";
    expect(flattenMdxToMarkdown(body)).toBe(body);
  });

  test("converts anchor tags to markdown links", () => {
    expect(flattenMdxToMarkdown('See <a href="https://x.dev" target="_blank">the docs</a>.')).toBe(
      "See [the docs](https://x.dev).",
    );
  });

  test("keeps regular markdown, links, and images as-is", () => {
    const body = "[a link](https://example.com) and a real image ![alt](https://example.com/x.png)";
    expect(flattenMdxToMarkdown(body)).toBe(body);
  });
});

describe("extractTitleHeading", () => {
  test("returns the first # heading", () => {
    expect(extractTitleHeading("# Hello World\n\nBody")).toBe("Hello World");
  });

  test("returns null when there is no h1", () => {
    expect(extractTitleHeading("## Not an h1\n\nBody")).toBeNull();
  });
});
