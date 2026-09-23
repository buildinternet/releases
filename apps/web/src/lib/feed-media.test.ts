import { describe, it, expect } from "bun:test";
import { feedAttachments, isInlineRenderedMedia } from "./feed-media";
import type { ReleaseItem } from "@/lib/api";

const IMG = "https://cdn.example.com/dashboard.png";
const R2 = "https://media.releases.sh/releases/abc.png";

describe("isInlineRenderedMedia", () => {
  it("matches markdown image syntax", () => {
    expect(isInlineRenderedMedia(IMG, `![Dashboard](${IMG})`)).toBe(true);
    expect(isInlineRenderedMedia(IMG, `![Dashboard](${IMG} "title")`)).toBe(true);
  });

  it("matches inline HTML img tags", () => {
    expect(isInlineRenderedMedia(IMG, `<img src="${IMG}" alt="Dashboard">`)).toBe(true);
  });

  it("does not match plain text or markdown links", () => {
    const body = `See the screenshot at ${IMG} or [open it](${IMG}).`;
    expect(isInlineRenderedMedia(IMG, body)).toBe(false);
  });
});

describe("feedAttachments", () => {
  const media = [
    { type: "image" as const, url: IMG, r2Url: R2, alt: "Dashboard" },
  ] satisfies NonNullable<ReleaseItem["media"]>;

  it("excludes media rendered inline in markdown", () => {
    expect(feedAttachments(media, `![Dashboard](${IMG})`)).toEqual([]);
  });

  it("keeps media when the URL is only mentioned as text", () => {
    expect(feedAttachments(media, `See ${IMG} for details.`)).toEqual(media);
  });

  it("keeps media when the URL appears only in a markdown link", () => {
    expect(feedAttachments(media, `[Dashboard](${IMG})`)).toEqual(media);
  });
});
