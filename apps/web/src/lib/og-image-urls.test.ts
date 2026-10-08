import { describe, expect, it } from "bun:test";
import { DOCS_WITH_OWN_OG_IMAGE, buildDocPageMetadata } from "./doc-metadata";
import { collectionOgImageUrl, ogImageFields, siteOgImageUrl } from "./og-image-urls";
import { buildStaticPageMetadata } from "@/components/markdown-page";

const fm = { title: "T", description: "D" };
const env = { WEB_BASE_URL: "https://releases.sh" };

describe("og image urls", () => {
  it("points at stable low-cardinality routes", () => {
    expect(siteOgImageUrl(env)).toBe("https://releases.sh/api/og/site");
    expect(collectionOgImageUrl("ai-labs", env)).toBe(
      "https://releases.sh/api/og/collection/ai-labs",
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

  it("omits images entirely (not undefined) for docs with a co-located card", () => {
    for (const slug of DOCS_WITH_OWN_OG_IMAGE) {
      const m = buildDocPageMetadata(slug, fm);
      expect(Object.hasOwn(m.openGraph ?? {}, "images")).toBe(false);
      expect(Object.hasOwn(m.twitter ?? {}, "images")).toBe(false);
    }
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
});
