import { describe, expect, it } from "bun:test";
import { parseReleaseParam, releasePath } from "@buildinternet/releases-core/release-slug";
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

describe("og:url agrees with <link rel=canonical> on a bare/stale-slug request (#2072)", () => {
  // generateMetadata (page.tsx) computes both `alternates.canonical` and
  // `openGraph.url` (via buildReleaseOpenGraph) from the SAME
  // `releasePath(release)` call — never from the request's raw URL segment.
  // Since #2072 removed the slug-canonicalization redirect, a bare or
  // stale-slug request now renders (200) instead of 308ing, so it matters
  // that the two tags never disagree. This exercises that computation the
  // way page.tsx does, for the request shapes that used to trigger the
  // redirect.
  const REL = "rel_000000000000000000004";
  const release = { id: REL, titleShort: "Ships Widgets" };
  const canonicalPath = releasePath(release);

  it.each([
    ["bare id", REL],
    ["stale slug", `${REL}-an-old-headline`],
    ["already-canonical slug", canonicalPath.slice("/release/".length)],
  ])("%s: canonical tag and og:url both resolve to the current slugged path", (_label, segment) => {
    const { id } = parseReleaseParam(segment);
    // Mirrors generateMetadata: re-derive the canonical path from the
    // fetched release (never from `segment`/`rawParam`), then feed it to
    // both metadata fields.
    const canonical = releasePath({ ...release, id });
    const og = buildReleaseOpenGraph(
      canonical,
      { orgSlug: null },
      { WEB_BASE_URL: "https://releases.sh" },
    );

    expect(canonical).toBe(canonicalPath);
    expect(og.url).toBe(canonical);
  });
});
