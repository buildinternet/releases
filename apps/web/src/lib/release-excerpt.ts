import { proseExcerpt } from "@releases/rendering/prose-excerpt";

/** Max characters of verbatim body to surface on feed surfaces. Beyond this we
 *  truncate so the full source text never ships in feed HTML (#1606). */
export const EXCERPT_MAX_CHARS = 280;

/** Strip a leading markdown heading that duplicates the release title, plus
 *  empty artifacts from HTML→markdown conversion. Moved out of
 *  `release-item.tsx` so the feed render and the excerpt helper share one copy. */
export function stripLeadingTitle(content: string, title: string | null): string {
  if (!title || !content) return content;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) {
    const onlyLine = content.replace(/^#+\s+/, "").trim();
    return onlyLine.toLowerCase() === title.toLowerCase() ? "" : content;
  }
  const firstLine = content
    .slice(0, firstNewline)
    .replace(/^#+\s+/, "")
    .trim();
  if (firstLine.toLowerCase() === title.toLowerCase()) {
    content = content.slice(firstNewline + 1).trimStart();
  }
  content = content.replace(/^(?:-\s*\n|#+\s*\n)+/, "");
  return content;
}

/** Feed excerpt for a release: the AI summary when present (unique first-party
 *  text), else a capped prose excerpt of the body. Images, a leading title
 *  duplicate, and markdown syntax are stripped before the cut so a hero image
 *  never leaks as `![…](`. Never returns the full body past the cap — that
 *  lives only on the self-canonical /release/{id}. */
export function releaseExcerpt(release: {
  content?: string | null;
  summary?: string | null;
  title?: string | null;
}): string {
  const summary = (release.summary ?? "").trim();
  if (summary) return summary;
  return proseExcerpt(release.content, { title: release.title, maxChars: EXCERPT_MAX_CHARS });
}
