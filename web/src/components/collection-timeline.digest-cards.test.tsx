import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CollectionWeeklyDigestListItem } from "@/lib/api";
import { WeekDivider, CompactDigestLink, InlineDigestCard } from "./collection-timeline";

const digest: CollectionWeeklyDigestListItem = {
  id: "dig_1",
  weekStart: "2026-09-14",
  title: "Agents get a voice, a memory, and a tighter grip on credentials",
  intro: "Claude Code shipped seven releases in six days.",
  releaseCount: 13,
  generatedAt: "2026-09-15T00:00:00Z",
};

describe("WeekDivider", () => {
  test("renders the short week label and release count", () => {
    const html = renderToStaticMarkup(
      <WeekDivider weekStart="2026-09-14" releaseCount={13} inProgress={false} />,
    );
    expect(html).toContain("Week of Sep 14");
    expect(html).toContain("13 releases");
    expect(html).not.toContain("in progress");
  });

  test("current week reads 'in progress · digest Monday' instead of a count", () => {
    const html = renderToStaticMarkup(
      <WeekDivider weekStart="2026-09-21" releaseCount={0} inProgress={true} />,
    );
    expect(html).toContain("Week of Sep 21");
    expect(html).toContain("in progress");
    expect(html).toContain("digest Monday");
    expect(html).not.toContain("0 releases");
  });
});

describe("CompactDigestLink", () => {
  test("links to the digest and shows title + Read cue, no intro", () => {
    const html = renderToStaticMarkup(
      <CompactDigestLink digest={digest} basePath="/collections/coding-agents/digest" />,
    );
    expect(html).toContain('href="/collections/coding-agents/digest/2026-09-14"');
    expect(html).toContain("Agents get a voice, a memory, and a tighter grip on credentials");
    expect(html).toContain("Read");
    expect(html).not.toContain("Claude Code shipped seven releases in six days.");
  });
});

describe("InlineDigestCard", () => {
  test("shows eyebrow, title link, intro, and a 'Read the digest →' link — no sections", () => {
    const html = renderToStaticMarkup(
      <InlineDigestCard digest={digest} basePath="/collections/coding-agents/digest" />,
    );
    expect(html).toContain("Weekly digest");
    expect(html).toContain('href="/collections/coding-agents/digest/2026-09-14"');
    expect(html).toContain("Agents get a voice, a memory, and a tighter grip on credentials");
    expect(html).toContain("Claude Code shipped seven releases in six days.");
    expect(html).toContain("Read the digest");
    expect(html).not.toContain("In this issue");
  });

  test("omits the intro paragraph when empty", () => {
    const html = renderToStaticMarkup(
      <InlineDigestCard
        digest={{ ...digest, intro: "" }}
        basePath="/collections/coding-agents/digest"
      />,
    );
    expect(html).toContain("Agents get a voice, a memory, and a tighter grip on credentials");
    expect(html).toContain("Read the digest");
  });
});
