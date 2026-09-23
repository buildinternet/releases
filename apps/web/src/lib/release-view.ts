import type { ReleaseItem, OrgReleaseItem, CollectionReleaseItem } from "@/lib/api";

/**
 * A release augmented with its body markdown pre-rendered to an HTML string.
 *
 * Feed/timeline rows show only a short excerpt (`releaseExcerpt`, capped at
 * {@link EXCERPT_MAX_CHARS}), but rendering even that with `react-markdown` +
 * shiki on the client dragged those libraries into the bundle of every
 * content-heavy list route. We now render the excerpt to HTML on the server
 * (initial page render + the pagination route handlers) and inject it via
 * `dangerouslySetInnerHTML`, so the heavy markdown pipeline stays server-side.
 *
 * `bodyHtml` is intentionally OPTIONAL so a plain wire-typed release stays
 * assignable to the view type (keeps `buildFeedEntries` and friends
 * backward-compatible); every production path fills it in, and consumers treat
 * an absent/empty value as "no notes". Rendered by
 * `@/lib/render-release-body` (server-only).
 */
export type WithBodyHtml<T> = T & { bodyHtml?: string };

export type ReleaseItemView = WithBodyHtml<ReleaseItem>;
export type OrgReleaseItemView = WithBodyHtml<OrgReleaseItem>;

/**
 * Collection/category timeline row with its EXCERPT pre-rendered to `bodyHtml`
 * (the "collapsed" variant — images stripped, matching `collapsedMarkdownComponents`)
 * and the raw `content`/`summary` fields OMITTED (#1918) — the full verbatim
 * body and raw AI summary never need to reach this timeline's client JSON, so
 * they're stripped at the web boundary rather than merely left unrendered.
 * `collection-timeline`'s "Show more" lazily fetches the full body from
 * `/api/release-body/[id]` (server-rendered) instead, keeping the verbatim body
 * out of crawlable HTML (#1606) and shiki/react-markdown out of the client
 * bundle. In place of the raw fields, three precomputed signals ride along:
 * - `hasMore` — whether the full body differs from the excerpt; gates
 *   `PostHero`/`PostVersionRow`'s "Show more" button.
 * - `hasBody` — whether the release has any body at all (presence, not
 *   "exceeds excerpt"); gates `CommitLogRow`'s expand toggle.
 * - `summaryText` — the plain-text AI summary for `CommitLogRow`'s
 *   always-visible inline preview line (rendered as plain text, never HTML).
 * Built by `withCollectionReleaseView` in `@/lib/render-release-body`.
 */
export type CollectionReleaseItemView = Omit<CollectionReleaseItem, "content" | "summary"> & {
  bodyHtml?: string;
  hasMore?: boolean;
  hasBody?: boolean;
  summaryText?: string;
};
