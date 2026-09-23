import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SearchReleaseHit } from "@/lib/api";
import { ReleaseResultCard } from "./search-results.tsx";

const baseHit: SearchReleaseHit = {
  id: "rel_1",
  sourceSlug: "acme-feed",
  sourceName: "Acme Feed",
  orgSlug: "acme",
  orgName: "Acme",
  version: "1.0.0",
  title: "Acme 1.0",
  summary: "Ships the first release.",
  publishedAt: "2026-05-01T00:00:00.000Z",
  url: null,
};

describe("ReleaseResultCard — link target (#2330)", () => {
  it("links upstream in a new tab when the hit has a url", () => {
    const html = renderToStaticMarkup(
      <ReleaseResultCard hit={{ ...baseHit, url: "https://acme.test/releases/1.0" }} tokens={[]} />,
    );
    expect(html).toContain('href="https://acme.test/releases/1.0"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain(`data-release-id="${baseHit.id}"`);
    expect(html).toContain("opens in new tab");
  });

  it("falls back to the internal /release/<id> page when the hit has no url", () => {
    const html = renderToStaticMarkup(
      <ReleaseResultCard hit={{ ...baseHit, url: null }} tokens={[]} />,
    );
    expect(html).toContain(`href="/release/${baseHit.id}"`);
    expect(html).toContain(`data-release-id="${baseHit.id}"`);
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("opens in new tab");
  });
});
