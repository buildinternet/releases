import { describe, it, expect } from "bun:test";
import type { ReleaseLocationItem } from "@buildinternet/releases-api-types";
import {
  classifyReleaseLocation,
  classifyReleaseLocations,
  partitionLocatorPreviews,
} from "./listing-locations.js";

function loc(partial: Partial<ReleaseLocationItem>): ReleaseLocationItem {
  return {
    canonical: false,
    basis: "declared",
    productId: null,
    sourceId: null,
    ...partial,
  };
}

describe("classifyReleaseLocation", () => {
  it("classifies feed/github/appstore as tier1-live", () => {
    expect(classifyReleaseLocation(loc({ feed: "https://acme.com/feed.xml" })).classification).toBe(
      "tier1-live",
    );
    expect(classifyReleaseLocation(loc({ github: "acme/sdk" })).classification).toBe("tier1-live");
    expect(
      classifyReleaseLocation(loc({ appstore: "https://apps.apple.com/app/id123" })).classification,
    ).toBe("tier1-live");
  });

  it("classifies bare url and file as tier2-paused-review", () => {
    expect(classifyReleaseLocation(loc({ url: "https://acme.com/whats-new" })).classification).toBe(
      "tier2-paused-review",
    );
    expect(
      classifyReleaseLocation(loc({ file: "https://acme.com/CHANGELOG.md" })).classification,
    ).toBe("tier2-paused-review");
  });

  it("prefers feed over url when both are present", () => {
    const preview = classifyReleaseLocation(
      loc({ url: "https://acme.com/whats-new", feed: "https://acme.com/feed.xml" }),
    );
    expect(preview.kind).toBe("feed");
    expect(preview.locator).toBe("https://acme.com/feed.xml");
    expect(preview.classification).toBe("tier1-live");
  });
});

describe("partitionLocatorPreviews", () => {
  it("splits live vs queued", () => {
    const previews = classifyReleaseLocations([
      loc({ feed: "https://acme.com/feed.xml" }),
      loc({ url: "https://acme.com/blog" }),
      loc({ github: "acme/cli" }),
    ]);
    const { live, queued } = partitionLocatorPreviews(previews);
    expect(live.map((p) => p.kind)).toEqual(["feed", "github"]);
    expect(queued.map((p) => p.kind)).toEqual(["url"]);
  });
});
