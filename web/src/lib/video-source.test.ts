import { describe, it, expect } from "bun:test";
import {
  youtubeVideoId,
  youtubeEmbedUrl,
  videoRowInfoFromWire,
  getVideoInfo,
  resolveVideoEmbed,
} from "./video-source";

describe("youtubeVideoId", () => {
  it("extracts from a watch URL", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=7-1tNo8HAwk")).toBe("7-1tNo8HAwk");
  });

  it("extracts from a watch URL with trailing params", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&t=10")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("extracts from a youtu.be share URL", () => {
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from an embed URL", () => {
    expect(youtubeVideoId("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("falls back to the thumbnail media path when the URL carries no id", () => {
    expect(
      youtubeVideoId("https://example.com/post", [
        { url: "https://i4.ytimg.com/vi/7-1tNo8HAwk/hqdefault.jpg" },
      ]),
    ).toBe("7-1tNo8HAwk");
  });

  it("prefers the URL over the media fallback", () => {
    expect(
      youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ", [
        { url: "https://i4.ytimg.com/vi/7-1tNo8HAwk/hqdefault.jpg" },
      ]),
    ).toBe("dQw4w9WgXcQ");
  });

  it("returns null when no id is present", () => {
    expect(youtubeVideoId("https://example.com/post")).toBeNull();
    expect(youtubeVideoId(null)).toBeNull();
    expect(youtubeVideoId(undefined, [])).toBeNull();
  });
});

describe("youtubeEmbedUrl", () => {
  it("builds a nocookie autoplay embed", () => {
    expect(youtubeEmbedUrl("dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0",
    );
  });
});

describe("videoRowInfoFromWire", () => {
  it("maps a provider to its label", () => {
    expect(videoRowInfoFromWire({ provider: "youtube" })).toEqual({
      provider: "youtube",
      label: "YouTube",
    });
  });

  it("returns null for an absent facet", () => {
    expect(videoRowInfoFromWire(null)).toBeNull();
    expect(videoRowInfoFromWire(undefined)).toBeNull();
  });
});

describe("getVideoInfo", () => {
  it("returns null for non-video sources", () => {
    expect(getVideoInfo({ type: "scrape", metadata: null })).toBeNull();
  });

  it("parses the provider from metadata", () => {
    expect(
      getVideoInfo({ type: "video", metadata: JSON.stringify({ video: { provider: "youtube" } }) }),
    ).toEqual({ provider: "youtube", label: "YouTube" });
  });
});

describe("resolveVideoEmbed", () => {
  it("resolves a YouTube embed from the release URL", () => {
    expect(
      resolveVideoEmbed({ provider: "youtube" }, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toEqual({
      embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0",
      label: "YouTube",
    });
  });

  it("falls back to the thumbnail media path", () => {
    expect(
      resolveVideoEmbed({ provider: "youtube" }, "https://example.com/post", [
        { url: "https://i4.ytimg.com/vi/7-1tNo8HAwk/hqdefault.jpg" },
      ]),
    ).toEqual({
      embedUrl: "https://www.youtube-nocookie.com/embed/7-1tNo8HAwk?autoplay=1&rel=0",
      label: "YouTube",
    });
  });

  it("returns null for an absent facet", () => {
    expect(resolveVideoEmbed(null, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("returns null when no id is recoverable", () => {
    expect(resolveVideoEmbed({ provider: "youtube" }, "https://example.com/post")).toBeNull();
  });

  it("returns null for providers without a wired player", () => {
    expect(resolveVideoEmbed({ provider: "vimeo" }, "https://vimeo.com/123456789")).toBeNull();
  });
});
