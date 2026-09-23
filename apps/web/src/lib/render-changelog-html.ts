import "server-only";
import { renderBodyMarkdownToHtml } from "@/lib/render-release-body";

/**
 * Server-only. Renders a CHANGELOG slice's markdown to an HTML string.
 *
 * The `/[org]/[slug]/changelog` + `/sources/[id]/changelog` viewer used to run
 * `react-markdown` + remark + shiki on the client (`ChangelogStream` rendered
 * every lazily-fetched chunk in the browser), dragging shiki (~1MB uncompressed)
 * + react-markdown into those two routes' first-load bundle. We now render each
 * slice on the server — the initial slice in `ChangelogView`, subsequent chunks
 * in the `/api/orgs/[org]/sources/[source]/changelog` route handler — and inject
 * the result via `dangerouslySetInnerHTML`, so the heavy markdown pipeline stays
 * server-side and shiki never reaches the browser (#1919).
 *
 * This reuses {@link renderBodyMarkdownToHtml} with the `"full"` variant, which
 * reproduces `markdownComponents({ demoteHeadings: 2 })` — the exact overrides
 * the old `ReactMarkdown` path used here (heading demotion by 2, the same
 * sanitized image class, external-link handling). The one documented behavior
 * delta carried over from that shared pipeline: inline YouTube/Vimeo/Loom iframe
 * and `.mp4` video embeds render as plain links rather than embeds — a CHANGELOG
 * file virtually never carries these, and `rehype-stringify` emits the same
 * *sanitized* markup `react-markdown` did, so `dangerouslySetInnerHTML` adds no
 * injection surface.
 */
export function renderChangelogHtml(content: string): string {
  if (!content.trim()) return "";
  return renderBodyMarkdownToHtml(content, "full");
}
