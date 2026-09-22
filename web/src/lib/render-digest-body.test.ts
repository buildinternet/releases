import { beforeAll, describe, expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));
let renderBodyMarkdownToHtml: typeof import("./render-release-body").renderBodyMarkdownToHtml;
beforeAll(async () => {
  ({ renderBodyMarkdownToHtml } = await import("./render-release-body"));
});
describe("renderBodyMarkdownToHtml demoteHeadings", () => {
  test("demoteHeadings 0 keeps ### as h3 (digest pages)", () => {
    const html = renderBodyMarkdownToHtml(
      "### Section\n\nUses `@pkg` and `wrangler types`.",
      "full",
      { demoteHeadings: 0 },
    );
    expect(html).toContain("<h3");
    expect(html).not.toContain("<h5");
    expect(html).toContain("<code>");
  });
  test("default still demotes by 2 (cards/changelog)", () => {
    const html = renderBodyMarkdownToHtml("### Section\n\nbody", "full");
    expect(html).toContain("<h5");
  });
});

describe("renderBodyMarkdownToHtml headingIds", () => {
  test("adds ids to headings when a slugger is passed", async () => {
    const { digestSectionAnchor } = await import("@releases/rendering/digest-sections");
    const html = renderBodyMarkdownToHtml("### Agents learn to talk\n\nbody", "full", {
      demoteHeadings: 0,
      headingIds: digestSectionAnchor,
    });
    expect(html).toContain('<h3 id="agents-learn-to-talk">');
  });
  test("no ids by default", () => {
    expect(renderBodyMarkdownToHtml("### X\n\nb", "full", { demoteHeadings: 0 })).toContain("<h3>");
  });
});

describe("renderBodyMarkdownToHtml releaseLinks", () => {
  const A = "rel_JotzQfuFf_u8NV4btlouH";
  const B = "rel_ACOkQGJzq0IqqkhoWRR7C";
  test("rewrites release paths upstream and tags them", () => {
    const html = renderBodyMarkdownToHtml(
      `[a](/release/${A}-slug) and [b](/release/${B})`,
      "full",
      {
        demoteHeadings: 0,
        releaseLinks: new Map([
          [A, "https://example.com/a"],
          [B, null],
        ]),
      },
    );
    expect(html).toContain(`href="https://example.com/a"`);
    expect(html).toContain(`data-release-id="${A}"`);
    expect(html).toMatch(/href="https:\/\/example\.com\/a"[^>]*target="_blank"/);
    // No upstream → internal, same tab, still tagged.
    expect(html).toContain(`href="/release/${B}"`);
    expect(html).toContain(`data-release-id="${B}"`);
    expect(html).not.toMatch(new RegExp(`href="/release/${B}"[^>]*target=`));
  });
});
