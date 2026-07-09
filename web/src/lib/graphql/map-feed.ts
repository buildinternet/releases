import type {
  CollectionListItem,
  MediaItem,
  OrgReleaseItem,
} from "@buildinternet/releases-api-types";

/** GraphQL Media → REST MediaItem (null → undefined for optional fields). */
export function mapMediaItems(
  media: Array<{ type: string; url: string; alt?: string | null; r2Url?: string | null }>,
): MediaItem[] {
  return media.map((m) => ({
    type: m.type as MediaItem["type"],
    url: m.url,
    alt: m.alt ?? undefined,
    r2Url: m.r2Url ?? undefined,
  }));
}

/**
 * Shared shape of `latestReleases.items[]` fields used by OrgReleases and
 * ProductPage — both map onto OrgReleaseItem for OrgReleaseList.
 */
export type GqlOrgFeedRelease = {
  id: string;
  version: string | null;
  title: string;
  summary: string | null;
  content: string;
  publishedAt: string | null;
  fetchedAt: string;
  url: string | null;
  media: Array<{ type: string; url: string; alt?: string | null; r2Url?: string | null }>;
  type: string;
  prerelease?: boolean | null;
  titleGenerated: string | null;
  titleShort: string | null;
  breaking?: string | null;
  source: {
    slug: string;
    name: string;
    type: string;
    appStore?: { platform: string; iconUrl?: string | null } | null;
    video?: { provider: string } | null;
    product?: { slug: string; name: string } | null;
  };
};

/** Map a GraphQL org/product feed release onto OrgReleaseItem. */
export function mapOrgReleaseItem(r: GqlOrgFeedRelease): OrgReleaseItem {
  return {
    id: r.id,
    version: r.version,
    title: r.title,
    summary: r.summary ?? "",
    content: r.content,
    publishedAt: r.publishedAt,
    fetchedAt: r.fetchedAt,
    url: r.url,
    media: mapMediaItems(r.media),
    type: r.type as OrgReleaseItem["type"],
    prerelease: r.prerelease ?? undefined,
    titleGenerated: r.titleGenerated,
    titleShort: r.titleShort,
    breaking: (r.breaking as OrgReleaseItem["breaking"]) ?? undefined,
    source: {
      slug: r.source.slug,
      name: r.source.name,
      type: r.source.type,
      appStore: (r.source.appStore as OrgReleaseItem["source"]["appStore"]) ?? undefined,
      video: (r.source.video as OrgReleaseItem["source"]["video"]) ?? undefined,
    },
    product: r.source.product ?? null,
  };
}

/**
 * REST-compatible feed cursor (`publishedAt|fetchedAt|id`) for client-side
 * load-more that stays on REST after GraphQL SSR. Mirrors worker
 * `buildFeedCursor` (core-internal is worker-only — keep a local copy).
 */
export function buildRestFeedCursor(last: {
  publishedAt: string | null;
  fetchedAt: string;
  id: string;
}): string {
  return `${last.publishedAt ?? ""}|${last.fetchedAt}|${last.id}`;
}

/** Sidebar-shaped collection row (no preview members). */
export function mapCollectionListItem(c: {
  slug: string;
  name: string;
  description: string | null;
  memberCount: number;
  isFeatured: boolean;
}): CollectionListItem {
  return {
    slug: c.slug,
    name: c.name,
    description: c.description,
    memberCount: c.memberCount,
    isFeatured: c.isFeatured,
  };
}
