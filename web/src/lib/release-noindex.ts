/** Minimal shape needed to decide indexability — a structural subset of the
 *  release-detail payload (api.release). */
export interface NoIndexInput {
  content?: string | null;
  summary?: string | null;
  sourceIsHidden?: boolean | null;
  org?: { isHidden?: boolean | null; discovery?: string | null } | null;
}

/** True when the /release/{id} page should emit `robots: noindex`. Combines the
 *  existing hidden/on-demand rules with the #1606 thin-content rule: a release
 *  with no body AND no summary is a thin stub that should stay out of the index
 *  (follow:true keeps internal links crawlable). */
export function shouldNoIndexRelease(release: NoIndexInput): boolean {
  if (release.sourceIsHidden === true) return true;
  if (release.org?.isHidden === true) return true;
  if (release.org?.discovery === "on_demand") return true;
  const hasBody = (release.content ?? "").trim().length > 0;
  const hasSummary = (release.summary ?? "").trim().length > 0;
  return !hasBody && !hasSummary;
}
