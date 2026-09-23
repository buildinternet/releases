import { describe, expect, test } from "bun:test";
import { citationHref } from "./overview-citations";

describe("citationHref", () => {
  test("always the upstream source url, even when a release resolved", () => {
    expect(
      citationHref({
        sourceUrl: "https://example.com/post",
        releaseId: "rel_a",
        releaseWebUrl: "https://releases.sh/release/rel_a",
      }),
    ).toBe("https://example.com/post");
  });
});
