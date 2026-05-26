import { describe, it, expect } from "bun:test";
import { thumbUrl } from "./media";

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

  it("passes a relative/non-absolute src through", () => {
    expect(thumbUrl("/_media/releases/x.png", 240, { enabled: true, origin })).toBe(
      "/_media/releases/x.png",
    );
  });
});
