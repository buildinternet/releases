import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Card, type Slide, type TickerRelease } from "./shipping-now-ticker.tsx";

function slide(release: TickerRelease): Slide {
  return { release, relative: "14h ago", extraCount: 0 };
}

const appRelease = {
  id: "rel_app",
  title: "ChatGPT 1.2026.188",
  version: "1.2026.188",
  publishedAt: "2026-07-14T00:00:00Z",
  titleGenerated: null,
  titleShort: null,
  importance: 4,
  media: [{ type: "image", url: "https://cdn/shot.png", alt: "shot", r2Url: null }],
  source: {
    org: { slug: "openai", name: "ChatGPT", avatarUrl: null },
    product: null,
    appStore: { platform: "ios", iconUrl: null },
    video: null,
  },
} as unknown as TickerRelease;

const feedRelease = {
  id: "rel_feed",
  title: "Ship faster with Turbo 2.1",
  version: "2.1.0",
  publishedAt: "2026-07-14T00:00:00Z",
  titleGenerated: null,
  titleShort: null,
  importance: 3,
  media: [{ type: "image", url: "https://cdn/turbo.png", alt: "turbo", r2Url: null }],
  source: {
    org: { slug: "vercel", name: "Vercel", avatarUrl: null },
    product: { slug: "turborepo", name: "Turborepo" },
    appStore: null,
    video: null,
  },
} as unknown as TickerRelease;

describe("ShippingNowTicker Card — mobile-app variant", () => {
  it("renders the lean app card: iOS cue, no version chip or thumbnail", () => {
    const html = renderToStaticMarkup(<Card slide={slide(appRelease)} />);
    expect(html).toContain("iOS app");
    expect(html).toContain('aria-label="Available for iOS"');
    expect(html).not.toContain("1.2026.188"); // version chip dropped
    expect(html).not.toContain("cdn/shot.png"); // thumbnail dropped
  });

  it("renders a non-app release the standard way: title, version chip, thumbnail", () => {
    const html = renderToStaticMarkup(<Card slide={slide(feedRelease)} />);
    expect(html).toContain("Ship faster with Turbo 2.1");
    expect(html).toContain("2.1.0");
    expect(html).toContain("cdn/turbo.png");
    expect(html).not.toContain("iOS app");
  });
});
