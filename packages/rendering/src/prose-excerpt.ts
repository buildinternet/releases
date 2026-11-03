/**
 * Plain-text excerpt of a release body for list cards, API `summary` fallbacks,
 * OG descriptions, and MCP previews.
 *
 * Those surfaces used to slice the raw markdown. A post that opens with a
 * heading and a hero image then shows `![Title](https://…` (the slice cuts the
 * image syntax) or nothing (the slice is only the image, and the card renderer
 * drops images). Strip images and a leading title duplicate first, then take
 * the first prose paragraph and flatten the markdown.
 */

import { stripMarkdown } from "./strip-markdown";

/** Card / API preview cap. OG and MCP pass their own. */
export const PROSE_EXCERPT_MAX = 280;

const MD_IMAGE = /!\[[^\]]*\]\((?:[^()]|\([^)]*\))*\)/g;
const MD_IMAGE_REF = /!\[[^\]]*\]\[[^\]]*\]/g;
const HTML_IMG = /<img\b[^>]*>/gi;
const LIST_MARKER = /^[ \t]*([-*+]|\d+[.)])[ \t]+/gm;

function stripImages(content: string): string {
  return content.replace(MD_IMAGE, " ").replace(MD_IMAGE_REF, " ").replace(HTML_IMG, " ");
}

/** Drop a leading line that repeats the release title (with or without a heading marker). */
function stripLeadingDuplicateTitle(content: string, title: string | null | undefined): string {
  const wanted = (title ?? "").trim().toLowerCase();
  if (!wanted) return content;
  const rest = content.replace(/^(?:[ \t]*\n)+/, "");
  const nl = rest.indexOf("\n");
  const first = (nl === -1 ? rest : rest.slice(0, nl)).replace(/^#{1,6}[ \t]*/, "").trim();
  if (first.toLowerCase() !== wanted) return content;
  return nl === -1 ? "" : rest.slice(nl + 1);
}

const PARAGRAPH_BREAK_RE = /\n{2,}/;
const HEADING_ONLY_RE = /^#{1,6}\s+\S[^\n]*$/;

/** First paragraph that is actually prose — skip a heading-only line like `### Features`. */
function firstProseParagraph(body: string): string {
  const paragraphs = body
    .split(PARAGRAPH_BREAK_RE)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const para of paragraphs) {
    if (HEADING_ONLY_RE.test(para)) continue;
    if (stripMarkdown(para.replace(LIST_MARKER, ""))) return para;
  }
  return "";
}

function truncateProse(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(1, maxChars - 1);
  const capped = text.slice(0, budget);
  const lastSpace = capped.lastIndexOf(" ");
  const cut = lastSpace > budget * 0.6 ? capped.slice(0, lastSpace) : capped;
  return `${cut.trimEnd()}…`;
}

/**
 * Readable preview of `content`. Empty when the body has no prose (image-only,
 * or a heading that only repeats `title`).
 */
export function proseExcerpt(
  content: string | null | undefined,
  opts?: { title?: string | null; maxChars?: number },
): string {
  if (!content) return "";
  const maxChars = opts?.maxChars ?? PROSE_EXCERPT_MAX;
  const prepared = stripLeadingDuplicateTitle(stripImages(content), opts?.title).trim();
  if (!prepared) return "";
  const para = firstProseParagraph(prepared);
  if (!para) return "";
  return truncateProse(stripMarkdown(para.replace(LIST_MARKER, "")), maxChars);
}

/**
 * Wire `summary` for list responses: the stored AI summary when present,
 * otherwise a prose excerpt of the body. Never a raw markdown slice.
 */
export function displaySummary(
  summary: string | null | undefined,
  content: string | null | undefined,
  title?: string | null,
  maxChars: number = PROSE_EXCERPT_MAX,
): string {
  const stored = (summary ?? "").trim();
  if (stored) return stored;
  return proseExcerpt(content, { title, maxChars });
}
