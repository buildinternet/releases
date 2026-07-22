/**
 * Markdown → plain text, and markdown → inline HTML.
 *
 * Release titles and summaries are markdown source: they reach us from changelog
 * bodies and from the AI summarization lane, and they routinely carry `**bold**`,
 * backticked identifiers, and `[links](…)`. Anywhere that content is placed into
 * a non-markdown surface it has to be converted, not escaped verbatim — a digest
 * email that HTML-escapes a summary renders the asterisks to the reader.
 *
 * Two conversions, deliberately kept apart:
 *   - `stripMarkdown`  → prose with the syntax removed (plain-text email part,
 *     OG images, anywhere with no rich rendering).
 *   - `inlineMarkdownToHtml` → escaped HTML with the INLINE constructs promoted
 *     to tags. Block syntax (headings, quotes, fences, list bullets) is still
 *     flattened: these surfaces render one-liners, not documents.
 */

/**
 * Drop markdown syntax, keeping the prose. Collapses to a single line.
 *
 * The two non-obvious rules, both learned from real changelog content (#2096):
 * inline code is UNWRAPPED to its contents rather than deleted (deleting turned
 * "(`none`/`minor`/`major`)" into "( / / )"), and `_` is left alone because in
 * changelog prose it is far more often an identifier character (`whats_changed`)
 * than an emphasis marker.
 */
export function stripMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  return (
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Heading/blockquote markers are only markers at the start of a line.
      .replace(/^[ \t]*[#>]+[ \t]*/gm, "")
      .replace(/[*~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Only http(s) survives into an `href` — `javascript:`/`data:` are dropped. */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? escapeHtml(trimmed) : null;
}

const SENTINEL = "\u0000";

export type InlineMarkdownStyles = {
  /** Inline style applied to `<code>` (email needs styles inline, not in a sheet). */
  code?: string;
  /** Inline style applied to `<a>`. */
  link?: string;
};

/**
 * Render the inline subset of markdown to HTML, escaping everything else.
 *
 * Handled: fenced/inline code, images (dropped), links, `**strong**`, `*em*`,
 * `~~strike~~`. Block markers are flattened to a single line, matching
 * `stripMarkdown`'s output shape — the two functions must agree on what the
 * reader sees, since they render the same string into the HTML and text parts
 * of the same email.
 *
 * Code spans are extracted to placeholders BEFORE emphasis runs, so a
 * backticked `**kwargs` or `a * b` isn't mangled into tags.
 */
export function inlineMarkdownToHtml(
  text: string | null | undefined,
  styles: InlineMarkdownStyles = {},
): string {
  if (!text) return "";
  const codeAttr = styles.code ? ` style="${styles.code}"` : "";
  const linkAttr = styles.link ? ` style="${styles.link}"` : "";

  const codeSpans: string[] = [];
  // NUL-delimited: it cannot occur in changelog text, so a code span parked as
  // a placeholder can never collide with real prose (a bare numeric marker would
  // have re-captured any standalone number in the sentence).
  const stash = (content: string): string => {
    codeSpans.push(content);
    return `${SENTINEL}${codeSpans.length - 1}${SENTINEL}`;
  };

  let out = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, (_m, code: string) => stash(code))
    .replace(/\s+/g, " ")
    // Leading heading/quote markers are stripped BEFORE escaping: afterwards a
    // `>` is the five characters `&gt;` and no longer matchable as a marker.
    .replace(/^[#>]+\s*/, "")
    .trim();

  out = escapeHtml(out)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (whole, label: string, url: string) => {
      const href = safeHref(url.replace(/&amp;/g, "&"));
      return href ? `<a href="${href}"${linkAttr}>${label}</a>` : whole;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    // Any asterisk left over was unpaired syntax (a stray bullet), not content.
    .replace(/[*~]/g, "");

  return out
    .replace(
      new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
      (_m, i: string) => `<code${codeAttr}>${escapeHtml(codeSpans[Number(i)])}</code>`,
    )
    .replace(/\s+/g, " ")
    .trim();
}
