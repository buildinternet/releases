import "server-only";
import type { MediaItem, SourceDetail } from "@buildinternet/releases-api-types";
import type { Notice } from "@buildinternet/releases-core/notice";
import type { SourceType, SourceDiscovery } from "@buildinternet/releases-core/source-enums";
import type { ReleaseType } from "@buildinternet/releases-core/schema";
import { api, ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { SourceDetailDocument } from "./__generated__/graphql";
import type { SourceDetailQuery, ProductPageQuery } from "./__generated__/graphql";
import { buildRestFeedCursor, mapMediaItems } from "./map-feed";

const DEFAULT_RELEASE_LIMIT = 20;

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

function mapNotice(
  notice:
    | {
        message: string;
        linkText?: string | null;
        coordinate?: string | null;
        href?: string | null;
      }
    | null
    | undefined,
): Notice | null {
  return notice
    ? {
        message: notice.message,
        linkText: notice.linkText ?? undefined,
        coordinate: notice.coordinate ?? undefined,
        href: notice.href ?? undefined,
      }
    : null;
}

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
    media: mapMediaItems(r.media),
  };
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
  const nextCursor = hasMore && last ? buildRestFeedCursor(last) : null;

  return {
    id: source.id,
    slug: source.slug,
    name: source.name,
    type: source.type,
    url: source.url,
    productId: source.productId,
    isHidden: source.isHidden ?? false,
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
    notice: mapNotice(source.notice),
    summaries: {
      rolling: source.summaries.rolling,
      monthly: source.summaries.monthly,
    },
    org: source.org,
    releases: pageRows.map(mapRelease),
    pagination: { nextCursor, limit: requestedLimit },
  };
}

/**
 * Map REST `SourceDetail` onto the narrower `MappedSourceDetail` shape the
 * source-page views consume. Pure helper so unit tests can cover the mapping
 * without spinning GraphQL.
 */
export function mapSourceDetailFromRest(detail: SourceDetail): MappedSourceDetail {
  return {
    id: detail.id,
    slug: detail.slug,
    name: detail.name,
    type: detail.type,
    url: detail.url,
    productId: detail.productId,
    isHidden: detail.isHidden,
    discovery: (detail.discovery ?? "curated") as SourceDiscovery,
    metadata: detail.metadata,
    changelogUrl: detail.changelogUrl ?? null,
    hasChangelogFile: detail.hasChangelogFile ?? false,
    lastFetchedAt: detail.lastFetchedAt,
    lastPolledAt: detail.lastPolledAt,
    trackingSince: detail.trackingSince,
    latestVersion: detail.latestVersion,
    latestDate: detail.latestDate,
    notice: mapNotice(detail.notice),
    summaries: {
      rolling: detail.summaries.rolling,
      monthly: detail.summaries.monthly,
    },
    org: detail.org,
    releases: detail.releases.map((r) => ({
      // Source detail feed always includes release ids on current workers;
      // empty string is a last-resort degrade for mid-deploy older payloads.
      id: r.id ?? "",
      title: r.title,
      version: r.version,
      type: (r.type ?? "feature") as ReleaseType,
      url: r.url,
      publishedAt: r.publishedAt,
      fetchedAt: r.fetchedAt ?? "",
      titleGenerated: r.titleGenerated ?? null,
      titleShort: r.titleShort ?? null,
      content: r.content ?? "",
      summary: r.summary ?? "",
      media: r.media ?? [],
    })),
    pagination: {
      nextCursor: detail.pagination?.nextCursor ?? null,
      limit: detail.pagination?.limit ?? DEFAULT_RELEASE_LIMIT,
    },
  };
}

/**
 * Fetches + maps a `SourceDetail` by id — shared by `/sources/:id` (id known
 * up front) and the org-scoped `[orgSlug]/[slug]` source route (id resolved
 * via REST `getResolved` first). Overfetches `releases` by one so
 * `mapSourceDetail` can derive `pagination.nextCursor` without a second query.
 *
 * Falls back to REST `GET /v1/sources/:id` when GraphQL fails (#2056).
 */
export async function fetchSourceDetail(
  id: string,
  notFoundMessage: string,
): Promise<MappedSourceDetail> {
  try {
    return await fetchSourceDetailGraphql(id, notFoundMessage);
  } catch (err) {
    if (err instanceof ApiNotFoundError) throw err;
    console.warn(
      JSON.stringify({
        component: "web-ssr",
        event: "source-detail-graphql-fallback",
        route: `/sources/${id}`,
        sourceId: id,
        err: {
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
        },
      }),
    );
    return fetchSourceDetailRest(id, notFoundMessage);
  }
}

async function fetchSourceDetailGraphql(
  id: string,
  notFoundMessage: string,
): Promise<MappedSourceDetail> {
  const data = await graphqlRequest(SourceDetailDocument, {
    id,
    releaseLimit: DEFAULT_RELEASE_LIMIT + 1,
  });
  if (!data.source) {
    throw new ApiNotFoundError(notFoundMessage);
  }
  return mapSourceDetail(data.source, DEFAULT_RELEASE_LIMIT);
}

async function fetchSourceDetailRest(
  id: string,
  notFoundMessage: string,
): Promise<MappedSourceDetail> {
  try {
    const detail = await api.sourceById(id, { limit: DEFAULT_RELEASE_LIMIT });
    return mapSourceDetailFromRest(detail);
  } catch (err) {
    if (err instanceof ApiNotFoundError) {
      throw new ApiNotFoundError(notFoundMessage);
    }
    throw err;
  }
}

export function mapProductDetail(
  product: NonNullable<ProductPageQuery["product"]>,
): MappedProductDetail {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    url: product.url,
    description: product.description,
    category: product.category,
    tags: product.tags,
    notice: mapNotice(product.notice),
    sources: product.sources.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      type: s.type,
      url: s.url,
      metadata: s.metadata,
      isHidden: s.isHidden ?? false,
    })),
  };
}
