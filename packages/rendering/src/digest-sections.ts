/**
 * Pure helpers over a weekly-digest markdown body (`### Heading` sections whose
 * cited releases are markdown links to `/release/rel_<id>[-slug]`). Shared by
 * the API (wire `sections`) and web (heading anchors, upstream link rewrite) so
 * the anchor a section row links to always matches the id the page renders.
 */

/** `rel_` + 21 nanoid chars, optionally followed by `-slug`. Capture = id. */
const RELEASE_LINK_RE = /\/release\/(rel_[A-Za-z0-9_-]{21})(?:-[^)\s]*)?/g;
/** A whole markdown link whose target is a release path. */
const RELEASE_MD_LINK_RE = /\]\(\/release\/(rel_[A-Za-z0-9_-]{21})(?:-[^)\s]*)?\)/g;

export interface ParsedDigestSection {
  heading: string;
  anchor: string;
  /** First sentence of the section's first paragraph, markdown stripped. */
  lede: string;
  /** Unique cited release ids, first-seen order. */
  releaseIds: string[];
}

export function digestSectionAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(paragraph: string): string {
  const text = stripInlineMarkdown(paragraph);
  const m = /^(.+?[.!?])(?=\s+[A-Z0-9"“(]|$)/.exec(text);
  return (m ? m[1] : text).trim();
}

export function parseDigestSections(body: string): ParsedDigestSection[] {
  const parts = body.split(/^###[ \t]+/m).slice(1);
  return parts.map((part) => {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const rest = nl === -1 ? "" : part.slice(nl + 1);
    const firstPara = rest.trim().split(/\n\s*\n/)[0] ?? "";
    const releaseIds: string[] = [];
    for (const m of rest.matchAll(RELEASE_LINK_RE)) {
      if (!releaseIds.includes(m[1])) releaseIds.push(m[1]);
    }
    return {
      heading,
      anchor: digestSectionAnchor(heading),
      lede: firstPara ? firstSentence(firstPara) : "",
      releaseIds,
    };
  });
}

/** The `rel_…` id from an on-site release path (`/release/rel_<id>[-slug]`), else null. */
export function releaseIdFromPath(href: string): string | null {
  const m = /^\/release\/(rel_[A-Za-z0-9_-]{21})(?:-[^/?#\s]*)?(?:[?#].*)?$/.exec(href.trim());
  return m ? m[1] : null;
}

/** Replace `](/release/rel_…)` link targets with the release's upstream url
 *  when it has an http(s) one; otherwise leave the internal fallback. Mirrors
 *  `releaseLinkTarget()` in web/src/lib/release-link.ts. */
export function rewriteDigestReleaseLinks(
  body: string,
  urlById: ReadonlyMap<string, string | null | undefined>,
): string {
  return body.replace(RELEASE_MD_LINK_RE, (match, id: string) => {
    const url = (urlById.get(id) ?? "").trim();
    return /^https?:\/\//i.test(url) ? `](${url})` : match;
  });
}
