import { describe, expect, test } from "bun:test";
import { buildOverviewCitationJsonLd, buildReleaseItemListJsonLd } from "./schema-org";

describe("buildReleaseItemListJsonLd", () => {
  test("items link upstream when the release has an http url, else the release page", () => {
    const ld = buildReleaseItemListJsonLd(
      [
        { id: "rel_a", url: "https://example.com/changelog#a", title: "A" },
        { id: "rel_b", url: null, title: "B" },
      ] as any,
      { listId: "https://releases.sh/x#list", name: "X" },
    );
    const urls = (ld.itemListElement as any[]).map((e) => e.item?.url);
    expect(urls).toEqual(["https://example.com/changelog#a", "https://releases.sh/release/rel_b"]);
  });
});

describe("buildOverviewCitationJsonLd", () => {
  const opts = { orgName: "Acme", aboutId: "https://releases.sh/acme#org" };

  test("keeps valid http and https citation urls", () => {
    const ld = buildOverviewCitationJsonLd(
      [{ sourceUrl: "https://example.com/a" }, { sourceUrl: "http://example.com/b" }],
      opts,
    );
    expect(ld?.citation).toEqual([
      { "@type": "WebPage", url: "https://example.com/a" },
      { "@type": "WebPage", url: "http://example.com/b" },
    ]);
  });

  test("drops javascript:, relative, and empty/whitespace source urls", () => {
    const ld = buildOverviewCitationJsonLd(
      [
        { sourceUrl: "javascript:alert(1)" },
        { sourceUrl: "/release/rel_a" },
        { sourceUrl: "" },
        { sourceUrl: "   " },
        { sourceUrl: "https://example.com/kept" },
      ],
      opts,
    );
    expect(ld?.citation).toEqual([{ "@type": "WebPage", url: "https://example.com/kept" }]);
  });

  test("returns null when every citation is dropped", () => {
    expect(buildOverviewCitationJsonLd([{ sourceUrl: "javascript:alert(1)" }], opts)).toBeNull();
    expect(buildOverviewCitationJsonLd([], opts)).toBeNull();
    expect(buildOverviewCitationJsonLd(undefined, opts)).toBeNull();
  });

  test("trims a source url before validating and deduping it", () => {
    const ld = buildOverviewCitationJsonLd(
      [{ sourceUrl: "  https://example.com/a  " }, { sourceUrl: "https://example.com/a" }],
      opts,
    );
    expect(ld?.citation).toEqual([{ "@type": "WebPage", url: "https://example.com/a" }]);
  });
});
