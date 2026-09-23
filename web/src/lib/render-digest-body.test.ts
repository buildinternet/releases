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
  test("duplicate headings get deduped ids via createDigestAnchorSlugger", async () => {
    const { createDigestAnchorSlugger } = await import("@releases/rendering/digest-sections");
    const html = renderBodyMarkdownToHtml(
      "### Bug fixes\n\nfirst\n\n### Bug fixes\n\nsecond",
      "full",
      { demoteHeadings: 0, headingIds: createDigestAnchorSlugger() },
    );
    expect(html).toContain('<h3 id="bug-fixes">');
    expect(html).toContain('<h3 id="bug-fixes-2">');
  });

  // headingIdLevel keeps the page's DOM ids in sync with parseDigestSections,
  // which only slugs `###` sections — a `##` heading (or any other level)
  // sharing a slug with a `###` section must not consume a counter slot, or
  // the page's ids drift from the API's parsed `sections[].anchor` values.
  test("headingIdLevel restricts ids to the source heading level (digest ### sections)", async () => {
    const { createDigestAnchorSlugger, parseDigestSections } =
      await import("@releases/rendering/digest-sections");
    const body = "## Bug fixes\n\nintro\n\n### Bug fixes\n\nfirst\n\n### Bug fixes\n\nsecond";
    const expectedAnchors = parseDigestSections(body).map((s) => s.anchor);
    expect(expectedAnchors).toEqual(["bug-fixes", "bug-fixes-2"]);

    const html = renderBodyMarkdownToHtml(body, "full", {
      demoteHeadings: 0,
      headingIds: createDigestAnchorSlugger(),
      headingIdLevel: 3,
    });
    expect(html).toContain('<h3 id="bug-fixes">');
    expect(html).toContain('<h3 id="bug-fixes-2">');
    // The ## heading (source level 2) gets no id at all.
    expect(html).toContain("<h2>Bug fixes</h2>");
    expect(html).not.toMatch(/<h2[^>]*\sid=/);
  });

  // parseDigestSections' anchor must equal the DOM id rehype assigns from the
  // rendered heading's text content (#F2) — code spans and emphasis markers
  // disappear from that text, but link targets were never in it either way.
  test("anchor parity: heading with code + bold markup", async () => {
    const { createDigestAnchorSlugger, parseDigestSections } =
      await import("@releases/rendering/digest-sections");
    const body = "### Faster `bun` **installs**\n\nBody text.";
    const [expected] = parseDigestSections(body).map((s) => s.anchor);
    const html = renderBodyMarkdownToHtml(body, "full", {
      demoteHeadings: 0,
      headingIds: createDigestAnchorSlugger(),
      headingIdLevel: 3,
    });
    expect(expected).toBe("faster-bun-installs");
    expect(html).toContain(`<h3 id="${expected}">`);
  });

  test("anchor parity: linked heading anchors on the link text, not the URL", async () => {
    const { createDigestAnchorSlugger, parseDigestSections } =
      await import("@releases/rendering/digest-sections");
    const body = "### [Cursor](https://cursor.com) ships agents\n\nBody.";
    const [expected] = parseDigestSections(body).map((s) => s.anchor);
    const html = renderBodyMarkdownToHtml(body, "full", {
      demoteHeadings: 0,
      headingIds: createDigestAnchorSlugger(),
      headingIdLevel: 3,
    });
    expect(expected).toBe("cursor-ships-agents");
    expect(html).toContain(`<h3 id="${expected}">`);
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

  // A digest call (releaseLinks set) also owns non-release same-origin links,
  // e.g. a section pointing back at another collection — those should stay
  // same-tab too, not just the /release/<id> ones.
  test("non-release internal links stay same-tab when releaseLinks is set", () => {
    const html = renderBodyMarkdownToHtml("[See collections](/collections/x)", "full", {
      demoteHeadings: 0,
      releaseLinks: new Map(),
    });
    expect(html).toContain('href="/collections/x"');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("nofollow ugc");
  });
});
