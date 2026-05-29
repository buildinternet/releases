/**
 * Reduce a Firecrawl `monitor.page` `diff.text` (a git-style unified diff) to
 * just the *added* content: lines prefixed `+`, with the prefix stripped and
 * file/hunk headers, context lines, and removed lines dropped.
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
 * shape, so the text format is the safer thing to depend on.
 *
 * Returns "" when the diff adds nothing (e.g. a pure deletion, or an empty diff).
 */
export function addedContentFromDiff(diffText: string): string {
  if (!diffText) return "";
  const added: string[] = [];
  for (const line of diffText.split("\n")) {
    // `+++`/`---` are file headers, `@@` is a hunk header — never content.
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    // A single leading `+` marks an added line; everything after it is content.
    if (line.startsWith("+")) added.push(line.slice(1));
  }
  return added.join("\n").trim();
}
