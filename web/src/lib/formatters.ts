export {
  sourceToMarkdown,
  orgToMarkdown,
  releaseToMarkdown,
  productToMarkdown,
  overviewToMarkdown,
  knowledgeToMarkdown,
  collectionToMarkdown,
  collectionReleaseFeedToMarkdown,
  categoryReleaseFeedToMarkdown,
  collectionDigestIndexToMarkdown,
  collectionDigestToMarkdown,
} from "@releases/rendering/formatters";

export type {
  FormatSourceDetail,
  FormatOrgDetail,
  FormatOptions,
} from "@releases/rendering/formatters";

/**
 * Pluralize the word "release" for a count (e.g. "1 release", "3 releases").
 */
export function pluralReleases(n: number): string {
  return n === 1 ? "release" : "releases";
}

/**
 * Format an ISO date string to a human-readable date.
 * Always uses UTC to avoid timezone-related display issues
 * (e.g., dates appearing in the future for western timezone viewers).
 */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Format an ISO date as short month + year (e.g. "Sep 2024"), UTC. Returns null
 * for missing/unparseable input so callers can omit the line entirely.
 */
export function formatMonthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Format an ISO date as a relative time string (e.g., "2d ago", "3mo ago") */
export function formatRelativeDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();
  if (diffMs < 0) return "just now";

  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}
