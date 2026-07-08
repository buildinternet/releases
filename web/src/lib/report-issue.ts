/** Entity the user is viewing — embedded into the feedback message body. */
export type ReportContext = {
  kind: "org" | "product" | "source" | "release";
  name: string;
  /** Typed id (`rel_…`, `src_…`, …) when known. */
  id?: string;
  /** Public slug when that's the primary handle. */
  slug?: string;
  /** Canonical site path, e.g. `/anthropic`. */
  path: string;
};

/** Prefix the free-text note with enough context for operators to jump back. */
export function buildReportMessage(
  note: string,
  ctx: ReportContext,
  pageUrl: string | null,
): string {
  const ref = ctx.id || ctx.slug;
  const about = ref ? `${ctx.kind} "${ctx.name}" (${ref})` : `${ctx.kind} "${ctx.name}"`;
  return [`About: ${about}`, `Page: ${pageUrl ?? ctx.path}`, "", note.trim()].join("\n");
}
