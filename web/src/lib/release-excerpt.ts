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
 *  text), else a capped slice of the verbatim body. Never returns the full body
 *  past the cap — that lives only on the self-canonical /release/{id}. */
export function releaseExcerpt(release: {
  content?: string | null;
  summary?: string | null;
  title?: string | null;
}): string {
  const summary = (release.summary ?? "").trim();
  if (summary) return summary;

  const body = stripLeadingTitle((release.content ?? "").trim(), release.title ?? null).trim();
  if (body.length <= EXCERPT_MAX_CHARS) return body;

  const capped = body.slice(0, EXCERPT_MAX_CHARS);
  const paraBreak = capped.indexOf("\n\n");
  if (paraBreak > 0) return capped.slice(0, paraBreak).trim();
  const lastSpace = capped.lastIndexOf(" ");
  return (lastSpace > 0 ? capped.slice(0, lastSpace) : capped).trimEnd() + "…";
}
