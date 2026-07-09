import { describe, expect, it } from "bun:test";
import { buildReleaseOpenGraph } from "./release-og";

describe("buildReleaseOpenGraph", () => {
  it("points og:image at the shared org OG route when the release has an org", () => {
    const og = buildReleaseOpenGraph(
      "/release/rel_000000000000000000001-added-a-thing",
      { publishedAt: "2026-07-01T00:00:00.000Z", orgSlug: "acme" },
      { WEB_BASE_URL: "https://releases.sh" },
    );
    expect(og.images).toEqual(["https://releases.sh/api/og/org/acme"]);
    expect(og.type).toBe("article");
    expect(og.publishedTime).toBe("2026-07-01T00:00:00.000Z");
  });

  it("omits the images key entirely (not just undefined) when the release has no org", () => {
    const og = buildReleaseOpenGraph(
      "/release/rel_000000000000000000002",
      { publishedAt: null, orgSlug: null },
      { WEB_BASE_URL: "https://releases.sh" },
    );
    expect("images" in og).toBe(false);
  });

  it("falls back to the prod web origin when WEB_BASE_URL is unset", () => {
    const og = buildReleaseOpenGraph("/release/rel_000000000000000000003", { orgSlug: "acme" }, {});
    expect(og.images).toEqual(["https://releases.sh/api/og/org/acme"]);
  });
});
