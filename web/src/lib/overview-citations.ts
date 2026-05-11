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

  // Number them in reading order and stash the marker positions.
  const numbered = shifted.map((c, i) => ({
    citation: c,
    number: i + 1,
    label: footnoteLabel(pageId, i + 1),
  }));

  // Every citation may have been dropped by the heading-strip clamp. In that
  // case skip the marker injection and footnote block — appending an empty
  // defs string would leave dangling blank lines at the bottom.
  if (numbered.length === 0) {
    return { content: stripped.content, rendered: [] };
  }

  // Insert markers from rightmost endIndex backwards so earlier offsets
  // don't shift as we splice strings.
  const byInsertOrder = numbered.toSorted((a, b) => b.citation.endIndex - a.citation.endIndex);

  let body = stripped.content;
  for (const { citation, label } of byInsertOrder) {
    const at = citation.endIndex;
    body = body.slice(0, at) + `[^${label}]` + body.slice(at);
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
