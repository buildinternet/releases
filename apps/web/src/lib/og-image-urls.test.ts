import { describe, expect, it } from "bun:test";
import { buildDocPageMetadata } from "./doc-metadata";
import {
  collectionOgImageUrl,
  docOgImageUrl,
  ogImageFields,
  siteOgImageUrl,
} from "./og-image-urls";
import { buildStaticPageMetadata } from "@/components/markdown-page";

const fm = { title: "T", description: "D" };
const env = { WEB_BASE_URL: "https://releases.sh" };

describe("og image urls", () => {
  it("points at stable low-cardinality routes", () => {
    expect(siteOgImageUrl(env)).toBe("https://releases.sh/api/og/site");
    expect(collectionOgImageUrl("ai-labs", env)).toBe(
      "https://releases.sh/api/og/collection/ai-labs",
    );
    expect(docOgImageUrl("guides/find-a-changelog", env)).toBe(
      "https://releases.sh/api/og/docs/guides/find-a-changelog",
    );
  });

  it("produces concrete images arrays for openGraph and twitter", () => {
    const f = ogImageFields("https://releases.sh/api/og/site");
    expect(f.openGraph.images).toEqual(["https://releases.sh/api/og/site"]);
    expect(f.twitter.images).toEqual(["https://releases.sh/api/og/site"]);
    expect(f.twitter.card).toBe("summary_large_image");
  });
});

describe("docPageMetadata", () => {
  it("points docs pages without their own card at the shared site card", () => {
    const m = buildDocPageMetadata("installation", fm);
    expect(m.openGraph).toHaveProperty("images");
    expect((m.openGraph as { images: unknown[] }).images).toHaveLength(1);
    expect((m.twitter as { images: unknown[] }).images).toHaveLength(1);
  });

  it("points docs pages with `og` frontmatter at their own card, with alt text", () => {
    const og = { alt: "Why card", eyebrow: "Why", title: "Why Releases" };
    const m = buildDocPageMetadata("why", { ...fm, og });
    const images = (m.openGraph as { images: Array<{ url: string; alt: string }> }).images;
    expect(images).toHaveLength(1);
    expect(images[0].url).toEndWith("/api/og/docs/why");
    expect(images[0].alt).toBe("Why card");
    expect((m.twitter as { images: unknown[] }).images).toEqual(images);
  });
});

describe("staticPageMetadata", () => {
  it.each(["privacy", "security", "terms"])("%s emits og + twitter images", (slug) => {
    const m = buildStaticPageMetadata(slug, fm);
    const og = m.openGraph as { images?: unknown[] };
    const tw = m.twitter as { images?: unknown[] };
    expect(og.images).toHaveLength(1);
    expect(tw.images).toHaveLength(1);
  });

  it.each(["privacy", "security", "terms", "pricing"])(
    "%s advertises its markdown twin as an alternate",
    (slug) => {
      const m = buildStaticPageMetadata(slug, fm);
      expect(m.alternates).toEqual({
        canonical: `/${slug}`,
        types: { "text/markdown": `/${slug}.md` },
      });
    },
  );
});
