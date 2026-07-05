/**
 * Resolve `{ url, quote }` overview citations (emitted alongside the body by the
 * AI SDK structured-output lane) into body-offset `{ startIndex, endIndex, ... }`
 * citations, matching the `RegenerateOverviewBodySchema.citations` wire format:
 *   { startIndex, endIndex, sourceUrl, title, citedText }
 *
 * `resolveOverviewCitations` does the offset resolution (see its own doc
 * comment); `clampCitationsToBody` is the defensive guard applied before
 * upsert.
 */

import { stripLeadingHeading } from "@buildinternet/releases-core/overview";

export interface OverviewCitation {
  startIndex: number;
  endIndex: number;
  sourceUrl: string;
  title: string | null;
  citedText: string;
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

/** A structured citation as returned by the model: a source URL + a verbatim body phrase. */
export interface RawOverviewCitation {
  url: string;
  quote: string;
}

/**
 * Strip a trailing `Citations:` / `Sources:` section the model sometimes appends
 * to the body field despite the prompt forbidding it (observed with DeepSeek). It
 * belongs in the structured citation array, not the rendered body. Anchored to
 * EOF and gated on a bare `Citations:`/`Sources:` label at the start of a line, so
 * it can't eat prose (an overview body never legitimately ends with such a block).
 */
const TRAILING_CITATIONS_RE = /\n+[ \t]*(?:citations?|sources?)\s*:[\s\S]*$/i;

/** True when [start,end) contains an odd number of `**` markers (would split a bold span). */
function crossesBoldBoundary(body: string, start: number, end: number): boolean {
  const span = body.slice(start, end);
  return ((span.match(/\*\*/g) ?? []).length & 1) === 1;
}

/**
 * Resolve structured `{ url, quote }` citations (from an AI SDK `generateObject`
 * response) into body-offset citations. The body and the citation list arrive as
 * separate typed fields — no fenced JSON block scraped out of prose — so there is
 * no transport parsing here, only offset resolution:
 *
 *   - normalize the body (HTML-entity decode + strip a stray leading heading),
 *   - for each citation, keep it only if its url is a provided source, its quote
 *     appears verbatim in the body, and the span doesn't split a `**` bold run,
 *   - clamp the resulting offsets into the body.
 *
 * Unknown urls / quotes-not-found are dropped (citation fidelity is advisory);
 * an empty list yields an empty citation set. Never throws.
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
  for (const { url, quote } of rawCitations) {
    if (typeof url !== "string" || typeof quote !== "string") continue;
    if (!input.validSources.has(url)) continue;
    const needle = decodeHtmlEntities(quote).trim();
    if (needle.length === 0) continue;
    const startIndex = body.indexOf(needle);
    if (startIndex === -1) continue;
    const endIndex = startIndex + needle.length;
    if (crossesBoldBoundary(body, startIndex, endIndex)) continue;
    citations.push({
      startIndex,
      endIndex,
      sourceUrl: url,
      title: input.titleBySource.get(url) ?? null,
      citedText: needle,
    });
  }
  return { body, citations: clampCitationsToBody(body, citations) };
}

/**
 * Drop citations whose offsets fall outside `body`. Defensive guard before
 * upsert — the API rejects `bad_citations` with 400, so trimming here lets
 * the workflow persist what's valid instead of failing the whole row when
 * one citation drifted (e.g. body was further normalized after extraction).
 */
export function clampCitationsToBody(
  body: string,
  citations: OverviewCitation[],
): OverviewCitation[] {
  const max = body.length;
  return citations
    .map((c) => ({
      ...c,
      startIndex: Math.max(0, Math.min(c.startIndex, max)),
      endIndex: Math.max(0, Math.min(c.endIndex, max)),
    }))
    .filter((c) => c.endIndex > c.startIndex);
}
