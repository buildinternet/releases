import { beforeAll, describe, expect, mock, test } from "bun:test";

// `render-release-body.ts` guards itself with `import "server-only"`, which
// throws outside a server bundle. Neutralize it, then load the module via a
// dynamic import so the mock is in place before its module graph evaluates
// (bun resolves the static graph before running module bodies).
mock.module("server-only", () => ({}));

let renderReleaseBodyHtml: typeof import("./render-release-body").renderReleaseBodyHtml;
beforeAll(async () => {
  ({ renderReleaseBodyHtml } = await import("./render-release-body"));
});

// The release-body renderer shares the link sanitizer with the docs pipeline
// (#1912). External links still open in a new tab with the external-UGC rel;
// same-page fragment links must NOT — they stay in-document. And a fragment
// link must no longer be stripped to plain text.
describe("renderReleaseBodyHtml link handling", () => {
  test("external links get target=_blank + external UGC rel", () => {
    const html = renderReleaseBodyHtml(
      { content: "See [the docs](https://example.com/docs)." },
      "full",
    );
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
  });

  test("fragment links survive and stay in-document (no target/rel)", () => {
    const html = renderReleaseBodyHtml({ content: "Jump to [the section](#details)." }, "full");
    expect(html).toContain('href="#details"');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("nofollow ugc");
  });

  test("dangerous schemes are still unwrapped to plain text", () => {
    const html = renderReleaseBodyHtml({ content: "[click](javascript:alert(1))" }, "full");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });
});
