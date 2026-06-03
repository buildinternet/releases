import { describe, it, expect } from "bun:test";
import { thumbUrl, isGifSrc, shouldRenderAsVideo } from "./media";

const origin = "https://media.releases.sh";

describe("thumbUrl", () => {
  it("returns src unchanged when the transform flag is off", () => {
    const src = `${origin}/releases/abc.png`;
    expect(thumbUrl(src, 240, { enabled: false, origin })).toBe(src);
  });

  it("transforms a same-origin (R2-hosted) image when enabled", () => {
    expect(thumbUrl(`${origin}/releases/abc.png`, 240, { enabled: true, origin })).toBe(
      `${origin}/cdn-cgi/image/width=240,quality=80,format=auto/${origin}/releases/abc.png`,
    );
  });

  it("passes a third-party src through untransformed when enabled (same-origin gate)", () => {
    const src = "https://cdn.vendor.com/blog/hero.png";
    expect(thumbUrl(src, 240, { enabled: true, origin })).toBe(src);
  });

  it("does not treat a host that merely prefixes the origin as same-origin", () => {
    const src = "https://media.releases.sh.evil.com/releases/abc.png";
    expect(thumbUrl(src, 240, { enabled: true, origin })).toBe(src);
  });

  it("passes a relative/non-absolute src through", () => {
    expect(thumbUrl("/_media/releases/x.png", 240, { enabled: true, origin })).toBe(
      "/_media/releases/x.png",
    );
  });
});

describe("isGifSrc", () => {
  it("detects a .gif pathname on an absolute URL", () => {
    expect(isGifSrc("https://cdn.example.com/demo.gif")).toBe(true);
  });

  it("detects .gif even when the URL carries cdn-cgi options and a query", () => {
    const src =
      "https://media.beehiiv.com/cdn-cgi/image/format=auto,onerror=redirect/uploads/x/audience_templates.gif?v=2";
    expect(isGifSrc(src)).toBe(true);
  });

  it("is false for non-gif raster URLs", () => {
    expect(isGifSrc("https://cdn.example.com/a.png")).toBe(false);
    expect(isGifSrc("https://cdn.example.com/a.jpg")).toBe(false);
  });

  it("is false for a non-parseable string", () => {
    expect(isGifSrc("not a url")).toBe(false);
  });
});

describe("shouldRenderAsVideo", () => {
  const src = "https://cdn.example.com/demo.gif";

  it("is false when the flag is off, even for a gif", () => {
    expect(shouldRenderAsVideo({ type: "gif", src, enabled: false })).toBe(false);
  });

  it("is true for a gif-typed item when enabled", () => {
    expect(shouldRenderAsVideo({ type: "gif", src: "https://x/y", enabled: true })).toBe(true);
  });

  it("is true for a .gif src even when the stored type is image", () => {
    expect(shouldRenderAsVideo({ type: "image", src, enabled: true })).toBe(true);
  });

  it("is false for a non-gif image when enabled", () => {
    expect(
      shouldRenderAsVideo({ type: "image", src: "https://cdn.example.com/a.png", enabled: true }),
    ).toBe(false);
  });
});
