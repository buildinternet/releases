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
 * shape, so the text format is the safer thing to depend on. Assumes a
 * single-file diff (true for the scrape-target monitors that feed this).
 *
 * Returns "" when the diff adds nothing (e.g. a pure deletion, or an empty diff).
 */
export function addedContentFromDiff(diffText: string): string {
  if (!diffText) return "";
  const added: string[] = [];
  let inHunk = false;
  for (const line of diffText.split("\n")) {
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
