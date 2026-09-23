import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildDetailComponents,
  matchVideoMedia,
  MediaGallery,
  type MediaItem,
  ReleaseContent,
} from "./release-content.tsx";

const VIDEO_ITEM: MediaItem = {
  type: "video",
  url: "https://embed-ssl.wistia.com/deliveries/poster.jpg",
  r2Url: "https://media.releases.sh/releases/abc.jpg",
  alt: "CAD Upload",
  // Stored linkUrl is the OLD medias/<id> form (pre-watchUrl-change row).
  linkUrl: "https://fast.wistia.com/medias/wh6pjz981z",
};

describe("matchVideoMedia", () => {
  it("matches a body embed href to a stored video item by id (old medias linkUrl)", () => {
    const href = "https://fast.wistia.com/embed/iframe/wh6pjz981z";
    expect(matchVideoMedia(href, [VIDEO_ITEM])).toBe(VIDEO_ITEM);
  });

  it("matches by id off the item url when linkUrl is absent", () => {
    const item: MediaItem = {
      type: "video",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      r2Url: "https://media.releases.sh/releases/yt.jpg",
    };
    expect(matchVideoMedia("https://youtu.be/dQw4w9WgXcQ", [item])).toBe(item);
  });

  it("returns null when no video item shares the href's id", () => {
    expect(
      matchVideoMedia("https://fast.wistia.com/embed/iframe/OTHERIDXX", [VIDEO_ITEM]),
    ).toBeNull();
  });

  it("returns null for a non-video href", () => {
    expect(matchVideoMedia("https://example.com/docs", [VIDEO_ITEM])).toBeNull();
  });

  it("ignores non-video media items", () => {
    const img: MediaItem = { type: "image", url: "https://fast.wistia.com/medias/wh6pjz981z" };
    expect(matchVideoMedia("https://fast.wistia.com/embed/iframe/wh6pjz981z", [img])).toBeNull();
  });
});

describe("inline a renderer (buildDetailComponents)", () => {
  it("renders the InlineVideoCard for a video href with a matching media item", () => {
    const A = buildDetailComponents([VIDEO_ITEM]).a;
    const html = renderToStaticMarkup(
      A({ href: "https://fast.wistia.com/embed/iframe/wh6pjz981z", children: "Video" }),
    );
    // Card links to the ORIGINAL body href (loadable), NOT the stored medias linkUrl.
    expect(html).toContain('href="https://fast.wistia.com/embed/iframe/wh6pjz981z"');
    expect(html).not.toContain("/medias/wh6pjz981z");
    // Poster comes from the matched item (r2Url; URL-encoded through the Next
    // image optimizer), and the play-card aria-label is present.
    expect(html).toContain("releases%2Fabc.jpg");
    expect(html.toLowerCase()).toContain("watch video");
  });

  it("falls back to a plain link when no media item matches", () => {
    const A = buildDetailComponents([]).a;
    const html = renderToStaticMarkup(
      A({ href: "https://fast.wistia.com/embed/iframe/wh6pjz981z", children: "Video" }),
    );
    expect(html).toContain("<a");
    expect(html).toContain("Video");
    // Not a card — no play-badge aria label.
    expect(html.toLowerCase()).not.toContain("watch video");
  });

  it("falls back to the base renderer for a plain non-video link", () => {
    const A = buildDetailComponents([VIDEO_ITEM]).a;
    const html = renderToStaticMarkup(A({ href: "https://example.com/docs", children: "Docs" }));
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain("Docs");
  });
});

describe("ReleaseContent empty-body placeholder", () => {
  it("renders a placeholder when there is no body and no media", () => {
    const html = renderToStaticMarkup(
      ReleaseContent({ content: "", title: "v2.1.177", media: [] }),
    );
    expect(html).toContain("This release contains no details.");
  });

  it("renders the placeholder when the body is only the leading title", () => {
    // stripLeadingTitle removes the H1 that duplicates the title, leaving nothing.
    const html = renderToStaticMarkup(
      ReleaseContent({ content: "# v2.1.177\n", title: "v2.1.177", media: [] }),
    );
    expect(html).toContain("This release contains no details.");
  });

  it("does NOT render the placeholder when media is present without body text", () => {
    const img: MediaItem = { type: "image", url: "https://cdn.example.com/shot.png" };
    const html = renderToStaticMarkup(
      ReleaseContent({ content: "", title: "v2.1.177", media: [img] }),
    );
    expect(html).not.toContain("This release contains no details.");
    expect(html).toContain("shot.png");
  });

  it("does NOT render the placeholder when the body has content", () => {
    const html = renderToStaticMarkup(
      ReleaseContent({ content: "Fixed a bug.", title: "v2.1.177", media: [] }),
    );
    expect(html).not.toContain("This release contains no details.");
    expect(html).toContain("Fixed a bug.");
  });
});

describe("MediaGallery", () => {
  it("excludes type:video items (they render inline)", () => {
    const out = MediaGallery({ media: [VIDEO_ITEM], content: "" });
    // Only video present → nothing left to render in the gallery.
    expect(out).toBeNull();
  });

  it("still renders image items not present in the body", () => {
    const img: MediaItem = { type: "image", url: "https://cdn.example.com/shot.png" };
    const out = MediaGallery({ media: [VIDEO_ITEM, img], content: "no media urls here" });
    const html = renderToStaticMarkup(out);
    expect(html).toContain("shot.png");
    // The video poster must not leak into the gallery.
    expect(html).not.toContain("releases/abc.jpg");
  });
});
