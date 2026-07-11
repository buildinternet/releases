import { stripMarkdown } from "@/lib/og-helpers";

/**
 * Redundancy guard for the release-detail summary lede (#1606 Phase C): a
 * summary is only worth leading with when the verbatim body actually says
 * more than it does. When the body is short relative to the summary — e.g.
 * a one-line changelog entry the model expanded into a full sentence — the
 * lede reads as filler restating the body, so the page should render as it
 * does today (body only, no lede/divider).
 *
 * Compares stripped-markdown lengths so formatting characters (`#`, `` ` ``,
 * link syntax) don't skew the ratio.
 */
export function shouldShowSummaryLede(
  summary: string | null | undefined,
  body: string | null | undefined,
): boolean {
  const trimmedSummary = (summary ?? "").trim();
  if (!trimmedSummary) return false;
  const trimmedBody = (body ?? "").trim();
  if (!trimmedBody) return false;
  const strippedSummaryLen = stripMarkdown(trimmedSummary).length;
  const strippedBodyLen = stripMarkdown(trimmedBody).length;
  if (strippedSummaryLen === 0) return false;
  return strippedBodyLen >= strippedSummaryLen * 1.5;
}
