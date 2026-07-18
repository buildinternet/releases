import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RelatedReleaseItem } from "@/lib/api";
import { ReleaseCard } from "./related-rail.tsx";

const baseSource = {
  id: "src_x",
  slug: "s",
  name: "ChatGPT",
  productName: "ChatGPT",
  orgSlug: "openai",
  orgName: "OpenAI",
  orgAvatarUrl: null,
};

const appItem: RelatedReleaseItem = {
  id: "rel_app",
  title: "ChatGPT 1.2026.188",
  version: "1.2026.188",
  url: null,
  publishedAt: "2026-07-14T00:00:00Z",
  summary: "Bug fixes and small improvements.",
  titleGenerated: null,
  titleShort: null,
  importance: 4,
  thumbnail: { url: "https://cdn/shot.png", alt: "shot" },
  score: 0.9,
  source: { ...baseSource, type: "appstore", appStore: { platform: "ios", iconUrl: null } },
};

const feedItem: RelatedReleaseItem = {
  id: "rel_feed",
  title: "Next.js 15.1",
  version: "15.1.0",
  url: null,
  publishedAt: "2026-07-14T00:00:00Z",
  summary: "Turbopack improvements.",
  titleGenerated: null,
  titleShort: null,
  importance: 3,
  thumbnail: { url: "https://cdn/next.png", alt: "next" },
  score: 0.8,
  source: { ...baseSource, name: "Next.js", productName: "Next.js", type: "feed" },
};

describe("RelatedRail ReleaseCard — mobile-app variant", () => {
  it("renders the lean app card: app name + iOS cue, no version or thumbnail", () => {
    const html = renderToStaticMarkup(<ReleaseCard item={appItem} />);
    expect(html).toContain("ChatGPT");
    expect(html).toContain("iOS app");
    expect(html).toContain('aria-label="Available for iOS"');
    expect(html).not.toContain("1.2026.188"); // version dropped
    expect(html).not.toContain("cdn/shot.png"); // thumbnail dropped
    expect(html).not.toContain("Bug fixes"); // body preview dropped
  });

  it("renders a non-app release the standard way: title, version, thumbnail", () => {
    const html = renderToStaticMarkup(<ReleaseCard item={feedItem} />);
    expect(html).toContain("Next.js 15.1");
    expect(html).toContain("15.1.0");
    expect(html).toContain("cdn/next.png");
    expect(html).not.toContain("iOS app");
  });
});
