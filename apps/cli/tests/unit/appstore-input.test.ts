import { describe, it, expect } from "bun:test";
import {
  parseAppStoreInput,
  isAppStoreUrl,
  isAppStoreCoordinate,
} from "../../src/cli/commands/create-appstore.js";

describe("parseAppStoreInput", () => {
  it("classifies a bare numeric track ID as trackId", () => {
    expect(parseAppStoreInput("618783545")).toEqual({ trackId: "618783545" });
  });

  it("strips an appstore: coordinate prefix to a trackId (case-insensitive)", () => {
    expect(parseAppStoreInput("appstore:618783545")).toEqual({ trackId: "618783545" });
    expect(parseAppStoreInput("AppStore:618783545")).toEqual({ trackId: "618783545" });
  });

  it("classifies an apps.apple.com URL as url", () => {
    const url = "https://apps.apple.com/us/app/slack/id618783545";
    expect(parseAppStoreInput(url)).toEqual({ url });
  });

  it("accepts a scheme-less apps.apple.com URL", () => {
    const url = "apps.apple.com/us/app/slack/id618783545";
    expect(parseAppStoreInput(url)).toEqual({ url });
  });

  it("strips an appstore: prefix from a URL too", () => {
    const url = "https://apps.apple.com/us/app/slack/id618783545";
    expect(parseAppStoreInput(`appstore:${url}`)).toEqual({ url });
  });

  it("trims surrounding whitespace", () => {
    expect(parseAppStoreInput("  618783545  ")).toEqual({ trackId: "618783545" });
  });

  it("errors on empty input", () => {
    expect("error" in parseAppStoreInput("   ")).toBe(true);
  });

  it("errors on a non-App Store URL", () => {
    expect("error" in parseAppStoreInput("https://example.com/app")).toBe(true);
  });

  it("errors on arbitrary text", () => {
    expect("error" in parseAppStoreInput("not-an-id")).toBe(true);
  });
});

describe("isAppStoreUrl", () => {
  it("matches apps.apple.com with and without scheme, and subdomains", () => {
    expect(isAppStoreUrl("https://apps.apple.com/us/app/x/id1")).toBe(true);
    expect(isAppStoreUrl("apps.apple.com/us/app/x/id1")).toBe(true);
    expect(isAppStoreUrl("https://geo.apps.apple.com/us/app/x/id1")).toBe(true);
  });

  it("rejects other hosts and look-alikes", () => {
    expect(isAppStoreUrl("https://example.com")).toBe(false);
    expect(isAppStoreUrl("https://apple.com")).toBe(false);
    expect(isAppStoreUrl("https://notapps.apple.com")).toBe(false);
    expect(isAppStoreUrl("https://apps.apple.com.evil.com")).toBe(false);
  });

  it("rejects a bare numeric id (not a URL)", () => {
    expect(isAppStoreUrl("618783545")).toBe(false);
  });
});

describe("isAppStoreCoordinate", () => {
  it("matches the appstore: prefix case-insensitively", () => {
    expect(isAppStoreCoordinate("appstore:123")).toBe(true);
    expect(isAppStoreCoordinate("AppStore:123")).toBe(true);
    expect(isAppStoreCoordinate("  appstore:123  ")).toBe(true);
  });

  it("does not match other inputs", () => {
    expect(isAppStoreCoordinate("https://apps.apple.com/x")).toBe(false);
    expect(isAppStoreCoordinate("123")).toBe(false);
  });
});
