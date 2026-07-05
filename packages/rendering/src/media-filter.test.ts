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

  test("flags WordPress emoji sprites", () => {
    expect(isJunkMediaUrl("https://s.w.org/images/core/emoji/17.0.2/72x72/1f517.png")).toBe(true);
  });

  test("flags CI-review badges (cubic, stagereview, shields)", () => {
    expect(isJunkMediaUrl("https://www.cubic.dev/buttons/review-in-cubic-dark.svg")).toBe(true);
    expect(isJunkMediaUrl("https://stagereview.app/assets/gh-open-in-stage-light.svg")).toBe(true);
    expect(isJunkMediaUrl("https://img.shields.io/badge/build-passing-green.svg")).toBe(true);
  });

  test("passes a real screenshot URL", () => {
    expect(isJunkMediaUrl("https://cdn.example.com/blog/release-hero.png")).toBe(false);
  });

  test("passes a real (non-badge) SVG logo/diagram", () => {
    expect(isJunkMediaUrl("https://cdn.example.com/assets/architecture-diagram.svg")).toBe(false);
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
