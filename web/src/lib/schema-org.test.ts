import { describe, expect, test } from "bun:test";
import { buildReleaseItemListJsonLd } from "./schema-org";

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
