import { describe, expect, it } from "bun:test";
import {
  canonicalVideoFromUrl,
  detectInlineVideoLinks,
  detectInlineVideos,
  resolveInlineVideo,
  type DetectedVideoLink,
} from "./video-embed.ts";

describe("detectInlineVideoLinks", () => {
  it("detects a Wistia embed link in markdown", () => {
    const body = "Watch it: [Video](https://fast.wistia.com/embed/iframe/wh6pjz981z)";
    const links = detectInlineVideoLinks(body);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      provider: "wistia",
      id: "wh6pjz981z",
      // Embed form is the public click target (medias/<id> redirects to login).
      watchUrl: "https://fast.wistia.com/embed/iframe/wh6pjz981z",
    });
    // oEmbed still keys off the documented medias/<id> URL.
    expect(links[0]!.oembedUrl).toBe(
      "https://fast.wistia.com/oembed?url=https%3A%2F%2Ffast.wistia.com%2Fmedias%2Fwh6pjz981z",
    );
  });

  it("detects a Wistia /medias/ link", () => {
    const links = detectInlineVideoLinks("https://acme.wistia.com/medias/abc123");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ provider: "wistia", id: "abc123" });
  });

  it("detects a Loom share link", () => {
    const links = detectInlineVideoLinks("[demo](https://www.loom.com/share/deadbeef00)");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      provider: "loom",
      id: "deadbeef00",
      watchUrl: "https://www.loom.com/share/deadbeef00",
    });
  });

  it("detects a Vimeo player link and a bare vimeo link", () => {
    expect(detectInlineVideoLinks("https://player.vimeo.com/video/123456789")[0]).toMatchObject({
      provider: "vimeo",
      id: "123456789",
      watchUrl: "https://vimeo.com/123456789",
    });
    expect(detectInlineVideoLinks("https://vimeo.com/987654321")[0]).toMatchObject({
      provider: "vimeo",
      id: "987654321",
    });
  });

  it("detects YouTube watch, embed, shorts, and youtu.be forms", () => {
    expect(detectInlineVideoLinks("https://www.youtube.com/watch?v=dQw4w9WgXcQ")[0]).toMatchObject({
      provider: "youtube",
      id: "dQw4w9WgXcQ",
      watchUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(detectInlineVideoLinks("https://www.youtube.com/embed/dQw4w9WgXcQ")[0]).toMatchObject({
      id: "dQw4w9WgXcQ",
    });
    expect(detectInlineVideoLinks("https://www.youtube.com/shorts/dQw4w9WgXcQ")[0]).toMatchObject({
      id: "dQw4w9WgXcQ",
    });
    expect(detectInlineVideoLinks("https://youtu.be/dQw4w9WgXcQ")[0]).toMatchObject({
      id: "dQw4w9WgXcQ",
    });
  });

  it("dedupes by provider+id keeping first occurrence", () => {
    const body = `
      [a](https://fast.wistia.com/embed/iframe/wh6pjz981z)
      [b](https://fast.wistia.com/medias/wh6pjz981z)
    `;
    const links = detectInlineVideoLinks(body);
    expect(links).toHaveLength(1);
    expect(links[0]!.matchedUrl).toContain("embed/iframe");
  });

  it("preserves first-appearance order across providers", () => {
    const body = "first https://youtu.be/dQw4w9WgXcQ then https://www.loom.com/share/aaaaaaaaaa";
    const links = detectInlineVideoLinks(body);
    expect(links.map((l) => l.provider)).toEqual(["youtube", "loom"]);
  });

  it("strips trailing punctuation clinging to a URL", () => {
    const links = detectInlineVideoLinks("see https://vimeo.com/123456789.");
    expect(links[0]).toMatchObject({ id: "123456789" });
    expect(links[0]!.matchedUrl).toBe("https://vimeo.com/123456789");
  });

  it("ignores non-video and unrecognised hosts", () => {
    expect(detectInlineVideoLinks("https://example.com/video/foo")).toHaveLength(0);
    expect(detectInlineVideoLinks("https://www.youtube.com/feed/subscriptions")).toHaveLength(0);
    expect(detectInlineVideoLinks("no links here")).toHaveLength(0);
    expect(detectInlineVideoLinks(null)).toHaveLength(0);
    expect(detectInlineVideoLinks("")).toHaveLength(0);
  });

  it("does not match a lookalike host (wistia.com.evil.com)", () => {
    expect(detectInlineVideoLinks("https://wistia.com.evil.com/medias/abc123")).toHaveLength(0);
  });
});

const WISTIA_LINK: DetectedVideoLink = {
  provider: "wistia",
  id: "wh6pjz981z",
  matchedUrl: "https://fast.wistia.com/embed/iframe/wh6pjz981z",
  watchUrl: "https://fast.wistia.com/embed/iframe/wh6pjz981z",
  oembedUrl: "https://fast.wistia.com/oembed?url=...",
};

function mockFetch(payload: unknown, init?: { ok?: boolean; throws?: boolean }): typeof fetch {
  return (async () => {
    if (init?.throws) throw new Error("network");
    return {
      ok: init?.ok ?? true,
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("resolveInlineVideo", () => {
  it("resolves the Wistia oEmbed example to a video media item", async () => {
    const media = await resolveInlineVideo(WISTIA_LINK, {
      fetchImpl: mockFetch({
        type: "video",
        title: "Space planning: CAD Upload",
        thumbnail_url: "https://embed-ssl.wistia.com/deliveries/abc.jpg?image_crop_resized=960x540",
        duration: 172.3,
      }),
    });
    expect(media).toEqual({
      type: "video",
      url: "https://embed-ssl.wistia.com/deliveries/abc.jpg?image_crop_resized=960x540",
      alt: "Space planning: CAD Upload",
      linkUrl: "https://fast.wistia.com/embed/iframe/wh6pjz981z",
    });
  });

  it("omits alt when oEmbed has no title", async () => {
    const media = await resolveInlineVideo(WISTIA_LINK, {
      fetchImpl: mockFetch({ type: "video", thumbnail_url: "https://x/t.jpg" }),
    });
    expect(media).toEqual({
      type: "video",
      url: "https://x/t.jpg",
      linkUrl: "https://fast.wistia.com/embed/iframe/wh6pjz981z",
    });
  });

  it("returns null when thumbnail_url is missing", async () => {
    const media = await resolveInlineVideo(WISTIA_LINK, {
      fetchImpl: mockFetch({ type: "video", title: "x" }),
    });
    expect(media).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    const media = await resolveInlineVideo(WISTIA_LINK, {
      fetchImpl: mockFetch({}, { ok: false }),
    });
    expect(media).toBeNull();
  });

  it("returns null on a fetch error (fail-open)", async () => {
    const media = await resolveInlineVideo(WISTIA_LINK, {
      fetchImpl: mockFetch({}, { throws: true }),
    });
    expect(media).toBeNull();
  });
});

describe("detectInlineVideos", () => {
  it("detects + resolves all videos in a body, dropping failures", async () => {
    const body = `
      [Video](https://fast.wistia.com/embed/iframe/wh6pjz981z)
      [Broken](https://vimeo.com/123456789)
    `;
    let call = 0;
    const fetchImpl = (async (url: string) => {
      call++;
      // Wistia resolves; Vimeo returns no thumbnail → dropped.
      if (String(url).includes("wistia")) {
        return {
          ok: true,
          json: async () => ({ type: "video", title: "W", thumbnail_url: "https://x/w.jpg" }),
        } as Response;
      }
      return { ok: true, json: async () => ({ type: "video" }) } as Response;
    }) as unknown as typeof fetch;

    const media = await detectInlineVideos(body, { fetchImpl });
    expect(call).toBe(2);
    expect(media).toEqual([
      {
        type: "video",
        url: "https://x/w.jpg",
        alt: "W",
        linkUrl: "https://fast.wistia.com/embed/iframe/wh6pjz981z",
      },
    ]);
  });

  it("caps fan-out at maxVideos", async () => {
    const body = [
      "https://youtu.be/aaaaaaaaaaa",
      "https://youtu.be/bbbbbbbbbbb",
      "https://youtu.be/ccccccccccc",
    ].join(" ");
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return { ok: true, json: async () => ({ thumbnail_url: "https://x/t.jpg" }) } as Response;
    }) as unknown as typeof fetch;
    const media = await detectInlineVideos(body, { fetchImpl, maxVideos: 2 });
    expect(call).toBe(2);
    expect(media).toHaveLength(2);
  });

  it("returns empty for a body with no video links (no fetch)", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const media = await detectInlineVideos("just text", { fetchImpl });
    expect(call).toBe(0);
    expect(media).toEqual([]);
  });
});

describe("canonicalVideoFromUrl", () => {
  it("collapses every Wistia URL form to the same id + embed watchUrl", () => {
    const forms = [
      "https://fast.wistia.com/embed/iframe/wh6pjz981z",
      "https://fast.wistia.com/medias/wh6pjz981z",
      "https://acme.wistia.com/embed/medias/wh6pjz981z.jsonp",
    ];
    for (const href of forms) {
      expect(canonicalVideoFromUrl(href)).toEqual({
        provider: "wistia",
        id: "wh6pjz981z",
        // Embed form is the public click target (medias/<id> redirects to login).
        watchUrl: "https://fast.wistia.com/embed/iframe/wh6pjz981z",
      });
    }
  });

  it("collapses every YouTube URL form to the same id", () => {
    const forms = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
    ];
    for (const href of forms) {
      expect(canonicalVideoFromUrl(href)).toEqual({
        provider: "youtube",
        id: "dQw4w9WgXcQ",
        watchUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      });
    }
  });

  it("matches Loom share + Vimeo player/bare forms", () => {
    expect(canonicalVideoFromUrl("https://www.loom.com/share/deadbeef00")).toEqual({
      provider: "loom",
      id: "deadbeef00",
      watchUrl: "https://www.loom.com/share/deadbeef00",
    });
    expect(canonicalVideoFromUrl("https://player.vimeo.com/video/123456789")).toEqual({
      provider: "vimeo",
      id: "123456789",
      watchUrl: "https://vimeo.com/123456789",
    });
  });

  it("returns null for non-video, unrecognised, or unparseable URLs", () => {
    expect(canonicalVideoFromUrl("https://example.com/video/foo")).toBeNull();
    expect(canonicalVideoFromUrl("https://www.youtube.com/feed/subscriptions")).toBeNull();
    expect(canonicalVideoFromUrl("https://wistia.com.evil.com/medias/abc123")).toBeNull();
    expect(canonicalVideoFromUrl("not a url")).toBeNull();
  });
});
