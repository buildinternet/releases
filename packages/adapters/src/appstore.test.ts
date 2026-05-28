import { describe, it, expect } from "bun:test";
import { appStoreSourceInfo } from "./appstore";

describe("appStoreSourceInfo", () => {
  const meta = JSON.stringify({
    appStore: {
      trackId: "1",
      storefront: "us",
      platform: "macos",
      artworkUrl: "https://is1-ssl.mzstatic.com/a/1024x1024bb.png",
    },
  });

  it("returns platform + iconUrl for an appstore source", () => {
    expect(appStoreSourceInfo("appstore", meta)).toEqual({
      platform: "macos",
      iconUrl: "https://is1-ssl.mzstatic.com/a/1024x1024bb.png",
    });
  });

  it("returns null for a non-appstore source", () => {
    expect(appStoreSourceInfo("feed", meta)).toBeNull();
  });

  it("defaults to ios + null icon when metadata is missing/empty", () => {
    expect(appStoreSourceInfo("appstore", null)).toEqual({ platform: "ios", iconUrl: null });
    expect(appStoreSourceInfo("appstore", "{}")).toEqual({ platform: "ios", iconUrl: null });
  });

  it("tolerates malformed JSON (ios + null icon)", () => {
    expect(appStoreSourceInfo("appstore", "{not json")).toEqual({ platform: "ios", iconUrl: null });
  });

  it("ignores a non-string artworkUrl", () => {
    const bad = JSON.stringify({ appStore: { platform: "ios", artworkUrl: 42 } });
    expect(appStoreSourceInfo("appstore", bad)).toEqual({ platform: "ios", iconUrl: null });
  });
});
