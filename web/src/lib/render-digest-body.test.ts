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
