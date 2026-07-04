import { describe, expect, it } from "bun:test";
import { classifyLocation, isUrlExcluded, locationMatchesSource } from "./materialize.js";

describe("well-known materialization helpers", () => {
  it("classifies MA-free and pending locator tiers", () => {
    expect(classifyLocation({ feed: "https://acme.com/feed.xml" })).toMatchObject({
      type: "feed",
      tier: 1,
      paused: false,
    });
    expect(classifyLocation({ github: "acme/repo" })).toMatchObject({
      type: "github",
      tier: 1,
      paused: false,
    });
    expect(
      classifyLocation({ appstore: "https://apps.apple.com/us/app/acme/id123" }),
    ).toMatchObject({
      type: "appstore",
      tier: 1,
      paused: false,
    });
    expect(classifyLocation({ url: "https://acme.com/updates" })).toMatchObject({
      type: "scrape",
      tier: 2,
      paused: true,
    });
    expect(classifyLocation({ file: "https://acme.com/CHANGELOG.md" })).toMatchObject({
      type: "scrape",
      tier: 2,
      paused: true,
    });
  });

  it("matches sources by every canonical locator and never by slug", () => {
    const source = {
      id: "src_one",
      type: "feed",
      url: "https://acme.com/updates",
      slug: "not-a-locator",
      metadata: JSON.stringify({
        feedUrl: "https://acme.com/feed.xml",
        githubUrl: "https://github.com/acme/repo",
        appStore: { trackId: "123" },
        declaredFileUrl: "https://acme.com/CHANGELOG.md",
      }),
    };
    expect(locationMatchesSource({ url: source.url }, source)).toBe(true);
    expect(locationMatchesSource({ feed: "https://acme.com/feed.xml" }, source)).toBe(true);
    expect(locationMatchesSource({ github: "acme/repo" }, source)).toBe(true);
    expect(
      locationMatchesSource({ appstore: "https://apps.apple.com/us/app/acme/id123" }, source),
    ).toBe(true);
    expect(locationMatchesSource({ file: "https://acme.com/CHANGELOG.md" }, source)).toBe(true);
    expect(locationMatchesSource({ url: "not-a-locator" }, source)).toBe(false);
  });

  it("honors org ignores plus global exact and domain blocks", () => {
    const policy = {
      ignored: ["https://acme.com/private"],
      blocked: [
        { pattern: "https://blocked.example/item", type: "exact" as const },
        { pattern: "evil.example", type: "domain" as const },
      ],
    };
    expect(isUrlExcluded("https://acme.com/private", policy)).toBe(true);
    expect(isUrlExcluded("https://blocked.example/item", policy)).toBe(true);
    expect(isUrlExcluded("https://evil.example/releases", policy)).toBe(true);
    expect(isUrlExcluded("https://safe.example/releases", policy)).toBe(false);
  });
});
