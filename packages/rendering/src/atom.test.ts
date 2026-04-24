import { describe, it, expect } from "bun:test";
import { sourceToAtom, orgReleasesToAtom } from "./atom.js";
import type { SourceDetail, OrgReleaseItem } from "@releases/api-types";

const BASE = "https://releases.sh";

function makeSource(): SourceDetail {
  return {
    slug: "next-releases",
    name: "Next.js",
    type: "github",
    url: "https://github.com/vercel/next.js",
    org: { slug: "vercel", name: "Vercel" },
    releaseCount: 2,
    releasesLast30Days: 1,
    avgReleasesPerWeek: 0.5,
    latestVersion: "v15.0.0",
    latestDate: "2026-04-10T12:34:56Z",
    lastFetchedAt: "2026-04-17T08:00:00Z",
    lastPolledAt: null,
    trackingSince: "2024-01-01T00:00:00Z",
    releases: [
      {
        id: "rel_abc123",
        version: "v15.0.0",
        title: "Next.js 15.0",
        summary: "Turbopack stable & caching overhaul",
        content:
          "## Highlights\n\n- Turbopack stable <for> all builds\n- Caching & `use cache` directive",
        publishedAt: "2026-04-10T12:34:56Z",
        url: "https://github.com/vercel/next.js/releases/tag/v15.0.0",
      },
      {
        id: "rel_xyz789",
        version: "v14.3.1",
        title: "Next.js 14.3.1",
        summary: "Patch release",
        content: "Fixes & chores. Contains CDATA trap: ]]>",
        publishedAt: "2026-03-22",
        url: "https://github.com/vercel/next.js/releases/tag/v14.3.1",
      },
    ],
    pagination: { page: 1, pageSize: 20, totalPages: 1, totalItems: 2 },
    summaries: { rolling: null, monthly: [] },
  };
}

describe("sourceToAtom", () => {
  it("produces a well-formed Atom 1.0 feed", () => {
    const xml = sourceToAtom(makeSource(), { baseUrl: BASE });

    expect(xml).toStartWith('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toInclude('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(xml).toInclude("<title>Next.js release notes — Vercel</title>");
    expect(xml).toInclude(
      '<link rel="self" type="application/atom+xml" href="https://releases.sh/vercel/next-releases.atom" />',
    );
    expect(xml).toInclude(
      '<link rel="alternate" type="text/html" href="https://releases.sh/vercel/next-releases" />',
    );
    // Feed <updated> matches the most recent entry (the v15 release).
    expect(xml).toInclude("<updated>2026-04-10T12:34:56.000Z</updated>");
  });

  it("emits entries with stable ids and published + updated timestamps", () => {
    const xml = sourceToAtom(makeSource(), { baseUrl: BASE });

    expect(xml).toInclude("<id>https://releases.sh/release/rel_abc123</id>");
    expect(xml).toInclude(
      '<link rel="alternate" type="text/html" href="https://releases.sh/release/rel_abc123" />',
    );
    expect(xml).toInclude("<published>2026-04-10T12:34:56.000Z</published>");
    // Date-only source timestamps get widened to midnight UTC.
    expect(xml).toInclude("<published>2026-03-22T00:00:00.000Z</published>");
  });

  it("escapes markdown/HTML content so XML stays valid", () => {
    const xml = sourceToAtom(makeSource(), { baseUrl: BASE });

    // CDATA wraps raw content; the < in the markdown does not leak as a tag.
    expect(xml).toInclude('<content type="html"><![CDATA[## Highlights');
    // The `]]>` inside the second entry's content must be split to keep the
    // CDATA well-formed.
    expect(xml).toInclude("]]]]><![CDATA[>");
    // Raw `<for>` must be preserved inside CDATA, not escaped.
    expect(xml).toInclude("Turbopack stable <for> all builds");
  });
});

describe("orgReleasesToAtom", () => {
  it("aggregates entries across sources", () => {
    const releases: OrgReleaseItem[] = [
      {
        id: "rel_1",
        version: "1.0",
        title: "Product A 1.0",
        summary: "Launch",
        publishedAt: "2026-04-17T00:00:00Z",
        url: "https://example.com/a/1",
        source: { slug: "product-a", name: "Product A", type: "github" },
      },
      {
        id: "rel_2",
        version: "2.5",
        title: "Product B 2.5",
        summary: "Big release",
        publishedAt: "2026-04-15T00:00:00Z",
        url: "https://example.com/b/2.5",
        source: { slug: "product-b", name: "Product B", type: "feed" },
      },
    ];

    const xml = orgReleasesToAtom(
      { orgSlug: "acme", orgName: "Acme Inc", releases },
      { baseUrl: BASE },
    );

    expect(xml).toInclude("<title>Acme Inc release notes</title>");
    expect(xml).toInclude(
      '<link rel="self" type="application/atom+xml" href="https://releases.sh/acme.atom" />',
    );
    expect(xml).toInclude('category term="product-a"');
    expect(xml).toInclude('category term="product-b"');
    // Feed-level updated should be the newest entry.
    expect(xml).toInclude("<updated>2026-04-17T00:00:00.000Z</updated>");
  });

  it("emits a valid empty feed when the org has no releases", () => {
    const xml = orgReleasesToAtom(
      { orgSlug: "empty", orgName: "Empty Org", releases: [] },
      { baseUrl: BASE },
    );

    expect(xml).toStartWith('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toInclude("<title>Empty Org release notes</title>");
    expect(xml).not.toInclude("<entry>");
  });

  it("includes an overview entry when overview is provided", () => {
    const xml = orgReleasesToAtom(
      {
        orgSlug: "acme",
        orgName: "Acme Inc",
        releases: [],
        overview: {
          content: "# Acme\n\nRecent focus on observability and billing.",
          generatedAt: "2026-04-18T00:00:00Z",
          updatedAt: "2026-04-18T00:00:00Z",
        },
      },
      { baseUrl: BASE },
    );

    expect(xml).toInclude("<title>Acme Inc — overview</title>");
    expect(xml).toInclude("<id>tag:releases.sh,2005:acme/overview</id>");
    expect(xml).toInclude(
      '<link rel="alternate" type="text/markdown" href="https://releases.sh/acme/overview.md" />',
    );
    expect(xml).toInclude('<category term="overview" label="Overview" />');
    expect(xml).toInclude("Recent focus on observability and billing.");
  });

  it("omits overview entry when overview is absent", () => {
    const xml = orgReleasesToAtom(
      { orgSlug: "acme", orgName: "Acme", releases: [] },
      { baseUrl: BASE },
    );
    expect(xml).not.toInclude('category term="overview"');
  });

  it("derives tag URI authority from baseUrl (not a hardcoded host)", () => {
    const xml = orgReleasesToAtom(
      {
        orgSlug: "acme",
        orgName: "Acme",
        releases: [
          {
            // No id or url — forces the tag:-URI fallback in entryId.
            version: null,
            title: "Manual entry",
            summary: "",
            publishedAt: "2026-04-01T00:00:00Z",
            url: null,
            source: { slug: "acme-blog", name: "Acme Blog", type: "scrape" },
          },
        ],
      },
      { baseUrl: "https://staging.example.com" },
    );

    expect(xml).toInclude("<id>tag:staging.example.com,2005:org/acme</id>");
    expect(xml).toInclude("tag:staging.example.com,2005:acme-blog/");
  });
});
