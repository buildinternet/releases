/**
 * Pure display helpers for release rows — used by the shared CLI renderer
 * (search + latest) and the slim JSON projectors. No I/O, no chalk.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Compact relative age: `now`, `5m`, `3h`, `2d`, `3w`, `3mo`, `2y`. Empty for null/unparseable. */
export function relativeDate(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, now - t);
  if (d < MINUTE) return "now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < WEEK) return `${Math.floor(d / DAY)}d`;
  if (d < MONTH) return `${Math.floor(d / WEEK)}w`;
  if (d < YEAR) return `${Math.floor(d / MONTH)}mo`;
  return `${Math.floor(d / YEAR)}y`;
}

/** Human-readable absolute date: `Jul 22, 2024`. Empty for null/unparseable.
 *  Formatted in UTC (locale pinned to en-US) so it's deterministic and reflects
 *  the calendar day of the stored ISO regardless of the runner's timezone. */
export function humanDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Strip markdown to plain text, collapse whitespace, truncate to maxChars with an ellipsis. */
export function cleanExcerpt(md: string | null | undefined, maxChars = 280): string {
  if (!md) return "";
  const text = md
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1") // bold/italic
    .replace(/^\s*[-*+]\s+/gm, "") // list bullets
    .replace(/^\s*>\s?/gm, "") // blockquotes
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1).trimEnd() + "…";
}

export interface ReleaseRow {
  id: string;
  title: string;
  version: string | null;
  summary: string | null;
  titleGenerated?: string | null;
  titleShort?: string | null;
  content?: string | null;
  publishedAt: string | null;
  sourceName: string;
  sourceSlug: string;
  /** Owning org's display name. When present, the identity column is rendered
   *  as `Org/Source` so cross-vendor surfaces (search) make clear who ships the
   *  release. Left unset by single-context feeds (entity cards, scoped `tail`)
   *  where the org is already established in the surrounding output. */
  orgName?: string | null;
  orgSlug?: string | null;
  /** Owning product, when the release's source is grouped under one. Populated
   *  on feed rows (#1217). Drives the product-identity column the org card uses
   *  to name *which product* shipped each release rather than the raw source. */
  product?: { slug: string; name: string } | null;
  /** AI-scored importance 1–5. `null`/`undefined` means unscored — never treat
   *  it as "unimportant". Absent on search hits (the wire shape doesn't carry
   *  it yet); see {@link importanceMarker}. */
  importance?: number | null;
}

/**
 * Identity column. A package-qualified version (contains `@` or `/`) wins —
 * `next@15.0.0` is a more precise handle than any name. Otherwise the source
 * name, prefixed with the owning org as `Org/Source` when `orgName` is supplied
 * (the caller's opt-in for cross-vendor surfaces). The org prefix is skipped
 * when the source name already starts with the org name, so a source literally
 * named "Resend Changelog" under org "Resend" stays "Resend Changelog" rather
 * than doubling up to "Resend/Resend Changelog".
 */
export function releaseIdentity(
  row: Pick<ReleaseRow, "version" | "sourceName" | "orgName">,
): string {
  const v = row.version?.trim();
  if (v && /[@/]/.test(v)) return v;
  const source = row.sourceName;
  const org = row.orgName?.trim();
  if (org && !source.toLowerCase().startsWith(org.toLowerCase())) {
    return `${org}/${source}`;
  }
  return source;
}

/**
 * Product-identity column: the owning product's name, falling back to the
 * source name (then blank) when a release has no product. Used by the org card,
 * where naming *which product* shipped each release is more useful than the
 * individual source — multi-product orgs (Vercel → Next.js, Turborepo) get a
 * meaningful grouping column instead of repeating source names.
 */
export function releaseProductIdentity(row: Pick<ReleaseRow, "product" | "sourceName">): string {
  return row.product?.name?.trim() || row.sourceName || "";
}

/**
 * Description column: titleShort → titleGenerated → title → summary → cleaned
 * content excerpt. Always cleaned.
 *
 * The title family ranks above the summary on purpose. Feed surfaces frequently
 * serve a raw content excerpt in the `summary` field when a release has no
 * curated AI summary yet (e.g. "New Anthropic Labs product that lets you
 * collaborate…"), which buries the far more useful title ("Claude Design by
 * Anthropic Labs"). An AI headline (titleShort/titleGenerated) is preferred
 * over the raw title when present; summary/content remain fallbacks for
 * titleless rows.
 */
export function releaseDescription(row: ReleaseRow): string {
  const candidates = [row.titleShort, row.titleGenerated, row.title, row.summary, row.content];
  for (const c of candidates) {
    const cleaned = cleanExcerpt(c);
    if (cleaned) return cleaned;
  }
  return row.title || "";
}

/**
 * Marker glyph for a high-importance release, mirroring the web's ≥4
 * threshold (outline at 4, solid at 5): scores 1–3 render nothing, and so
 * does `null`/`undefined` — unscored means "unknown", never "unimportant".
 * Deliberately quiet (a single Unicode glyph, no emoji, no `Importance: n/5`
 * label) so an unscored or routine feed doesn't get noisier.
 */
export function importanceMarker(importance: number | null | undefined): string {
  if (importance == null) return "";
  if (importance >= 5) return "◆";
  if (importance === 4) return "◇";
  return "";
}
