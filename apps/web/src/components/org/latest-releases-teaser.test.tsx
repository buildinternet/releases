import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrgReleaseItem } from "@/lib/api";
import { LatestReleasesTeaser } from "./latest-releases-teaser.tsx";

const appRelease = {
  id: "rel_app",
  title: "ChatGPT 1.2026.188",
  version: "1.2026.188",
  summary: "Bug fixes and small improvements.",
  publishedAt: "2026-07-14T00:00:00Z",
  url: null,
  importance: 2,
  media: [],
  source: {
    slug: "chatgpt-ios",
    name: "ChatGPT",
    type: "appstore",
    appStore: { platform: "ios", iconUrl: null },
  },
  product: { slug: "chatgpt", name: "ChatGPT" },
} as unknown as OrgReleaseItem;

const feedRelease = {
  id: "rel_feed",
  title: "Ship faster with Turbo 2.1",
  version: "2.1.0",
  summary: "New caching.",
  publishedAt: "2026-07-14T00:00:00Z",
  url: null,
  importance: 3,
  media: [],
  source: { slug: "turbo-feed", name: "Turborepo", type: "feed" },
  product: { slug: "turborepo", name: "Turborepo" },
} as unknown as OrgReleaseItem;

describe("LatestReleasesTeaser — mobile-app rows", () => {
  it("renders the lean app form: app name + iOS cue, no version", () => {
    const html = renderToStaticMarkup(
      <LatestReleasesTeaser orgSlug="openai" releases={[appRelease]} />,
    );
    expect(html).toContain("ChatGPT");
    expect(html).toContain("iOS app");
    expect(html).toContain('aria-label="Available for iOS"');
    // The version string is dropped for app releases.
    expect(html).not.toContain("1.2026.188");
  });

  it("leaves a non-app release unchanged: shows the product · version meta", () => {
    const html = renderToStaticMarkup(
      <LatestReleasesTeaser orgSlug="vercel" releases={[feedRelease]} />,
    );
    expect(html).toContain("Ship faster with Turbo 2.1");
    expect(html).toContain("2.1.0");
    // No app-only treatment leaked onto a feed release.
    expect(html).not.toContain("iOS app");
    expect(html).not.toContain("Available for");
  });
});
