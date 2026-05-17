import type { OverviewCitation } from "@buildinternet/releases-api-types";

/**
 * Strip a stray leading markdown heading and return the byte length removed.
 *
 * Citations are character offsets into the raw stored content. The web
 * already strips a leading `# Heading` line so the org page header isn't
 * doubled — when we do that, every citation offset has to slide left by the
 * same amount, and any citation that fell inside the stripped region has to
 * be dropped or clamped.
 */
function stripLeadingHeadingWithOffset(content: string): { content: string; offset: number } {
  const match = content.match(/^\s*#{1,6}\s+[^\n]+\n+/);
  if (!match) return { content, offset: 0 };
  return { content: content.slice(match[0].length), offset: match[0].length };
}

interface ShiftedCitation extends OverviewCitation {
  /** Index in the original `citations` array — used to derive a stable label. */
  index: number;
}

function shiftAndClamp(
  citations: readonly OverviewCitation[],
  offset: number,
  contentLength: number,
): ShiftedCitation[] {
  const out: ShiftedCitation[] = [];
  for (let i = 0; i < citations.length; i++) {
    const c = citations[i]!;
    const shiftedEnd = c.endIndex - offset;
    if (shiftedEnd <= 0) continue; // entire span was inside the stripped heading
    const shiftedStart = Math.max(0, c.startIndex - offset);
    out.push({
      ...c,
      startIndex: Math.min(shiftedStart, contentLength),
      endIndex: Math.min(shiftedEnd, contentLength),
      index: i,
    });
  }
  return out;
}

// Closing markdown / punctuation we want to step past when deciding where a
// sentence really ends, so a marker lands after `**bold.**` rather than
// inside the bold span as `bold.[^1]**`.
const TRAILING_FORMATTING = /[)\]"'`*_]/;
const WHITESPACE = /\s/;
const SENTENCE_TERMINATORS = new Set([".", "!", "?"]);

/**
 * True when the character at `pos` is a sentence terminator we want to snap
 * to — i.e., a `.`, `!`, or `?` followed by whitespace, end of content, or
 * closing markdown punctuation. This excludes mid-token periods like `v2.0`
 * or `e.g.` (in `e.g.`, the first `.` is followed by `g`, not whitespace).
 */
function isSentenceTerminator(content: string, pos: number): boolean {
  const ch = content[pos];
  if (ch === undefined || !SENTENCE_TERMINATORS.has(ch)) return false;
  const next = content[pos + 1];
  if (next === undefined) return true;
  return WHITESPACE.test(next) || TRAILING_FORMATTING.test(next);
}

/**
 * True when `pos` already sits at a natural pause point in the prose —
 * immediately after a sentence terminator (and any trailing markdown
 * markers), or right at a line break. End-of-content counts. Position 0 and
 * positions immediately following a `\n` (the start of a new line/paragraph)
 * do NOT count: a marker there reads as belonging to the next sentence
 * rather than ending the previous one.
 */
function isAtSentenceBoundary(content: string, pos: number): boolean {
  if (pos >= content.length) return true;
  if (pos === 0) return false;
  // If the next char is a newline we're already sitting at end-of-line,
  // which is a fine place to anchor.
  if (content[pos] === "\n") return true;
  // Otherwise look back past any closing markdown to find what came before.
  let i = pos - 1;
  while (i >= 0 && TRAILING_FORMATTING.test(content[i]!)) i--;
  if (i < 0) return false;
  return isSentenceTerminator(content, i);
}

/**
 * Move `startAt` forward to the next natural pause point (end of sentence
 * or end of line) so superscript markers never split words or appear at the
 * start of a sentence. If `startAt` is already at a boundary the position
 * is returned unchanged; if no terminator is found before end of content we
 * fall back to the content length.
 */
function snapToSentenceEnd(content: string, startAt: number): number {
  const len = content.length;
  if (startAt >= len) return len;
  if (isAtSentenceBoundary(content, startAt)) return startAt;
  for (let i = startAt; i < len; i++) {
    const ch = content[i]!;
    if (ch === "\n") return i;
    if (isSentenceTerminator(content, i)) {
      let j = i + 1;
      while (j < len && TRAILING_FORMATTING.test(content[j]!)) j++;
      return j;
    }
  }
  return len;
}

/**
 * Build a stable footnote label from a page id + 1-based citation number.
 * GFM footnote labels are visible in the rendered DOM ID
 * (`user-content-fn-<label>`) so they need to be unique per page render.
 */
function footnoteLabel(pageId: string, n: number): string {
  // Restrict to ascii-safe chars; remark-gfm tolerates more but we want
  // predictable HTML ids.
  const safePage = pageId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return safePage ? `${safePage}-${n}` : `cite-${n}`;
}

/**
 * Render a footnote-definition target. Prefer the citation's own title;
 * fall back to a hostname-shaped label so the Sources footer never reads
 * "[undefined](https://…)".
 */
export function definitionLabel(c: OverviewCitation): string {
  if (c.title && c.title.trim()) return c.title.trim();
  if (!URL.canParse(c.sourceUrl)) return c.sourceUrl;
  const u = new URL(c.sourceUrl);
  return u.hostname + u.pathname;
}

export interface ApplyCitationsResult {
  content: string;
  /** 1-based citation order in the rendered output. Empty when no citations. */
  rendered: Array<{ label: string; number: number; citation: OverviewCitation }>;
}

/**
 * Augment overview markdown with GFM footnote markers + a footnotes section
 * so each cited claim renders as a superscript anchor that jumps to the
 * source URL in a "Sources" list at the bottom of the body.
 *
 * Markers are inserted from the end of the document backwards so earlier
 * offsets stay valid. Empty `citations` returns the heading-stripped content
 * unchanged — the existing `stripLeadingH1` behavior pre-citations.
 */
export function applyCitationMarkers(
  rawContent: string,
  citations: readonly OverviewCitation[] | undefined | null,
  pageId: string,
): ApplyCitationsResult {
  const stripped = stripLeadingHeadingWithOffset(rawContent);
  const list = citations ?? [];
  if (list.length === 0) {
    return { content: stripped.content, rendered: [] };
  }

  // Sort by start ascending so display numbering reads left-to-right; ties
  // broken by end so a longer span covers the shorter one in the same spot.
  const shifted = shiftAndClamp(list, stripped.offset, stripped.content.length).toSorted(
    (a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex,
  );

  // Number in reading order and snap each marker forward to the next
  // sentence end / line break so the superscript never lands mid-word or at
  // the very start of a paragraph. Multiple citations that snap to the same
  // pause point cluster as adjacent markers (e.g., `claim.[^1][^2]`).
  const numbered = shifted.map((c, i) => ({
    citation: c,
    number: i + 1,
    label: footnoteLabel(pageId, i + 1),
    insertAt: snapToSentenceEnd(stripped.content, c.endIndex),
  }));

  // Every citation may have been dropped by the heading-strip clamp. In that
  // case skip the marker injection and footnote block — appending an empty
  // defs string would leave dangling blank lines at the bottom.
  if (numbered.length === 0) {
    return { content: stripped.content, rendered: [] };
  }

  // Insert from rightmost position backwards so earlier offsets stay valid.
  // For ties (citations that snap to the same position), insert higher
  // numbers first so each splice pushes prior markers right, yielding the
  // final reading order `[1][2][3]` rather than `[3][2][1]`.
  const byInsertOrder = numbered.toSorted((a, b) => b.insertAt - a.insertAt || b.number - a.number);

  let body = stripped.content;
  for (const { insertAt, label } of byInsertOrder) {
    body = body.slice(0, insertAt) + `[^${label}]` + body.slice(insertAt);
  }

  // Append definitions in display order. GFM accepts a [Label](URL) inside a
  // footnote body; that gives us a clickable link in the Sources section.
  const defs = numbered
    .map(
      ({ label, citation }) => `[^${label}]: [${definitionLabel(citation)}](${citation.sourceUrl})`,
    )
    .join("\n");

  return {
    content: `${body}\n\n${defs}\n`,
    rendered: numbered,
  };
}
