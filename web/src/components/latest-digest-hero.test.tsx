import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CollectionWeeklyDigestDetail, CollectionWeeklyDigestListItem } from "@/lib/api";
import { LatestDigestHero } from "./latest-digest-hero";

const org = (slug: string, name: string) => ({
  slug,
  name,
  avatarUrl: null,
  githubHandle: null,
});

const baseDigest: CollectionWeeklyDigestDetail = {
  id: "dig_1",
  weekStart: "2026-09-14",
  title: "Agents get a voice, a memory, and a tighter grip on credentials",
  intro: "Claude Code shipped seven releases in six days.",
  body: "",
  releaseIds: ["r1", "r2"],
  releaseCount: 13,
  generatedAt: "2026-09-15T00:00:00Z",
  releases: [
    {
      id: "r1",
      title: "Codex voice",
      path: "/release/r1",
      url: null,
      org: org("openai", "OpenAI"),
      product: { slug: "codex", name: "Codex" },
      importance: null,
    },
    {
      id: "r2",
      title: "Devin voice",
      path: "/release/r2",
      url: null,
      org: org("cognition", "Cognition"),
      product: { slug: "devin", name: "Devin" },
      importance: null,
    },
  ],
  sections: [
    {
      heading: "Agents learn to talk",
      anchor: "agents-learn-to-talk",
      lede: "Voice sessions everywhere.",
      releaseIds: ["r1", "r2"],
    },
  ],
};

const earlier: CollectionWeeklyDigestListItem[] = [
  {
    id: "dig_0",
    weekStart: "2026-09-07",
    title: "Claude Code finds its footing as agent platforms grow up",
    intro: "",
    releaseCount: 16,
    generatedAt: "2026-09-08T00:00:00Z",
  },
  {
    id: "dig_-1",
    weekStart: "2026-08-31",
    title: "Self-hosted agents and a security hardening spree",
    intro: "",
    releaseCount: 9,
    generatedAt: "2026-09-01T00:00:00Z",
  },
  {
    id: "dig_-2",
    weekStart: "2026-08-24",
    title: "A quieter week",
    intro: "",
    releaseCount: 3,
    generatedAt: "2026-08-25T00:00:00Z",
  },
];

describe("LatestDigestHero", () => {
  test("section rows link internally to the digest anchor, no target", () => {
    const html = renderToStaticMarkup(
      <LatestDigestHero slug="coding-agents" digest={baseDigest} earlier={[]} />,
    );
    expect(html).toContain(
      'href="/collections/coding-agents/digest/2026-09-14#agents-learn-to-talk"',
    );
    // Internal link — same tab, no target attribute, no ↗ glyph.
    const sectionLinkMatch = html.match(
      /<a[^>]*href="\/collections\/coding-agents\/digest\/2026-09-14#agents-learn-to-talk"[^>]*>/,
    );
    expect(sectionLinkMatch).not.toBeNull();
    expect(sectionLinkMatch?.[0]).not.toContain("target=");
    expect(html).not.toContain("↗");
  });

  test("product names render per section", () => {
    const html = renderToStaticMarkup(
      <LatestDigestHero slug="coding-agents" digest={baseDigest} earlier={[]} />,
    );
    expect(html).toContain("Codex");
    expect(html).toContain("Devin");
  });

  test('"Earlier" shows at most 2 items plus an "All digests" link', () => {
    const html = renderToStaticMarkup(
      <LatestDigestHero slug="coding-agents" digest={baseDigest} earlier={earlier} />,
    );
    expect(html).toContain("Claude Code finds its footing as agent platforms grow up");
    expect(html).toContain("Self-hosted agents and a security hardening spree");
    expect(html).not.toContain("A quieter week");
    expect(html).toContain("All digests");
    expect(html).toContain('href="/collections/coding-agents/digest"');
  });

  test('no "In this issue" column when sections is undefined', () => {
    const digestNoSections: CollectionWeeklyDigestDetail = {
      ...baseDigest,
      sections: undefined,
    };
    const html = renderToStaticMarkup(
      <LatestDigestHero slug="coding-agents" digest={digestNoSections} earlier={[]} />,
    );
    expect(html).not.toContain("In this issue");
    expect(html).not.toContain("agents-learn-to-talk");
  });
});
