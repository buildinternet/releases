/**
 * Extract `{ body, citations }` from an Anthropic overview-generation response.
 *
 * Implements the running-offset algorithm from
 * `.claude/skills/regenerating-overviews/SKILL.md` lines 154-170.
 *
 * The shape mirrors the `RegenerateOverviewBodySchema.citations` wire format:
 *   { startIndex, endIndex, sourceUrl, title, citedText }
 *
 * Notes on Anthropic's citation semantics:
 *   - Citations are emitted at *text-block* granularity. Every citation on a
 *     given block covers the whole block's text. There is no sub-string offset.
 *   - `start_block_index` / `end_block_index` on each citation refer to slices
 *     of the SOURCE search_result's content array, NOT offsets into the
 *     assistant's response. Don't try to use them as response offsets.
 *   - When the model emits a leading markdown heading despite the prompt, we
 *     strip it from the body BEFORE writing offsets and shift each citation
 *     by the stripped length. Citations entirely inside the stripped region
 *     are dropped; partial overlaps clamp `startIndex` to 0.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { stripLeadingHeading } from "@buildinternet/releases-core/overview";

export interface OverviewCitation {
  startIndex: number;
  endIndex: number;
  sourceUrl: string;
  title: string | null;
  citedText: string;
}

export interface OverviewExtraction {
  /** Final body, with any leading markdown heading stripped. */
  body: string;
  /** Citations with offsets relative to `body`. */
  citations: OverviewCitation[];
  /** True when a leading heading was stripped. */
  strippedHeading: boolean;
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

/**
 * Walk the assistant response, concatenate text blocks, and surface citations
 * pinned to character spans in the final body string.
 *
 * Non-text blocks (tool use, etc.) are skipped. The overview prompt never
 * issues tools, but defending against the shape is cheap.
 *
 * Each block's text is HTML-entity-decoded BEFORE its offsets are measured.
 * Citations are whole-block spans (`runningOffset` → `runningOffset + len`), so
 * decoding after accumulation would shrink the body and silently misalign every
 * downstream citation. Decoding per block keeps the running offset and the body
 * in lockstep. Idempotent on clean bodies (see `decodeHtmlEntities`).
 */
export function extractOverviewBody(message: Anthropic.Message): OverviewExtraction {
  let runningOffset = 0;
  let rawBody = "";
  const rawCitations: OverviewCitation[] = [];

  for (const block of message.content) {
    if (block.type !== "text") continue;
    const text = decodeHtmlEntities(block.text);
    rawBody += text;

    const citations = block.citations ?? [];
    for (const cit of citations) {
      // Only search_result_location citations are expected for overviews.
      // Other citation kinds (web_search_result_location, etc.) carry
      // different shapes; ignore them rather than guess.
      if (cit.type !== "search_result_location") continue;
      rawCitations.push({
        startIndex: runningOffset,
        endIndex: runningOffset + text.length,
        sourceUrl: cit.source ?? "",
        title: cit.title ?? null,
        citedText: cit.cited_text ?? "",
      });
    }

    runningOffset += text.length;
  }

  // Defer to core's stripLeadingHeading so the regex stays in one place
  // (overviewPreview uses the same strip on read paths).
  const body = stripLeadingHeading(rawBody);
  const strippedLength = rawBody.length - body.length;
  if (strippedLength === 0) {
    return { body: rawBody, citations: rawCitations, strippedHeading: false };
  }

  const citations: OverviewCitation[] = [];
  for (const cit of rawCitations) {
    const shiftedEnd = cit.endIndex - strippedLength;
    if (shiftedEnd <= 0) continue;
    const shiftedStart = Math.max(0, cit.startIndex - strippedLength);
    citations.push({ ...cit, startIndex: shiftedStart, endIndex: shiftedEnd });
  }

  return { body, citations, strippedHeading: true };
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
  const body = stripLeadingHeading(decodeHtmlEntities(rawBody).trim());

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
