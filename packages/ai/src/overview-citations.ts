/**
 * Extract `{ body, citations }` from an Anthropic overview-generation response.
 *
 * Implements the running-offset algorithm from
 * `src/agent/skills/regenerating-overviews/SKILL.md` lines 154-170.
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

/**
 * Walk the assistant response, concatenate text blocks, and surface citations
 * pinned to character spans in the final body string.
 *
 * Non-text blocks (tool use, etc.) are skipped. The overview prompt never
 * issues tools, but defending against the shape is cheap.
 */
export function extractOverviewBody(message: Anthropic.Message): OverviewExtraction {
  let runningOffset = 0;
  let rawBody = "";
  const rawCitations: OverviewCitation[] = [];

  for (const block of message.content) {
    if (block.type !== "text") continue;
    const text = block.text;
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
