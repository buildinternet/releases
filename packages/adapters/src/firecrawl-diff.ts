/**
 * Reduce a Firecrawl `monitor.page` `diff.text` (a git-style unified diff) to
 * just the *added* content: the post-change lines inside each hunk (the unified
 * format prefixes them with `+`), with that prefix stripped.
 *
 * Classification is by position, not by a prefix heuristic: everything before
 * the first `@@` hunk header (the `--- `/`+++ ` file headers and any preamble)
 * is skipped, and inside a hunk a leading `+` unambiguously marks an added line.
 * That preserves added content whose body itself begins with `+`/`-` — e.g. a
 * line like `++ note`, which renders as `+++ note` in the diff and a
 * prefix-only check would mistake for a `+++` file header.
 *
 * For an append-only changelog the added lines are a self-contained new entry
 * (its date/version header is itself new, so it appears as `+` lines), which is
 * exactly what we want to extract — small, verbatim, and bounded to the change
 * rather than the whole page. We deliberately exclude unified-diff context
 * lines: the default 3-line window cuts neighboring entries mid-way, and feeding
 * a partial entry to extraction risks inserting a malformed release.
 *
 * We parse `diff.text` (the stable unified-diff contract) rather than the
 * `diff.json` AST the webhook also carries — Firecrawl doesn't pin that AST's
 * shape, and in practice it has arrived empty (`{ files: [] }`), so the text
 * format is the only thing to depend on. Assumes a single-file diff (true for
 * the scrape-target monitors that feed this).
 *
 * Two diff shapes are handled. Firecrawl's published example is a textbook
 * unified diff with `@@` hunk headers, but the *live* `monitor.page` webhook
 * instead sends a HUNKLESS whole-document diff: no `@@` headers and no `---`/
 * `+++` file headers, just every page line prefixed with a space (context),
 * `+` (added) or `-` (removed). When no `@@` header is present the entire body
 * is treated as one implicit hunk; the file-header skip only matters for the
 * `@@`-bearing variant, where a preamble actually exists. (Confirmed against
 * the real wire payload, 2026-05-30 — the `@@`-only parser silently returned ""
 * on every change, forcing a full-page re-scrape fallback.)
 *
 * Returns "" when the diff adds nothing (e.g. a pure deletion, or an empty diff).
 */
export function addedContentFromDiff(diffText: string): string {
  if (!diffText) return "";
  const lines = diffText.split("\n");
  // Hunkless diffs (Firecrawl's live format) have no `@@` anchor and no file
  // headers, so the whole body is the hunk — start collecting immediately.
  let inHunk = !lines.some((line) => line.startsWith("@@"));
  const added: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    // Skip the file-header block / preamble before the first hunk; only inside a
    // hunk does a leading `+` reliably mean "added line" (vs. a `+++` header).
    if (inHunk && line.startsWith("+")) added.push(line.slice(1));
  }
  return added.join("\n").trim();
}
