import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CollectionReleaseItemView } from "@/lib/release-view";
import type { CollectionWeeklyDigestListItem } from "@/lib/api";
import { CollectionTimeline } from "./collection-timeline";

const org = { slug: "openai", name: "OpenAI" };
const source = { slug: "openai-blog", name: "OpenAI Blog", type: "feed" };

function release(id: string, title: string, publishedAt: string): CollectionReleaseItemView {
  return { id, version: null, title, publishedAt, url: null, source, org };
}

// One release in the week of 2026-09-14 (no digest for that week in these
// fixtures) and one in the week of 2026-09-07 (has a digest). `weekStart` is
// always an ET Monday, so `rel_2` is deliberately dated ON that Monday.
const releases: CollectionReleaseItemView[] = [
  release("rel_1", "New voice mode", "2026-09-15T18:00:00Z"),
  release("rel_2", "Sandbox hardening", "2026-09-07T18:00:00Z"),
];

const digest: CollectionWeeklyDigestListItem = {
  id: "dig_1",
  weekStart: "2026-09-07",
  title: "Claude Code finds its footing as agent platforms grow up",
  intro: "Seven releases in six days.",
  releaseCount: 16,
  generatedAt: "2026-09-07T00:00:00Z",
};

describe("CollectionTimeline — week dividers + inline digests", () => {
  test("category page (no digestsByWeek) renders no dividers or digest cards", () => {
    const html = renderToStaticMarkup(
      <CollectionTimeline
        fetchEndpoint="/api/x"
        initialReleases={releases}
        initialCursor={null}
        members={[]}
      />,
    );
    expect(html).not.toContain("Week of Sep");
    expect(html).not.toContain("Weekly digest");
    expect(html).not.toContain("Read the digest");
  });

  test("collection page: a week with no digest gets only a divider", () => {
    const html = renderToStaticMarkup(
      <CollectionTimeline
        fetchEndpoint="/api/x"
        initialReleases={releases}
        initialCursor={null}
        members={[]}
        digestFeed={{
          byWeek: new Map([[digest.weekStart, digest]]),
          heroWeekStart: null,
          basePath: "/collections/coding-agents/digest",
          currentWeekStart: "2026-09-21",
        }}
      />,
    );
    expect(html).toContain("Week of Sep 14");
    expect(html).toContain("Week of Sep 7");
  });

  test("a week with a digest that isn't the hero's gets the full inline card", () => {
    const html = renderToStaticMarkup(
      <CollectionTimeline
        fetchEndpoint="/api/x"
        initialReleases={releases}
        initialCursor={null}
        members={[]}
        digestFeed={{
          byWeek: new Map([[digest.weekStart, digest]]),
          heroWeekStart: null,
          basePath: "/collections/coding-agents/digest",
          currentWeekStart: "2026-09-21",
        }}
      />,
    );
    expect(html).toContain("Weekly digest");
    expect(html).toContain("Claude Code finds its footing as agent platforms grow up");
    expect(html).toContain("Seven releases in six days.");
    expect(html).toContain("Read the digest");
    expect(html).toContain('href="/collections/coding-agents/digest/2026-09-07"');
  });

  test("the hero's own week gets a compact link instead of the full card", () => {
    const html = renderToStaticMarkup(
      <CollectionTimeline
        fetchEndpoint="/api/x"
        initialReleases={releases}
        initialCursor={null}
        members={[]}
        digestFeed={{
          byWeek: new Map([[digest.weekStart, digest]]),
          heroWeekStart: "2026-09-07",
          basePath: "/collections/coding-agents/digest",
          currentWeekStart: "2026-09-21",
        }}
      />,
    );
    expect(html).not.toContain("Weekly digest");
    expect(html).not.toContain("Seven releases in six days.");
    expect(html).toContain("Claude Code finds its footing as agent platforms grow up");
    expect(html).toContain('href="/collections/coding-agents/digest/2026-09-07"');
  });

  test("the current week's divider reads 'in progress · digest Monday'", () => {
    const html = renderToStaticMarkup(
      <CollectionTimeline
        fetchEndpoint="/api/x"
        initialReleases={releases}
        initialCursor={null}
        members={[]}
        digestFeed={{
          byWeek: new Map([[digest.weekStart, digest]]),
          heroWeekStart: null,
          basePath: "/collections/coding-agents/digest",
          currentWeekStart: "2026-09-14",
        }}
      />,
    );
    expect(html).toContain("in progress");
    expect(html).toContain("digest Monday");
  });
});
