import "server-only";
import type { MediaItem } from "@buildinternet/releases-api-types";
import type { Notice } from "@buildinternet/releases-core/notice";
import type { SourceType, SourceDiscovery } from "@buildinternet/releases-core/source-enums";
import type { ReleaseType } from "@buildinternet/releases-core/schema";
import type { SourceDetailQuery, ProductDetailQuery } from "./__generated__/graphql";

/**
 * Web-side shapes for GraphQL-sourced source/product detail. Deliberately
 * narrower than the REST `SourceDetail` / `ProductDetail` api-types (which
 * carry admin-facing aggregate stats — `releaseCount`, `avgReleasesPerWeek`,
 * `stars`, … — that none of the source-page views read; see AGENTS.md /
 * #1978 slice 3). Every field here is actually consumed by
 * `web/src/app/[orgSlug]/[slug]` or `web/src/app/sources/[id]`.
 */

export type MappedRelease = {
  id: string;
  title: string;
  version: string | null;
  type: ReleaseType;
  url: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  titleGenerated: string | null;
  titleShort: string | null;
  content: string;
  summary: string;
  media: MediaItem[];
};

export type MappedSourceDetail = {
  id: string;
  slug: string;
  name: string;
  type: SourceType;
  url: string;
  productId: string | null;
  isHidden: boolean;
  discovery: SourceDiscovery;
  metadata: string;
  changelogUrl: string | null;
  hasChangelogFile: boolean;
  lastFetchedAt: string | null;
  lastPolledAt: string | null;
  trackingSince: string;
  latestVersion: string | null;
  latestDate: string | null;
  notice: Notice | null;
  summaries: {
    rolling: {
      year?: number | null;
      month?: number | null;
      windowDays?: number | null;
      summary: string;
      releaseCount: number;
      generatedAt: string;
    } | null;
    monthly: Array<{
      year?: number | null;
      month?: number | null;
      windowDays?: number | null;
      summary: string;
      releaseCount: number;
      generatedAt: string;
    }>;
  };
  org: { id: string; slug: string; name: string } | null;
  releases: MappedRelease[];
  pagination: { nextCursor: string | null; limit: number };
};

export type MappedProductSource = {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string;
  metadata: string | null;
  isHidden: boolean;
};

export type MappedProductDetail = {
  id: string;
  slug: string;
  name: string;
  url: string | null;
  description: string | null;
  category: string | null;
  tags: string[];
  notice: Notice | null;
  sources: MappedProductSource[];
};

function mapRelease(
  r: NonNullable<SourceDetailQuery["source"]>["releases"][number],
): MappedRelease {
  return {
    id: r.id,
    title: r.title,
    version: r.version,
    type: r.type,
    url: r.url,
    publishedAt: r.publishedAt,
    fetchedAt: r.fetchedAt,
    titleGenerated: r.titleGenerated,
    titleShort: r.titleShort,
    content: r.content,
    // ReleaseItemSchema.summary is required on the wire; GraphQL's is
    // nullable (most rows are unpopulated). Fall back to an empty string —
    // consumers already treat empty summary as "render from content".
    summary: r.summary ?? "",
    media: r.media.map((m) => ({
      type: m.type,
      url: m.url,
      alt: m.alt ?? undefined,
      r2Url: m.r2Url ?? undefined,
    })),
  };
}

/**
 * Builds the plain-text `publishedAt|fetchedAt|id` feed cursor consumed by
 * `/api/source-releases/[orgSlug]/[sourceSlug]` (the client-side "load more"
 * route, which stays on REST — see PR description). Mirrors
 * `buildFeedCursor` in packages/core-internal/src/feed-cursor.ts; duplicated
 * here (rather than imported) because that package is worker-only and not
 * safe to pull into the Next.js server bundle.
 */
function buildCursor(last: { publishedAt: string | null; fetchedAt: string; id: string }): string {
  return `${last.publishedAt ?? ""}|${last.fetchedAt}|${last.id}`;
}

/**
 * Maps a `SourceDetail` GraphQL response to the shape the source-page views
 * expect, deriving `pagination.nextCursor` from an overfetch-by-one on
 * `releases(limit)` — the same limit+1 trick the REST handler uses, without
 * a second query. Loader-level ordering ties `(publishedAt, id)` only (REST's
 * cursor ties `(publishedAt, fetchedAt, id)`); rows sharing an exact
 * `publishedAt` could theoretically reorder across the GraphQL→REST
 * pagination boundary. Documented, low-probability tradeoff — see PR
 * description.
 */
export function mapSourceDetail(
  source: NonNullable<SourceDetailQuery["source"]>,
  requestedLimit: number,
): MappedSourceDetail {
  const hasMore = source.releases.length > requestedLimit;
  const pageRows = hasMore ? source.releases.slice(0, requestedLimit) : source.releases;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? buildCursor(last) : null;

  return {
    id: source.id,
    slug: source.slug,
    name: source.name,
    type: source.type,
    url: source.url,
    productId: source.productId,
    isHidden: source.isHidden,
    // `Source.discovery` is a plain `String!` on the wire (not a GraphQL
    // enum — see workers/api/src/graphql/types/enums.ts's comment on why only
    // `Org.discovery` is typed today); narrow to the known value set here,
    // same as REST's `SourceDiscoverySchema`.
    discovery: source.discovery as SourceDiscovery,
    metadata: source.metadata,
    changelogUrl: source.changelogUrl,
    hasChangelogFile: source.hasChangelogFile,
    lastFetchedAt: source.lastFetchedAt,
    lastPolledAt: source.lastPolledAt,
    trackingSince: source.trackingSince,
    latestVersion: source.latestVersion,
    latestDate: source.latestDate,
    notice: source.notice
      ? {
          message: source.notice.message,
          linkText: source.notice.linkText ?? undefined,
          coordinate: source.notice.coordinate ?? undefined,
          href: source.notice.href ?? undefined,
        }
      : null,
    summaries: {
      rolling: source.summaries.rolling,
      monthly: source.summaries.monthly,
    },
    org: source.org,
    releases: pageRows.map(mapRelease),
    pagination: { nextCursor, limit: requestedLimit },
  };
}

export function mapProductDetail(
  product: NonNullable<ProductDetailQuery["product"]>,
): MappedProductDetail {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    url: product.url,
    description: product.description,
    category: product.category,
    tags: product.tags,
    notice: product.notice
      ? {
          message: product.notice.message,
          linkText: product.notice.linkText ?? undefined,
          coordinate: product.notice.coordinate ?? undefined,
          href: product.notice.href ?? undefined,
        }
      : null,
    sources: product.sources.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      type: s.type,
      url: s.url,
      metadata: s.metadata,
      isHidden: s.isHidden,
    })),
  };
}
