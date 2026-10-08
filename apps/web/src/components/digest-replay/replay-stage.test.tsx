import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DigestCoveredRelease } from "@/lib/api";
import { buildGlance, GLANCE_TOP_N } from "@/lib/digest-glance";
import { ReplayStage } from "./replay-stage";

const org = (slug: string) => ({ slug, name: slug, avatarUrl: null, githubHandle: null });

function rel(
  id: string,
  product: string,
  importance: number | null,
  publishedAt: string,
): DigestCoveredRelease {
  return {
    id,
    title: `Title ${id}`,
    path: `/release/${id}`,
    url: null,
    org: org(`${product}-org`),
    product: { slug: product, name: product },
    importance,
    composition: { features: 2, enhancements: 1, bugs: 3 },
    publishedAt,
  };
}

const releases = [
  rel("r1", "codex", 5, "2026-09-29T00:00:00.000Z"),
  rel("r2", "codex", 2, "2026-09-30T14:00:00.000Z"),
  rel("r3", "devin", 4, "2026-09-28T15:00:00.000Z"),
  rel("r4", "devin", 3, "2026-10-01T15:00:00.000Z"),
  rel("r5", "claude", 3, "2026-10-02T15:00:00.000Z"),
  rel("r6", "claude", 1, "2026-10-03T15:00:00.000Z"),
  rel("r7", "grok", 2, "2026-10-04T15:00:00.000Z"),
];

const props = {
  releases,
  weekStart: "2026-09-28",
  anchors: { r1: "new-models" },
  digestHref: "/collections/agents/digest/2026-09-28",
};

const rowTitles = (html: string) =>
  [...html.matchAll(/<span>(Title r\d)<\/span>/g)].map((m) => m[1]);

describe("ReplayStage", () => {
  test("the end state renders the card's top-5 rows and links to the digest", () => {
    const html = renderToStaticMarkup(<ReplayStage {...props} startAtEnd reducedMotion={false} />);
    const card = buildGlance(releases)
      .ranked.slice(0, GLANCE_TOP_N)
      .map((r) => r.release.title);
    expect(html).toContain("The week at a glance");
    expect(html).toContain("Biggest releases");
    // The caption is gone at the end, so only list rows carry plain titles.
    expect(rowTitles(html)).toEqual(card);
    expect(html).toContain('href="/collections/agents/digest/2026-09-28#new-models"');
    expect(html).toContain('href="/collections/agents/digest/2026-09-28#releases-covered"');
    expect(html).toContain("Read the digest");
  });

  test("transport buttons carry labels", () => {
    const html = renderToStaticMarkup(<ReplayStage {...props} reducedMotion={false} />);
    for (const label of ["Play", "Restart", "Skip to end", "Scrub through the week"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('aria-label="Playback speed 1×. Switch to 2×."');
    expect(html).toContain("Press play to watch the week unfold.");
  });

  test("reduced motion shows day steps instead of play, and starts paused at the top", () => {
    const html = renderToStaticMarkup(<ReplayStage {...props} reducedMotion />);
    expect(html).toContain('aria-label="Previous day"');
    expect(html).toContain('aria-label="Next day"');
    expect(html).not.toContain('aria-label="Play"');
    expect(html).not.toContain('aria-label="Skip to end"');
    expect(html).toContain("Step through the week a day at a time.");
    expect(html).toContain("Nothing shipped yet");
  });
});
