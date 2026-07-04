import type { ReleaseItem, OrgReleaseItem } from "@/lib/api";

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
