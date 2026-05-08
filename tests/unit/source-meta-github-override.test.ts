/**
 * Unit coverage for the GitHub-CHANGELOG fetch-override helpers (#831).
 *
 * `metadata.githubUrl` lets a `scrape` source fetch from a repo's GitHub
 * releases API while keeping `source.url` pointed at the human-readable docs
 * page. The release-URL synthesizer rewrites each ingested release URL so
 * dedup against existing scrape rows lines up via UNIQUE(source_id, url).
 */

import { describe, it, expect } from "bun:test";
import {
  isGitHubFetched,
  effectiveGitHubUrl,
  synthesizeReleaseUrl,
} from "@releases/adapters/source-meta";
import type { Source } from "@buildinternet/releases-core/schema";

function mkSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "src_test",
    slug: "owner-repo",
    name: "Owner Repo",
    type: "scrape",
    url: "https://docs.example.com/changelog",
    orgId: null,
    productId: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    lastFetchedAt: null,
    changeDetectedAt: null,
    lastPolledAt: null,
    fetchPriority: "normal",
    consecutiveNoChange: 0,
    consecutiveErrors: 0,
    nextFetchAfter: null,
    etag: null,
    isHidden: 0,
    isPrimary: 0,
    ...overrides,
  } as unknown as Source;
}

describe("isGitHubFetched", () => {
  it("returns true for canonical github sources", () => {
    expect(
      isGitHubFetched(mkSource({ type: "github", url: "https://github.com/owner/repo" })),
    ).toBe(true);
  });

  it("returns true for scrape sources with metadata.githubUrl set", () => {
    const source = mkSource({
      type: "scrape",
      metadata: JSON.stringify({ githubUrl: "https://github.com/owner/repo" }),
    });
    expect(isGitHubFetched(source)).toBe(true);
  });

  it("returns false for plain scrape sources", () => {
    expect(isGitHubFetched(mkSource())).toBe(false);
  });

  it("returns false when githubUrl is an empty string", () => {
    const source = mkSource({
      type: "scrape",
      metadata: JSON.stringify({ githubUrl: "" }),
    });
    expect(isGitHubFetched(source)).toBe(false);
  });
});

describe("effectiveGitHubUrl", () => {
  it("prefers metadata.githubUrl over source.url", () => {
    const source = mkSource({
      url: "https://docs.example.com/changelog",
      metadata: JSON.stringify({ githubUrl: "https://github.com/anthropics/claude-code" }),
    });
    expect(effectiveGitHubUrl(source)).toBe("https://github.com/anthropics/claude-code");
  });

  it("falls back to source.url when no override is set", () => {
    expect(
      effectiveGitHubUrl(mkSource({ type: "github", url: "https://github.com/owner/repo" })),
    ).toBe("https://github.com/owner/repo");
  });
});

describe("synthesizeReleaseUrl", () => {
  it("uses the Mintlify default (sourceUrl#dashed-version)", () => {
    expect(
      synthesizeReleaseUrl({
        sourceUrl: "https://code.claude.com/docs/en/changelog",
        version: "2.1.133",
      }),
    ).toBe("https://code.claude.com/docs/en/changelog#2-1-133");
  });

  it("strips a leading v from GitHub-style tags in the default template", () => {
    // GitHub tags conventionally carry a `v` prefix; doc-page heading slugs
    // almost never do. The default normalizes so the synthesized URL collides
    // with existing scrape rows by URL.
    expect(
      synthesizeReleaseUrl({
        sourceUrl: "https://code.claude.com/docs/en/changelog",
        version: "v2.1.133",
      }),
    ).toBe("https://code.claude.com/docs/en/changelog#2-1-133");
  });

  it("preserves the raw version when a custom template uses ${versionDashed}", () => {
    expect(
      synthesizeReleaseUrl({
        sourceUrl: "https://docs.example.com/changelog",
        version: "v2.1.0",
        template: "${sourceUrl}#${versionDashed}",
      }),
    ).toBe("https://docs.example.com/changelog#v2-1-0");
  });

  it("renders ${sourceUrl} and ${version} placeholders verbatim", () => {
    expect(
      synthesizeReleaseUrl({
        sourceUrl: "https://docs.example.com/changelog",
        version: "1.2.3",
        template: "${sourceUrl}/release/${version}",
      }),
    ).toBe("https://docs.example.com/changelog/release/1.2.3");
  });

  it("renders ${versionDashed} for non-default anchor schemes", () => {
    expect(
      synthesizeReleaseUrl({
        sourceUrl: "https://docs.example.com/changelog",
        version: "1.2.3",
        template: "${sourceUrl}#v${versionDashed}",
      }),
    ).toBe("https://docs.example.com/changelog#v1-2-3");
  });

  it("substitutes every occurrence of a placeholder", () => {
    expect(
      synthesizeReleaseUrl({
        sourceUrl: "https://x",
        version: "1.0",
        template: "${version}-${version}",
      }),
    ).toBe("1.0-1.0");
  });
});
