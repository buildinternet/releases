import { describe, it, expect } from "bun:test";
import {
  thumbUrl,
  isGifSrc,
  isMp4Src,
  shouldRenderAsVideo,
  videoUrl,
  pickReleaseThumb,
} from "./media";

const origin = "https://media.releases.sh";

describe("thumbUrl", () => {
  it("returns src unchanged when the transform flag is off", () => {
    const src = `${origin}/releases/abc.png`;
    expect(thumbUrl(src, 240, { enabled: false, origin })).toBe(src);
  });

  it("passes same-origin AVIF and MP4 through untransformed (the transform answers 415)", () => {
    for (const src of [`${origin}/releases/abc.avif`, `${origin}/releases/abc.mp4`]) {
      expect(thumbUrl(src, 240, { enabled: true, origin })).toBe(src);
    }
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
  const sameOriginGif = `${origin}/releases/demo.gif`;

  it("is false when the flag is off, even for a same-origin gif", () => {
    expect(shouldRenderAsVideo({ type: "gif", src: sameOriginGif, enabled: false, origin })).toBe(
      false,
    );
  });

  it("is true for a same-origin gif-typed item when enabled", () => {
    expect(
      shouldRenderAsVideo({ type: "gif", src: `${origin}/releases/x.mp4`, enabled: true, origin }),
    ).toBe(true);
  });

  it("is true for a same-origin .gif src even when the stored type is image", () => {
    expect(shouldRenderAsVideo({ type: "image", src: sameOriginGif, enabled: true, origin })).toBe(
      true,
    );
  });

  it("is true for a same-origin .mp4 src stored as type image (an <img> can't play it)", () => {
    expect(
      shouldRenderAsVideo({
        type: "image",
        src: `${origin}/releases/x.mp4`,
        enabled: true,
        origin,
      }),
    ).toBe(true);
  });

  it("is false for a third-party gif (same-origin gate — renders as <img> until mirrored)", () => {
    const thirdParty = "https://cdn.example.com/demo.gif";
    expect(shouldRenderAsVideo({ type: "gif", src: thirdParty, enabled: true, origin })).toBe(
      false,
    );
  });

  it("does not treat a host that merely prefixes the origin as same-origin", () => {
    const src = "https://media.releases.sh.evil.com/releases/demo.gif";
    expect(shouldRenderAsVideo({ type: "gif", src, enabled: true, origin })).toBe(false);
  });

  it("is false for a same-origin non-gif image when enabled", () => {
    expect(
      shouldRenderAsVideo({
        type: "image",
        src: `${origin}/releases/a.png`,
        enabled: true,
        origin,
      }),
    ).toBe(false);
  });

  it("defaults origin to the media origin when not passed", () => {
    expect(shouldRenderAsVideo({ type: "gif", src: sameOriginGif, enabled: true })).toBe(true);
    expect(
      shouldRenderAsVideo({ type: "gif", src: "https://cdn.example.com/x.gif", enabled: true }),
    ).toBe(false);
  });
});

describe("isMp4Src", () => {
  it("detects a .mp4 pathname, case-insensitively", () => {
    expect(isMp4Src(`${origin}/releases/abc.mp4`)).toBe(true);
    expect(isMp4Src(`${origin}/releases/abc.MP4?v=1`)).toBe(true);
  });

  it("is false for gifs and unparseable strings", () => {
    expect(isMp4Src(`${origin}/releases/abc.gif`)).toBe(false);
    expect(isMp4Src("not a url")).toBe(false);
  });
});

describe("videoUrl", () => {
  it("serves an already-transcoded same-origin mp4 directly, with no transform", () => {
    const src = `${origin}/releases/abc.mp4`;
    expect(videoUrl(src, origin)).toBe(src);
  });

  it("routes a same-origin gif through the media transform", () => {
    const src = `${origin}/releases/abc.gif`;
    expect(videoUrl(src, origin)).toBe(`${origin}/cdn-cgi/media/mode=video/${src}`);
  });

  it("does not skip the transform for an mp4 on a look-alike host", () => {
    const src = "https://media.releases.sh.evil.com/releases/abc.mp4";
    expect(videoUrl(src, origin)).toBe(`${origin}/cdn-cgi/media/mode=video/${src}`);
  });
});
