/**
 * Resolve the `{ url }` source citations the overview model returns (alongside
 * the body) into stored citation rows: `{ sourceUrl, title }` — deduped and
 * filtered to the sources the model was actually given.
 *
 * Overview citations are a *source list*, not span-anchored provenance (#1934).
 * An org overview is durable, publicly-cached editorial content whose sources
 * are destinations to click, not claims to fact-check against a highlighted
 * body span. So there is no verbatim-quote matching and no body char offsets —
 * that contract (reproduce an exact substring of your own, lint-rewritten
 * prose) failed twice on the same seam: it leaked raw JSON into the body
 * (#1927/#1929) and silently dropped the large majority of citations when the
 * quotes didn't match. Dropping it deletes that entire failure class.
 */

import { stripLeadingHeading } from "@buildinternet/releases-core/overview";

export interface OverviewCitation {
  sourceUrl: string;
  title: string | null;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * Single-pass decode of the five entities models reflexively over-escape when
 * emitting markdown (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`) — `Q&amp;A`,
 * `streams.input&lt;T&gt;`. Single-pass so `&amp;lt;` decodes to `&lt;` (one
 * level), not `<`, which makes it idempotent on already-clean bodies.
 *
 * Mirrors `unescapeHtmlEntities` in releases-cli (#229) so the agent-driven
 * regen path and the batch auto-regen path normalize overview bodies
 * identically. The store (`POST /v1/orgs/:slug/overview`) stays verbatim — this
 * is a client-of-the-store concern.
 */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => HTML_ENTITY_MAP[m] ?? m);
}

export interface PostHocExtraction {
  body: string;
  citations: OverviewCitation[];
}

export interface PostHocResolveInput {
  /** Valid citation sources: each release's `url ?? `release://<id>``. */
  validSources: Set<string>;
  /** Display title per source, for the citation `title` field. */
  titleBySource: Map<string, string | null>;
}

/** A structured citation as returned by the model: a source URL it drew on. */
export interface RawOverviewCitation {
  url: string;
}

/**
 * Strip a trailing `Citations:` / `Sources:` section the model sometimes appends
 * to the body field despite the prompt forbidding it (observed with DeepSeek). It
 * belongs in the structured citation array, not the rendered body. Anchored to
 * EOF and gated on a bare `Citations:`/`Sources:` label at the start of a line, so
 * it can't eat prose (an overview body never legitimately ends with such a block).
 */
const TRAILING_CITATIONS_RE = /\n+[ \t]*(?:citations?|sources?)\s*:[\s\S]*$/i;

/**
 * Normalize the model's overview body and resolve its `{ url }` citations into
 * stored `{ sourceUrl, title }` rows. Body and citations arrive as separate
 * typed fields (AI SDK `generateObject`), so there is no transport parsing —
 * only:
 *
 *   - normalize the body (HTML-entity decode, strip a stray leading heading and
 *     any trailing `Citations:`/`Sources:` block the model appended anyway),
 *   - keep each citation whose url is one of the provided sources, deduped.
 *
 * Unknown urls are dropped; an empty list yields an empty citation set. Never
 * throws. No offsets, no verbatim-quote matching — see the file header.
 */
export function resolveOverviewCitations(
  rawBody: string,
  rawCitations: readonly RawOverviewCitation[],
  input: PostHocResolveInput,
): PostHocExtraction {
  const body = stripLeadingHeading(decodeHtmlEntities(rawBody).trim())
    .replace(TRAILING_CITATIONS_RE, "")
    .trimEnd();

  const citations: OverviewCitation[] = [];
  const seen = new Set<string>();
  for (const { url } of rawCitations) {
    if (typeof url !== "string") continue;
    if (!input.validSources.has(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    citations.push({ sourceUrl: url, title: input.titleBySource.get(url) ?? null });
  }
  return { body, citations };
}
