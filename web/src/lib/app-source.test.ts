import { describe, it, expect } from "bun:test";
import { getAppInfo, appStoreIconUrl, appRowInfoFromWire, keepInCrossPromo } from "./app-source";

const meta = (o: unknown) => JSON.stringify(o);

describe("keepInCrossPromo (client-side ticker gate)", () => {
  it("always shows non-app releases regardless of importance", () => {
    expect(keepInCrossPromo(false, null)).toBe(true);
    expect(keepInCrossPromo(false, 1)).toBe(true);
    expect(keepInCrossPromo(false, undefined)).toBe(true);
  });

  it("shows a flame-threshold app release (4–5)", () => {
    expect(keepInCrossPromo(true, 4)).toBe(true);
    expect(keepInCrossPromo(true, 5)).toBe(true);
  });

  it("hides a low-importance app release (1–3)", () => {
    expect(keepInCrossPromo(true, 1)).toBe(false);
    expect(keepInCrossPromo(true, 3)).toBe(false);
  });

  it("hides an unscored app release (null/undefined folds below the floor)", () => {
    expect(keepInCrossPromo(true, null)).toBe(false);
    expect(keepInCrossPromo(true, undefined)).toBe(false);
  });
});

describe("appRowInfoFromWire", () => {
  it("maps ios/macos to the human label + carries icon + app name", () => {
    expect(appRowInfoFromWire({ platform: "ios", iconUrl: "x" }, "ChatGPT")).toEqual({
      label: "iOS",
      iconUrl: "x",
      appName: "ChatGPT",
    });
    expect(appRowInfoFromWire({ platform: "macos", iconUrl: null }, "Things")).toEqual({
      label: "macOS",
      iconUrl: null,
      appName: "Things",
    });
  });

  it("returns null when there is no appStore block (non-app source)", () => {
    expect(appRowInfoFromWire(null, "Acme")).toBeNull();
    expect(appRowInfoFromWire(undefined, "Acme")).toBeNull();
  });
});

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

  it("falls back to iOS + null icon when appStore fields are wrong-typed", () => {
    // JSON parses fine, but platform/artworkUrl are non-strings — must not leak
    // a number/boolean into the AppInfo contract.
    expect(
      getAppInfo({
        type: "appstore",
        metadata: meta({ appStore: { platform: 123, artworkUrl: false } }),
      }),
    ).toEqual({ platform: "ios", label: "iOS", iconUrl: null });
  });
});

describe("appStoreIconUrl", () => {
  it("rewrites the mzstatic dimension suffix to the requested size", () => {
    expect(appStoreIconUrl("https://is1-ssl.mzstatic.com/a/1024x1024bb.png", 96)).toBe(
      "https://is1-ssl.mzstatic.com/a/96x96bb.png",
    );
  });

  it("preserves the file extension (jpg)", () => {
    expect(appStoreIconUrl("https://is1-ssl.mzstatic.com/a/512x512bb.jpg", 72)).toBe(
      "https://is1-ssl.mzstatic.com/a/72x72bb.jpg",
    );
  });

  it("returns the url unchanged when it does not match the mzstatic pattern", () => {
    expect(appStoreIconUrl("https://example.com/icon.png", 96)).toBe(
      "https://example.com/icon.png",
    );
  });
});
