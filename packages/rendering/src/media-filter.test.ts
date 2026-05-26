import { describe, expect, test } from "bun:test";
import { isJunkMediaUrl, filterJunkMedia } from "./media-filter.js";

describe("isJunkMediaUrl", () => {
  test("flags avatar crop markers (c_fill,w_NN)", () => {
    expect(isJunkMediaUrl("https://res.cloudinary.com/x/c_fill,w_44/avatar.png")).toBe(true);
  });

  test("flags /avatar/ paths", () => {
    expect(isJunkMediaUrl("https://cdn.example.com/avatar/user.png")).toBe(true);
  });

  test("flags small ?s=NN avatar sizes", () => {
    expect(isJunkMediaUrl("https://gravatar.com/avatar/abc?s=48")).toBe(true);
  });

  test("flags favicons", () => {
    expect(isJunkMediaUrl("https://example.com/favicon.ico")).toBe(true);
    expect(isJunkMediaUrl("https://example.com/assets/favicon-32x32.png")).toBe(true);
  });

  test("flags data: URIs", () => {
    expect(isJunkMediaUrl("data:image/gif;base64,R0lGODlhAQ")).toBe(true);
  });

  test("passes a real screenshot URL", () => {
    expect(isJunkMediaUrl("https://cdn.example.com/blog/release-hero.png")).toBe(false);
  });

  test("returns false for null/undefined/empty", () => {
    expect(isJunkMediaUrl(null)).toBe(false);
    expect(isJunkMediaUrl(undefined)).toBe(false);
    expect(isJunkMediaUrl("")).toBe(false);
  });
});

describe("filterJunkMedia", () => {
  test("drops junk items and keeps real ones, preserving order + fields", () => {
    const input = [
      { type: "image" as const, url: "https://cdn.example.com/hero.png", alt: "Hero" },
      { type: "image" as const, url: "https://example.com/favicon.ico" },
      { type: "image" as const, url: "https://cdn.example.com/screenshot.jpg", alt: "Shot" },
      { type: "image" as const, url: "data:image/gif;base64,R0lGODlhAQ" },
    ];

    expect(filterJunkMedia(input)).toEqual([
      { type: "image", url: "https://cdn.example.com/hero.png", alt: "Hero" },
      { type: "image", url: "https://cdn.example.com/screenshot.jpg", alt: "Shot" },
    ]);
  });

  test("returns an empty array unchanged", () => {
    expect(filterJunkMedia([])).toEqual([]);
  });
});
