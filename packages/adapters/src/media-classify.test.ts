import { describe, expect, test } from "bun:test";
import { classifyMediaType, isGifUrl } from "./media-classify.js";

describe("isGifUrl", () => {
  test("plain .gif", () => {
    expect(isGifUrl("https://x.test/demo.gif")).toBe(true);
  });
  test("uppercase extension", () => {
    expect(isGifUrl("https://x.test/DEMO.GIF")).toBe(true);
  });
  test("ignores query string", () => {
    expect(isGifUrl("https://x.test/demo.gif?w=100&v=2")).toBe(true);
  });
  test("resize-wrapper URL whose path ends in .gif", () => {
    expect(
      isGifUrl(
        "https://media.beehiiv.com/cdn-cgi/image/format=auto/uploads/asset/file/abc/subscribe_forms.gif",
      ),
    ).toBe(true);
  });
  test("non-gif is false", () => {
    expect(isGifUrl("https://x.test/shot.png")).toBe(false);
    expect(isGifUrl("https://www.youtube.com/watch?v=abc")).toBe(false);
  });
  test("a 'gif' substring that is not the extension is not a match", () => {
    expect(isGifUrl("https://x.test/gifts/banner.png")).toBe(false);
  });
});

describe("classifyMediaType", () => {
  test(".gif → gif", () => {
    expect(classifyMediaType("https://x.test/a.gif")).toBe("gif");
  });
  test(".mp4/.webm/.mov → video", () => {
    expect(classifyMediaType("https://x.test/a.mp4")).toBe("video");
    expect(classifyMediaType("https://x.test/a.webm")).toBe("video");
    expect(classifyMediaType("https://x.test/a.mov")).toBe("video");
  });
  test("everything else → image", () => {
    expect(classifyMediaType("https://x.test/a.png")).toBe("image");
    expect(classifyMediaType("https://x.test/a.jpeg?cache=1")).toBe("image");
  });
});
