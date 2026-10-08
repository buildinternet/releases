/**
 * Derive the effective fetch method (`github` / `feed` / `ai` / `-`) from a
 * source's type and discovered metadata. Shared by the source list views
 * (`list.ts`) and the single-source inspector (`source-show.ts`) so the two
 * agree on what a source actually fetches with — they previously kept private
 * copies that had already drifted on the no-method sentinel.
 *
 * Returns `"-"` when no method can be inferred; callers dim/relabel that
 * sentinel as they see fit.
 */
export function getFetchMethod(type: string, meta: Record<string, unknown> | null): string {
  if (type === "github") return "github";
  if (type === "feed") return "feed";
  if (meta?.feedUrl) return "feed";
  if (meta?.noFeedFound) return "ai";
  return "-";
}
