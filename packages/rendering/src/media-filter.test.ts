import { describe, expect, test } from "bun:test";
import {
  isJunkMediaUrl,
  filterJunkMedia,
  hasTinyForcedDimensions,
  parseForcedMediaDimensions,
} from "./media-filter.js";

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

  test("flags Vercel Cloudinary 32×32 author headshot transforms", () => {
    const urls = [
      "https://assets.vercel.com/image/upload/f_auto,c_fill,w_32,h_32,q_75/contentful/image/e5382hct74si/6qvpRjZDpvV0JLU8mXx2v4/53962a54ad214cde165e18813940354e/806FE12B-9B25-4A8F-AB72-0853E48B1734_1_105_c_2__1_.jpg",
      "https://assets.vercel.com/image/upload/f_auto,c_fill,w_32,h_32,q_75/contentful/image/e5382hct74si/6kCjf7r5GljxZ3st8gvxkb/07d0d7088c6a37bd9921a2e68ab64725/rich-haines-128.jpg",
    ];
    for (const url of urls) {
      expect(isJunkMediaUrl(url)).toBe(true);
      expect(hasTinyForcedDimensions(url)).toBe(true);
    }
  });

  test("flags imgix-style tiny w/h query thumbs", () => {
    expect(isJunkMediaUrl("https://cdn.example.com/photo.jpg?w=64&h=64&fit=crop")).toBe(true);
  });

  test("passes a real screenshot URL", () => {
    expect(isJunkMediaUrl("https://cdn.example.com/blog/release-hero.png")).toBe(false);
  });

  test("passes a real (non-badge) SVG logo/diagram", () => {
    expect(isJunkMediaUrl("https://cdn.example.com/assets/architecture-diagram.svg")).toBe(false);
  });

  test("passes a large Cloudinary hero crop (not tiny)", () => {
    expect(
      isJunkMediaUrl(
        "https://assets.vercel.com/image/upload/f_auto,c_fill,w_1200,h_630,q_75/contentful/image/hero.png",
      ),
    ).toBe(false);
  });

  test("passes a product icon path that is not a tiny transform", () => {
    // classify-media-relevance deliberately does not hard-drop `/icons/` paths.
    expect(isJunkMediaUrl("https://cdn.example.com/icons/new-icon-set-hero.png")).toBe(false);
  });

  test("returns false for null/undefined/empty", () => {
    expect(isJunkMediaUrl(null)).toBe(false);
    expect(isJunkMediaUrl(undefined)).toBe(false);
    expect(isJunkMediaUrl("")).toBe(false);
  });
});

describe("parseForcedMediaDimensions", () => {
  test("reads Cloudinary w_/h_ path segments", () => {
    expect(
      parseForcedMediaDimensions(
        "https://assets.vercel.com/image/upload/f_auto,c_fill,w_32,h_32,q_75/x.jpg",
      ),
    ).toEqual({ width: 32, height: 32 });
  });

  test("reads query width/height", () => {
    expect(parseForcedMediaDimensions("https://cdn.example.com/a.jpg?width=96&height=96")).toEqual({
      width: 96,
      height: 96,
    });
  });
});

describe("filterJunkMedia", () => {
  test("drops junk items and keeps real ones, preserving order + fields", () => {
    const input = [
      { type: "image" as const, url: "https://cdn.example.com/hero.png", alt: "Hero" },
      { type: "image" as const, url: "https://example.com/favicon.ico" },
      { type: "image" as const, url: "https://cdn.example.com/screenshot.jpg", alt: "Shot" },
      { type: "image" as const, url: "data:image/gif;base64,R0lGODlhAQ" },
      {
        type: "image" as const,
        url: "https://assets.vercel.com/image/upload/f_auto,c_fill,w_32,h_32,q_75/contentful/image/rich-haines-128.jpg",
      },
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
