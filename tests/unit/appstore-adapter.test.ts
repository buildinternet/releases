import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  parseAppStoreIdentifier,
  stripUoParam,
  upscaleArtwork,
  versionDistinctUrl,
  mapListingToRawReleases,
  appStoreCoordFromSource,
  type AppStoreListing,
} from "@releases/adapters/appstore";

const listing: AppStoreListing = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/appstore/spotify-ios.json"), "utf-8"),
).results[0];

describe("parseAppStoreIdentifier", () => {
  it("parses a numeric trackId", () => {
    expect(parseAppStoreIdentifier("324684580")).toEqual({
      trackId: "324684580",
      platform: "ios",
      storefront: "us",
    });
  });
  it("parses an apps.apple.com URL", () => {
    expect(parseAppStoreIdentifier("https://apps.apple.com/us/app/spotify/id324684580")).toEqual({
      trackId: "324684580",
      platform: "ios",
      storefront: "us",
    });
  });
  it("honors platform + storefront overrides", () => {
    expect(parseAppStoreIdentifier("324684580", { platform: "macos", storefront: "gb" })).toEqual({
      trackId: "324684580",
      platform: "macos",
      storefront: "gb",
    });
  });
  it("returns null for non-app-store input", () => {
    expect(parseAppStoreIdentifier("github:foo/bar")).toBeNull();
    expect(parseAppStoreIdentifier("")).toBeNull();
  });
});

describe("URL helpers", () => {
  it("strips ?uo= tracking param", () => {
    expect(stripUoParam("https://apps.apple.com/us/app/id324684580?uo=4")).toBe(
      "https://apps.apple.com/us/app/id324684580",
    );
  });
  it("upscales the mzstatic artwork dimension suffix to 1024 png", () => {
    expect(upscaleArtwork(listing.artworkUrl512!)).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/PurpleX/v4/ab/cd/ef/abcdef.png/1024x1024bb.png",
    );
  });
  it("builds a version-distinct URL", () => {
    expect(versionDistinctUrl("https://apps.apple.com/us/app/id324684580", "9.0.12")).toBe(
      "https://apps.apple.com/us/app/id324684580?v=9.0.12",
    );
  });
});

describe("mapListingToRawReleases", () => {
  const [release] = mapListingToRawReleases(listing, {
    trackId: "324684580",
    platform: "ios",
    storefront: "us",
  });

  it("mints exactly one release for the current version", () => {
    expect(
      mapListingToRawReleases(listing, { trackId: "324684580", platform: "ios", storefront: "us" }),
    ).toHaveLength(1);
  });
  it("maps version, title, content, publishedAt", () => {
    expect(release.version).toBe("9.0.12");
    expect(release.title).toBe("Spotify - Music and Podcasts 9.0.12");
    expect(release.content).toBe("Bug fixes and performance improvements.");
    expect(release.publishedAt).toEqual(new Date("2026-05-19T11:42:00Z"));
  });
  it("uses a version-distinct dedup URL", () => {
    expect(release.url).toBe("https://apps.apple.com/us/app/id324684580?v=9.0.12");
  });
  it("includes screenshots (iphone + ipad) as image media", () => {
    expect(release.media).toEqual([
      { type: "image", url: "https://is1-ssl.mzstatic.com/image/thumb/aaa/392x696bb.jpg" },
      { type: "image", url: "https://is1-ssl.mzstatic.com/image/thumb/bbb/392x696bb.jpg" },
      { type: "image", url: "https://is1-ssl.mzstatic.com/image/thumb/ccc/748x1024bb.jpg" },
    ]);
  });
});

describe("appStoreCoordFromSource", () => {
  const sourceWith = (metadata: string) => ({ type: "appstore", metadata }) as unknown as Source;

  it("reads the coord from a valid appStore metadata block", () => {
    const source = sourceWith(
      JSON.stringify({ appStore: { trackId: "324684580", platform: "macos", storefront: "gb" } }),
    );
    expect(appStoreCoordFromSource(source)).toEqual({
      trackId: "324684580",
      platform: "macos",
      storefront: "gb",
    });
  });
  it("defaults platform/storefront when only trackId is present", () => {
    const source = sourceWith(JSON.stringify({ appStore: { trackId: "324684580" } }));
    expect(appStoreCoordFromSource(source)).toEqual({
      trackId: "324684580",
      platform: "ios",
      storefront: "us",
    });
  });
  it("returns null when metadata has no appStore block", () => {
    expect(appStoreCoordFromSource(sourceWith("{}"))).toBeNull();
  });
  it("returns null when metadata is malformed JSON", () => {
    expect(appStoreCoordFromSource(sourceWith("not json"))).toBeNull();
  });
});
