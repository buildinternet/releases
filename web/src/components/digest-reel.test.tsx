import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { toReelPreview, type ReelDigest } from "@/lib/digest-reel";
import { DigestReel } from "./digest-reel.tsx";
import { DigestSectionPreview, focusIsInside } from "./digest-reel-section.tsx";

const org = (slug: string, name: string) => ({ slug, name, avatarUrl: null, githubHandle: null });
const openai = org("openai", "OpenAI");
const neon = org("neon", "Neon");

const release = (id: string, title: string, url: string | null, o = openai) => ({
  id,
  title,
  url,
  path: `/release/${id}`,
  org: o,
  product: o === openai ? { slug: "codex", name: "Codex" } : null,
});

const codingAgents: ReelDigest = {
  collection: { slug: "coding-agents", name: "Coding Agents", isFeatured: true },
  weekStart: "2026-09-14",
  title: "Agents get a voice",
  intro: "Codex and Devin both added live voice sessions.",
  releaseCount: 13,
  orgs: [openai, neon],
  sections: [
    {
      heading: "Agents learn to talk",
      anchor: "agents-learn-to-talk",
      lede: "Coding agents started speaking.",
      releases: [
        release("rel_voice", "Voice conversations arrive", "https://example.com/codex#voice"),
        release("rel_neon", "Branching backends", null, neon),
      ],
    },
    {
      heading: "Hardening the edges",
      anchor: "hardening-the-edges",
      lede: "",
      releases: [release("rel_cache", "Prompt cache fix", "https://example.com/codex#cache")],
    },
  ],
};

const serverlessPostgres: ReelDigest = {
  collection: { slug: "serverless-postgres", name: "Serverless Postgres", isFeatured: false },
  weekStart: "2026-09-14",
  title: "Neon turns branches into backends",
  intro: "",
  releaseCount: 60,
  orgs: [neon],
  sections: [],
};

// Renders through `toReelPreview` — the same server trim `page.tsx` runs —
// so these tests exercise the real client payload, not the full `ReelDigest`.
const render = (digests: ReelDigest[]) =>
  renderToStaticMarkup(<DigestReel preview={toReelPreview(digests)} />);

/** All `<a …>` opening tags whose href matches `href` exactly. */
const anchorsTo = (html: string, href: string) =>
  [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((a) => a.includes(`href="${href}"`));

describe("DigestReel", () => {
  it("renders nothing for an empty list", () => {
    expect(render([])).toBe("");
  });

  it("section rows are same-tab internal links to the digest anchor", () => {
    const html = render([codingAgents, serverlessPostgres]);
    for (const anchor of ["agents-learn-to-talk", "hardening-the-edges"]) {
      const links = anchorsTo(html, `/collections/coding-agents/digest/2026-09-14#${anchor}`);
      expect(links.length).toBe(1);
      expect(links[0]).not.toContain('target="_blank"');
    }
    expect(html).toContain("Agents learn to talk");
    expect(html).toContain(">01<");
    expect(html).toContain(">02<");
  });

  it("card title and footer link to the digest issue", () => {
    const html = render([codingAgents, serverlessPostgres]);
    const links = anchorsTo(html, "/collections/coding-agents/digest/2026-09-14");
    // Title + "Read issue →".
    expect(links.length).toBe(2);
    expect(html).toMatch(
      /<h3[^>]*><a[^>]*href="\/collections\/coding-agents\/digest\/2026-09-14"[^>]*>Agents get a voice<\/a><\/h3>/,
    );
    expect(html).toContain('aria-label="Read issue: Coding Agents digest"');
    expect(html).toContain("13 releases · 2 orgs");
    expect(html).toContain("60 releases · 1 org");
    expect(html).toContain("Sep 14 – 20");
  });

  it("orders featured first and lists overflow under “Also this week”", () => {
    const html = render([serverlessPostgres, codingAgents]);
    // Both fit at the default card count: featured leads, no overflow row.
    expect(html.indexOf("Coding Agents")).toBeLessThan(html.indexOf("Serverless Postgres"));
    expect(html).not.toContain("Also this week");

    const many = Array.from({ length: 7 }, (_, i) => ({
      ...serverlessPostgres,
      collection: { slug: `c${i}`, name: `Collection ${i}`, isFeatured: false },
      releaseCount: 10 - i,
    }));
    const overflowHtml = render(many);
    expect(overflowHtml).toContain("Also this week");
    // The 7th (fewest releases) is not a card, only an "Also this week" link.
    expect(anchorsTo(overflowHtml, "/collections/c6/digest/2026-09-14").length).toBe(1);
    expect(overflowHtml).not.toContain('aria-label="Read issue: Collection 6 digest"');
    expect(overflowHtml).toContain('aria-label="Read issue: Collection 5 digest"');
    expect(anchorsTo(overflowHtml, "/collections").length).toBe(1);
  });

  it("header carries the week, collection count, and scroll controls", () => {
    const html = render([codingAgents, serverlessPostgres]);
    expect(html).toContain("Weekly digests");
    expect(html).toContain("Week of Sep 14 – 20 · 2 collections");
    expect(html).toContain('aria-label="Previous digests"');
    expect(html).toContain('aria-label="Next digests"');
  });

  it("does not render the hover card (or its upstream release links) until hovered", () => {
    const html = render([codingAgents]);
    expect(html).not.toContain("data-release-id");
    expect(html).not.toContain("Read the section");
  });
});

describe("DigestSectionPreview (hover card)", () => {
  // The card/section the client actually receives after `toReelPreview`'s
  // server-side trim — not the raw `ReelDigest` fixture.
  const card = toReelPreview([codingAgents]).cards[0];
  const section = card.sections[0];
  const html = renderToStaticMarkup(<DigestSectionPreview digest={card} section={section} />);

  it("upstream release links open in a new tab and carry data-release-id", () => {
    const [upstream] = anchorsTo(html, "https://example.com/codex#voice");
    expect(upstream).toContain('target="_blank"');
    expect(upstream).toContain('rel="');
    expect(upstream).toContain('data-release-id="rel_voice"');
  });

  it("falls back to the on-site release page (same tab) without a url", () => {
    const [internal] = anchorsTo(html, "/release/rel_neon");
    expect(internal).toContain('data-release-id="rel_neon"');
    expect(internal).not.toContain('target="_blank"');
  });

  it("marks only upstream links with the ↗ glyph", () => {
    const arrows = html.match(/M7 17 17 7/g) ?? [];
    expect(arrows.length).toBe(1);
  });

  it("names the products, the lede, and links back to the section", () => {
    expect(html).toContain("Codex");
    expect(html).toContain("Neon");
    expect(html).toContain("Coding agents started speaking.");
    expect(html).toContain("2 releases");
    const [sectionLink] = anchorsTo(
      html,
      "/collections/coding-agents/digest/2026-09-14#agents-learn-to-talk",
    );
    expect(sectionLink).not.toContain('target="_blank"');
    expect(html).toContain("Read the section →");
  });

  it("clamps the lede to 3 lines so it can't blow out the card height", () => {
    expect(html).toMatch(/class="[^"]*line-clamp-3[^"]*"[^>]*>Coding agents started speaking\./);
  });

  it("marks the ↗ glyph's release links with screen-reader-only 'opens in new tab' text", () => {
    expect(html).toContain("(opens in new tab)");
    expect(html).toContain('class="sr-only"');
  });

  it("caps the products row at 3, with a +N chip for the rest, single-line", () => {
    // Product-less releases (product: null) so each shows its org's name —
    // `release()` assigns openai a "Codex" product, which would muddy the
    // distinct-name assertions below.
    const noProduct = (id: string, o: ReturnType<typeof org>) => ({
      ...release(id, id, null, o),
      product: null,
    });
    const fourProductDigest: ReelDigest = {
      ...codingAgents,
      sections: [
        {
          heading: "A busy section",
          anchor: "a-busy-section",
          lede: "",
          releases: [
            noProduct("rel_1", openai),
            noProduct("rel_2", neon),
            noProduct("rel_3", org("cognition", "Cognition")),
            noProduct("rel_4", org("vercel", "Vercel")),
          ],
        },
      ],
    };
    const fourProductCard = toReelPreview([fourProductDigest]).cards[0];
    const manyProductsHtml = renderToStaticMarkup(
      <DigestSectionPreview digest={fourProductCard} section={fourProductCard.sections[0]} />,
    );
    // First 3 products' names render; the 4th is folded into "+1".
    expect(manyProductsHtml).toContain("OpenAI");
    expect(manyProductsHtml).toContain("Neon");
    expect(manyProductsHtml).toContain("Cognition");
    expect(manyProductsHtml).not.toContain("Vercel");
    expect(manyProductsHtml).toContain(">+1<");
    expect(manyProductsHtml).toMatch(/class="[^"]*flex-nowrap[^"]*overflow-hidden[^"]*"/);
  });
});

describe("focusIsInside", () => {
  const container = (containsResult: boolean) => ({ contains: () => containsResult });

  it("is false when there's no card or no focused element", () => {
    expect(focusIsInside(null, {} as Node)).toBe(false);
    expect(focusIsInside(container(true), null)).toBe(false);
  });

  it("is true only when the active element is inside the container", () => {
    expect(focusIsInside(container(true), {} as Node)).toBe(true);
    expect(focusIsInside(container(false), {} as Node)).toBe(false);
  });
});
