import { describe, it, expect } from "bun:test";
import { getAppInfo } from "./app-source";

const meta = (o: unknown) => JSON.stringify(o);

describe("getAppInfo", () => {
  it("returns null for non-app sources", () => {
    expect(getAppInfo({ type: "scrape", metadata: null })).toBeNull();
    expect(
      getAppInfo({ type: "github", metadata: meta({ appStore: { platform: "ios" } }) }),
    ).toBeNull();
  });

  it("maps an iOS app store source", () => {
    expect(
      getAppInfo({
        type: "appstore",
        metadata: meta({ appStore: { platform: "ios", artworkUrl: "https://cdn/x.png" } }),
      }),
    ).toEqual({ platform: "ios", label: "iOS", iconUrl: "https://cdn/x.png" });
  });

  it("maps a macOS app store source", () => {
    expect(
      getAppInfo({
        type: "appstore",
        metadata: meta({ appStore: { platform: "macos", artworkUrl: "https://cdn/y.png" } }),
      }),
    ).toEqual({ platform: "macos", label: "macOS", iconUrl: "https://cdn/y.png" });
  });

  it("defaults to iOS + null icon when metadata is missing or malformed", () => {
    expect(getAppInfo({ type: "appstore", metadata: null })).toEqual({
      platform: "ios",
      label: "iOS",
      iconUrl: null,
    });
    expect(getAppInfo({ type: "appstore", metadata: "{not json" })).toEqual({
      platform: "ios",
      label: "iOS",
      iconUrl: null,
    });
  });
});
