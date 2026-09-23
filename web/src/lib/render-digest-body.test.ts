import { beforeAll, describe, expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));
let renderDigestMarkdownToHtml: typeof import("./render-digest-body").renderDigestMarkdownToHtml;
beforeAll(async () => {
  ({ renderDigestMarkdownToHtml } = await import("./render-digest-body"));
});
describe("renderDigestMarkdownToHtml heading demotion", () => {
  test("### stays h3 (digest pages own their outline)", () => {
    const html = renderDigestMarkdownToHtml("### Section\n\nUses `@pkg` and `wrangler types`.", {
      releaseLinks: new Map(),
    });
    expect(html).toContain("<h3");
    expect(html).not.toContain("<h5");
    expect(html).toContain("<code>");
  });
});

describe("renderDigestMarkdownToHtml heading ids", () => {
  test("adds ids to ### headings", async () => {
    const html = renderDigestMarkdownToHtml("### Agents learn to talk\n\nbody", {
      releaseLinks: new Map(),
    });
    expect(html).toContain('<h3 id="agents-learn-to-talk">');
  });

  test("duplicate headings get deduped ids", () => {
    const html = renderDigestMarkdownToHtml("### Bug fixes\n\nfirst\n\n### Bug fixes\n\nsecond", {
      releaseLinks: new Map(),
    });
    expect(html).toContain('<h3 id="bug-fixes">');
    expect(html).toContain('<h3 id="bug-fixes-2">');
  });

  // Ids are restricted to the source ### heading level — keeps the page's DOM
  // ids in sync with parseDigestSections, which only slugs `###` sections. A
  // `##` heading sharing a slug with a `###` section must not consume a
  // counter slot, or the page's ids drift from the API's parsed
  // `sections[].anchor` values.
  test("only ### headings get ids; a ## heading with the same text gets none", async () => {
    const { parseDigestSections } = await import("@releases/rendering/digest-sections");
    const body = "## Bug fixes\n\nintro\n\n### Bug fixes\n\nfirst\n\n### Bug fixes\n\nsecond";
    const expectedAnchors = parseDigestSections(body).map((s) => s.anchor);
    expect(expectedAnchors).toEqual(["bug-fixes", "bug-fixes-2"]);

    const html = renderDigestMarkdownToHtml(body, { releaseLinks: new Map() });
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
    const { parseDigestSections } = await import("@releases/rendering/digest-sections");
    const body = "### Faster `bun` **installs**\n\nBody text.";
    const [expected] = parseDigestSections(body).map((s) => s.anchor);
    const html = renderDigestMarkdownToHtml(body, { releaseLinks: new Map() });
    expect(expected).toBe("faster-bun-installs");
    expect(html).toContain(`<h3 id="${expected}">`);
  });

  test("anchor parity: linked heading anchors on the link text, not the URL", async () => {
    const { parseDigestSections } = await import("@releases/rendering/digest-sections");
    const body = "### [Cursor](https://cursor.com) ships agents\n\nBody.";
    const [expected] = parseDigestSections(body).map((s) => s.anchor);
    const html = renderDigestMarkdownToHtml(body, { releaseLinks: new Map() });
    expect(expected).toBe("cursor-ships-agents");
    expect(html).toContain(`<h3 id="${expected}">`);
  });
});

describe("renderDigestMarkdownToHtml releaseLinks", () => {
  const A = "rel_JotzQfuFf_u8NV4btlouH";
  const B = "rel_ACOkQGJzq0IqqkhoWRR7C";
  test("rewrites release paths upstream and tags them", () => {
    const html = renderDigestMarkdownToHtml(`[a](/release/${A}-slug) and [b](/release/${B})`, {
      releaseLinks: new Map([
        [A, "https://example.com/a"],
        [B, null],
      ]),
    });
    expect(html).toContain(`href="https://example.com/a"`);
    expect(html).toContain(`data-release-id="${A}"`);
    expect(html).toMatch(/href="https:\/\/example\.com\/a"[^>]*target="_blank"/);
    // No upstream → internal, same tab, still tagged.
    expect(html).toContain(`href="/release/${B}"`);
    expect(html).toContain(`data-release-id="${B}"`);
    expect(html).not.toMatch(new RegExp(`href="/release/${B}"[^>]*target=`));
  });

  // A digest render also owns non-release same-origin links, e.g. a section
  // pointing back at another collection — those should stay same-tab too,
  // not just the /release/<id> ones.
  test("non-release internal links stay same-tab", () => {
    const html = renderDigestMarkdownToHtml("[See collections](/collections/x)", {
      releaseLinks: new Map(),
    });
    expect(html).toContain('href="/collections/x"');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("nofollow ugc");
  });

  test("fragment links stay in-document", () => {
    const html = renderDigestMarkdownToHtml("Jump to [details](#details).", {
      releaseLinks: new Map(),
    });
    expect(html).toContain('href="#details"');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("nofollow ugc");
  });

  test("external links still get target=_blank + external UGC rel", () => {
    const html = renderDigestMarkdownToHtml("See [docs](https://example.com/docs).", {
      releaseLinks: new Map(),
    });
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
  });
});
