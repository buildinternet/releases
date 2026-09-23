import type { ReleaseItem } from "@/lib/api";

type FeedMediaItem = NonNullable<ReleaseItem["media"]>[number];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `url` is embedded as an inline-rendered image in markdown/HTML text. */
export function isInlineRenderedMedia(url: string, content: string): boolean {
  if (!url || !content) return false;
  const esc = escapeRegExp(url);

  // Markdown image: ![alt](url) or ![alt](url "title"); optional angle brackets.
  const mdImage = new RegExp(`!\\[[^\\]]*\\]\\(\\s*<?${esc}>?(?:\\s+"[^"]*")?\\s*\\)`, "i");
  if (mdImage.test(content)) return true;

  // Inline HTML (common after html-to-markdown ingest).
  const htmlImg = new RegExp(`<img\\b[^>]*\\bsrc\\s*=\\s*(?:"${esc}"|'${esc}')`, "i");
  return htmlImg.test(content);
}

function isInlineMedia(item: FeedMediaItem, content: string): boolean {
  return (
    isInlineRenderedMedia(item.url, content) ||
    !!(item.r2Url && isInlineRenderedMedia(item.r2Url, content))
  );
}

/** Structured `media[]` images/gifs not already rendered inline in the excerpt. */
export function feedAttachments(media: ReleaseItem["media"] | undefined, content: string) {
  return (
    media?.filter((m) => (m.type === "image" || m.type === "gif") && !isInlineMedia(m, content)) ??
    []
  );
}
