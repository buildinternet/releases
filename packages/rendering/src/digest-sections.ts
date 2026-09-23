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

/**
 * Stateful heading→anchor slugger. A digest body can repeat a heading (e.g.
 * two "Bug fixes" sections); using the plain `digestSectionAnchor()` for both
 * produces duplicate DOM ids, so anchor links mis-target the first match.
 * Call once per render and reuse the returned function across every heading
 * in that body: the first occurrence of a given slug gets the plain slug,
 * repeats get `-2`, `-3`, … suffixes.
 */
export function createDigestAnchorSlugger(): (heading: string) => string {
  const seen = new Map<string, number>();
  return (heading: string) => {
    const base = digestSectionAnchor(heading);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };
}

// Private-Use-Area sentinel (not a control character, won't appear in real
// markdown) marking a code span's position while emphasis stripping runs.
const CODE_SPAN_PLACEHOLDER = "";

/**
 * Strips inline markdown down to its display text, matching how rehype
 * flattens a rendered heading/paragraph to plain text (`hastText` in
 * web/src/lib/render-digest-body.ts): images drop, links keep only their
 * text, code spans keep only their content, emphasis markers drop.
 *
 * Code span contents are swapped for placeholders *before* emphasis is
 * stripped, then restored afterward — otherwise two separate code spans each
 * containing one `_` (e.g. "the `max_tokens` and `top_p` params") look like a
 * single underscore-emphasis run spanning both, and the regex eats the text
 * between them (`max_tokens` / `top_p` → `maxtokens` / `topp`).
 */
function stripInlineMarkdown(s: string): string {
  const codeSpans: string[] = [];
  const withPlaceholders = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, (_m, inner: string) => {
      codeSpans.push(inner);
      return `${CODE_SPAN_PLACEHOLDER}${codeSpans.length - 1}${CODE_SPAN_PLACEHOLDER}`;
    });
  const withoutEmphasis = withPlaceholders
    // `*`/`**` — any pair, as before.
    .replace(/(\*\*|\*)(.+?)\1/g, "$2")
    // `_`/`__` — only at non-word boundaries, so identifiers like
    // `max_tokens` (a single underscore inside a word) never match.
    .replace(/(^|\W)(__?)(\S.*?\S|\S)\2(?=\W|$)/g, "$1$3");
  return withoutEmphasis
    .replace(
      new RegExp(`${CODE_SPAN_PLACEHOLDER}(\\d+)${CODE_SPAN_PLACEHOLDER}`, "g"),
      (_m, i: string) => codeSpans[Number(i)] ?? "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(paragraph: string): string {
  const text = stripInlineMarkdown(paragraph);
  const m = /^(.+?[.!?])(?=\s+[A-Z0-9"“(]|$)/.exec(text);
  return (m ? m[1] : text).trim();
}

export function parseDigestSections(body: string): ParsedDigestSection[] {
  // CommonMark allows up to 3 leading spaces before an ATX heading marker.
  const parts = body.split(/^ {0,3}###[ \t]+/m).slice(1);
  const slugger = createDigestAnchorSlugger();
  return parts.map((part) => {
    const nl = part.indexOf("\n");
    const rawHeading = (nl === -1 ? part : part.slice(0, nl)).trim();
    // Display text and the anchor's slug source are the same stripped
    // heading: it's what rehype's `hastText` produces for the rendered
    // heading, so slugging it here matches the DOM id the page assigns.
    const heading = stripInlineMarkdown(rawHeading);
    const rest = nl === -1 ? "" : part.slice(nl + 1);
    const firstPara = rest.trim().split(/\n\s*\n/)[0] ?? "";
    const releaseIds: string[] = [];
    for (const m of rest.matchAll(RELEASE_LINK_RE)) {
      if (!releaseIds.includes(m[1])) releaseIds.push(m[1]);
    }
    return {
      heading,
      anchor: slugger(heading),
      lede: firstPara ? firstSentence(firstPara) : "",
      releaseIds,
    };
  });
}

/** True when the trimmed string is an http(s) URL. */
export function isHttpUrl(s: string | null | undefined): boolean {
  return /^https?:\/\//i.test((s ?? "").trim());
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
    return isHttpUrl(url) ? `](${url})` : match;
  });
}
